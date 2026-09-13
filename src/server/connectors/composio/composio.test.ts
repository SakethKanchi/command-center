import type {
  Connector,
  ConnectorAdapterContext,
  ConnectorConfig,
  ConnectorRecord,
  OpportunityRow,
} from "@domain";
import type { RepoBundle } from "@server/repos";
import type { ConnectorsRepo } from "@server/repos/connectors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { gmailSendAdapter } from "../gmail-send";
import { googleSheetsAdapter } from "../sheets";
import { hashRow, renderRow, SHEET_TABS } from "../sheets/layout";
import {
  COMPOSIO_API_BASE,
  clearComposioAuthConfigCache,
  createComposioClient,
} from "./client";
import {
  disconnectProvider,
  ensureComposioSpreadsheet,
  linkProvider,
  sendViaComposio,
  syncProviderStatus,
  upsertNotionPage,
} from "./service";
import { COMPOSIO_ACCOUNT_KEY } from "./state";

const TEST_BASE = "https://composio.test/api/v3.1";
const API_KEY = "ck_test_key";

type StubResponseInit = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

function stubResponse(init: StubResponseInit = {}): Response {
  const status = init.status ?? 200;
  const headers = init.headers ?? {};
  const bodyText =
    init.body === undefined
      ? ""
      : typeof init.body === "string"
        ? init.body
        : JSON.stringify(init.body);

  // Stub seam: the Composio client reads ok/status/headers.get/text(), and
  // the direct Notion path reads json().
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        headers[name] ?? headers[name.toLowerCase()] ?? null,
    },
    text: async () => bodyText,
    json: async () => (bodyText === "" ? null : JSON.parse(bodyText)),
  } as unknown as Response;
}

type Call = { method: string; url: string; body: unknown };

/** Queued responses, consumed in order, with every request recorded. */
function createFetchStub(responses: Response[]) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: typeof raw === "string" ? JSON.parse(raw) : null,
    });
    const next = queue.shift();
    if (!next) throw new Error(`No queued response for ${url}`);
    return next;
  });
  return { fetchImpl, calls };
}

const toolArgumentsSchema = z.object({
  arguments: z.object({
    range: z.string().optional(),
    values: z.array(z.array(z.string())).optional(),
  }),
});

/** The `arguments` block of a recorded tool execution, typed for assertions. */
function bodyArguments(body: unknown) {
  return toolArgumentsSchema.parse(body).arguments;
}

function client(responses: Response[], apiKey: string | null = API_KEY) {
  const stub = createFetchStub(responses);
  return {
    ...stub,
    composio: createComposioClient({
      apiKey,
      baseUrl: TEST_BASE,
      fetchImpl: stub.fetchImpl,
      userId: "primary",
    }),
  };
}

// ---------------------------------------------------------------------------
// In-memory connectors repo: only the handful of methods the service touches.
// ---------------------------------------------------------------------------

function createRepos(seed: Connector[] = []): RepoBundle {
  const rows = new Map<string, Connector>();
  for (const row of seed) rows.set(`${row.provider}:${row.accountKey}`, row);

  const connectors: Partial<ConnectorsRepo> = {
    getByProvider: (provider, accountKey = COMPOSIO_ACCOUNT_KEY) =>
      rows.get(`${provider}:${accountKey}`) ?? null,
    list: () => [...rows.values()],
    upsertConnected: (input) => {
      const accountKey = input.accountKey ?? COMPOSIO_ACCOUNT_KEY;
      const key = `${input.provider}:${accountKey}`;
      const now = new Date().toISOString();
      const next: Connector = {
        id: `connector-${input.provider}`,
        provider: input.provider,
        accountKey,
        displayName: input.displayName ?? null,
        status: "connected",
        credentials: input.credentials ?? rows.get(key)?.credentials ?? null,
        config: input.config ?? rows.get(key)?.config ?? null,
        lastConnectedAt: now,
        lastSyncedAt: rows.get(key)?.lastSyncedAt ?? null,
        lastError: null,
        createdAt: rows.get(key)?.createdAt ?? now,
        updatedAt: now,
      };
      rows.set(key, next);
      return next;
    },
    updateState: (input) => {
      for (const [key, row] of rows) {
        if (row.id !== input.id) continue;
        const next: Connector = {
          ...row,
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.config === undefined ? {} : { config: input.config }),
          ...(input.credentials === undefined
            ? {}
            : { credentials: input.credentials }),
          ...(input.lastError === undefined
            ? {}
            : { lastError: input.lastError }),
          ...(input.lastConnectedAt === undefined
            ? {}
            : { lastConnectedAt: input.lastConnectedAt }),
        };
        rows.set(key, next);
        return next;
      }
      return null;
    },
    disconnect: (id) => {
      for (const [key, row] of rows) {
        if (row.id !== id) continue;
        const next: Connector = {
          ...row,
          status: "disconnected",
          credentials: null,
          lastError: null,
        };
        rows.set(key, next);
        return next;
      }
      return null;
    },
  };

  return { connectors: connectors as ConnectorsRepo } as unknown as RepoBundle;
}

function connectorRow(overrides: Partial<Connector> = {}): Connector {
  return {
    id: "connector-seed",
    provider: "gmail_send",
    accountKey: COMPOSIO_ACCOUNT_KEY,
    displayName: null,
    status: "disconnected",
    credentials: null,
    config: null,
    lastConnectedAt: null,
    lastSyncedAt: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const AUTH_CONFIG = { id: "ac_123", toolkit_slug: "gmail", name: "Gmail" };

beforeEach(() => {
  clearComposioAuthConfigCache();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("composio client: auth configs", () => {
  it("reuses an existing auth config instead of creating another", async () => {
    const { composio, calls } = client([
      stubResponse({ body: { items: [AUTH_CONFIG] } }),
    ]);

    expect(await composio.ensureAuthConfig("gmail")).toBe("ac_123");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");

    // Second connect performs no round trip at all: the id is cached, and
    // `ensureAuthConfig` runs on every single connect.
    expect(await composio.ensureAuthConfig("gmail")).toBe("ac_123");
    expect(calls).toHaveLength(1);
  });

  it("creates a Composio-managed auth config when the toolkit has none", async () => {
    const { composio, calls } = client([
      stubResponse({ body: { items: [] } }),
      stubResponse({
        status: 201,
        body: { id: "ac_new", toolkit_slug: "notion" },
      }),
    ]);

    expect(await composio.ensureAuthConfig("notion")).toBe("ac_new");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      method: "POST",
      body: {
        toolkit: { slug: "notion" },
        auth_config: { type: "use_composio_managed_auth" },
      },
    });
  });
});

describe("composio client: connect link", () => {
  it("returns the redirect url and an ISO expiry", async () => {
    const { composio } = client([
      stubResponse({
        status: 201,
        body: {
          link_token: "lt_1",
          redirect_url: "https://backend.composio.dev/s/abc123",
          expires_at: 1_800_000_000,
          connected_account_id: "ca_1",
        },
      }),
    ]);

    const link = await composio.createLink({ authConfigId: "ac_123" });

    expect(link.redirectUrl).toBe("https://backend.composio.dev/s/abc123");
    expect(link.connectedAccountId).toBe("ca_1");
    expect(link.expiresAt).toBe(new Date(1_800_000_000_000).toISOString());
    expect(Number.isNaN(Date.parse(link.expiresAt))).toBe(false);
  });

  it("still hands the caller a deadline when Composio omits one", async () => {
    const { composio } = client([
      stubResponse({
        status: 201,
        body: {
          redirect_url: "https://backend.composio.dev/s/def456",
          connected_account_id: "ca_2",
        },
      }),
    ]);

    const link = await composio.createLink({ authConfigId: "ac_123" });
    expect(Date.parse(link.expiresAt)).toBeGreaterThan(Date.now());
  });
});

describe("composio client: tool execution", () => {
  it("treats a 200 carrying successful:false as a failure and quotes Composio", async () => {
    const { composio } = client([
      stubResponse({
        body: {
          successful: false,
          error: "No tool found with slug NOTION_CREATE_NOTION_PAGE",
          data: {},
        },
      }),
    ]);

    await expect(
      composio.executeTool("NOTION_CREATE_NOTION_PAGE", { arguments: {} }),
    ).rejects.toThrow(/No tool found with slug NOTION_CREATE_NOTION_PAGE/);
  });

  it("fails on a non-null error even when successful is absent", async () => {
    const { composio } = client([
      stubResponse({ body: { data: {}, error: "Recipient address required" } }),
    ]);

    await expect(
      composio.executeTool("GMAIL_SEND_EMAIL", { arguments: {} }),
    ).rejects.toThrow(/Recipient address required/);
  });

  it("passes an explicit toolkit version, which v3.1 requires", async () => {
    const { composio, calls } = client([
      stubResponse({
        body: { successful: true, error: null, data: { id: "m1" } },
      }),
    ]);

    await composio.executeTool("GMAIL_SEND_EMAIL", {
      arguments: { recipient_email: "a@b.com" },
    });

    expect(calls[0]?.body).toMatchObject({
      user_id: "primary",
      version: "latest",
      arguments: { recipient_email: "a@b.com" },
    });
  });
});

describe("composio client: retry policy", () => {
  it("retries a 429 and then succeeds", async () => {
    const { composio, fetchImpl } = client([
      stubResponse({ status: 429, headers: { "retry-after": "0" } }),
      stubResponse({ body: { items: [AUTH_CONFIG] } }),
    ]);

    expect(await composio.listAuthConfigs("gmail")).toEqual([
      { id: "ac_123", toolkitSlug: "gmail", name: "Gmail" },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never retries a 400: re-issuing a rejected write is worse than failing", async () => {
    const { composio, fetchImpl } = client([
      stubResponse({
        status: 400,
        body: { error: { message: "auth_config_id is required", status: 400 } },
      }),
    ]);

    await expect(composio.createLink({ authConfigId: "" })).rejects.toThrow(
      /auth_config_id is required/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("composio client: api key", () => {
  it("says which variable to set instead of surfacing a bare 401", async () => {
    const { composio, fetchImpl } = client([
      stubResponse({
        status: 401,
        body: {
          error: {
            message: "Invalid API key: ck_**blFZ",
            code: 801,
            slug: "APIKey_InvalidAPIKey",
            status: 401,
          },
        },
      }),
    ]);

    await expect(composio.listAuthConfigs("gmail")).rejects.toThrow(
      /COMPOSIO_API_KEY is missing or invalid.*Invalid API key: ck_\*\*blFZ/s,
    );
    // Not retried: 401 is neither 429 nor 5xx.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails before any request when no key is configured", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "");
    const { composio, fetchImpl } = client([], null);

    await expect(composio.listAuthConfigs("gmail")).rejects.toThrow(
      /COMPOSIO_API_KEY is missing or invalid/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the key as x-api-key against the v3.1 base", () => {
    const stub = createFetchStub([]);
    const real = createComposioClient({
      apiKey: API_KEY,
      fetchImpl: stub.fetchImpl,
    });
    expect(real.baseUrl).toBe(COMPOSIO_API_BASE);
  });
});

describe("linkProvider", () => {
  it("persists the pending account without marking the connector connected", async () => {
    const repos = createRepos();
    const stub = createFetchStub([
      stubResponse({ body: { items: [AUTH_CONFIG] } }),
      stubResponse({
        status: 201,
        body: {
          redirect_url: "https://backend.composio.dev/s/xyz",
          expires_at: "2026-09-13T12:00:00.000Z",
          connected_account_id: "ca_9",
        },
      }),
    ]);

    const ticket = await linkProvider("gmail_send", {
      repos,
      client: createComposioClient({
        apiKey: API_KEY,
        baseUrl: TEST_BASE,
        fetchImpl: stub.fetchImpl,
      }),
    });

    expect(ticket).toEqual({
      redirectUrl: "https://backend.composio.dev/s/xyz",
      expiresAt: "2026-09-13T12:00:00.000Z",
      connectedAccountId: "ca_9",
    });

    const row = repos.connectors.getByProvider("gmail_send");
    expect(row?.status).toBe("disconnected");
    expect(row?.config).toMatchObject({
      composio: { connectedAccountId: "ca_9", linkState: "pending" },
    });
  });

  it("links google_sheets through the googlesheets toolkit", async () => {
    // The connector used to refuse this, on the theory that Sheets needed a
    // raw OAuth token Composio would not hand back. It does not: it writes
    // rows with GOOGLESHEETS_VALUES_UPDATE, so the link is real.
    const repos = createRepos();
    const stub = createFetchStub([
      stubResponse({ body: { items: [] } }),
      stubResponse({
        status: 201,
        body: { id: "ac_sheets", toolkit_slug: "googlesheets" },
      }),
      stubResponse({
        status: 201,
        body: {
          redirect_url: "https://backend.composio.dev/s/sheets",
          connected_account_id: "ca_sheets",
        },
      }),
    ]);

    const ticket = await linkProvider("google_sheets", {
      repos,
      client: createComposioClient({
        apiKey: API_KEY,
        baseUrl: TEST_BASE,
        fetchImpl: stub.fetchImpl,
      }),
    });

    expect(ticket.redirectUrl).toBe("https://backend.composio.dev/s/sheets");
    expect(stub.calls[0]?.url).toContain("toolkit_slug=googlesheets");
    expect(stub.calls[1]?.body).toMatchObject({
      toolkit: { slug: "googlesheets" },
    });
    expect(
      repos.connectors.getByProvider("google_sheets")?.config,
    ).toMatchObject({
      composio: { connectedAccountId: "ca_sheets", linkState: "pending" },
    });
  });
});

describe("syncProviderStatus", () => {
  it("reports pending while the user is still on the consent screen", async () => {
    const repos = createRepos([
      connectorRow({
        provider: "notion",
        config: {
          composio: { connectedAccountId: "ca_5", linkState: "pending" },
        },
      }),
    ]);
    const stub = createFetchStub([
      stubResponse({ body: { id: "ca_5", status: "INITIATED" } }),
    ]);

    const health = await syncProviderStatus("notion", {
      repos,
      client: createComposioClient({
        apiKey: API_KEY,
        baseUrl: TEST_BASE,
        fetchImpl: stub.fetchImpl,
      }),
    });

    expect(health).toMatchObject({
      provider: "notion",
      connected: false,
      status: "disconnected",
      linkState: "pending",
      authMode: "composio",
    });
  });

  it("flips to connected once Composio reports the account ACTIVE", async () => {
    const repos = createRepos([
      connectorRow({
        provider: "notion",
        config: {
          composio: { connectedAccountId: "ca_5", linkState: "pending" },
        },
      }),
    ]);
    const stub = createFetchStub([
      stubResponse({
        body: { id: "ca_5", status: "ACTIVE", user_id: "primary" },
      }),
    ]);

    const health = await syncProviderStatus("notion", {
      repos,
      client: createComposioClient({
        apiKey: API_KEY,
        baseUrl: TEST_BASE,
        fetchImpl: stub.fetchImpl,
      }),
    });

    expect(health).toMatchObject({
      connected: true,
      status: "connected",
      linkState: "active",
      target: "primary",
    });
    expect(repos.connectors.getByProvider("notion")?.status).toBe("connected");
  });

  it("surfaces Composio's reason when the link failed", async () => {
    const repos = createRepos([
      connectorRow({
        provider: "notion",
        config: { composio: { connectedAccountId: "ca_5" } },
      }),
    ]);
    const stub = createFetchStub([
      stubResponse({
        body: {
          id: "ca_5",
          status: "FAILED",
          status_reason: "User denied access to the workspace",
        },
      }),
    ]);

    const health = await syncProviderStatus("notion", {
      repos,
      client: createComposioClient({
        apiKey: API_KEY,
        baseUrl: TEST_BASE,
        fetchImpl: stub.fetchImpl,
      }),
    });

    expect(health.status).toBe("error");
    expect(health.linkState).toBe("failed");
    expect(health.lastError).toBe("User denied access to the workspace");
  });
});

describe("disconnectProvider", () => {
  it("revokes the grant and mutates no Gmail or Notion data", async () => {
    const repos = createRepos([
      connectorRow({
        provider: "gmail_send",
        status: "connected",
        config: {
          composio: { connectedAccountId: "ca_7", linkState: "active" },
        },
      }),
    ]);
    const stub = createFetchStub([stubResponse({ status: 204 })]);

    const health = await disconnectProvider("gmail_send", {
      repos,
      client: createComposioClient({
        apiKey: API_KEY,
        baseUrl: TEST_BASE,
        fetchImpl: stub.fetchImpl,
      }),
    });

    expect(health).toMatchObject({
      connected: false,
      status: "disconnected",
      linkState: "none",
      connectedAccountId: null,
    });
    expect(repos.connectors.getByProvider("gmail_send")?.status).toBe(
      "disconnected",
    );

    // The only outbound call is the grant delete. No tool execution means no
    // message, page or row of the user's can have been touched.
    expect(stub.calls).toEqual([
      {
        method: "DELETE",
        url: `${TEST_BASE}/connected_accounts/ca_7`,
        body: null,
      },
    ]);
  });

  it("survives a Composio outage: the connector is still locally disconnected", async () => {
    const repos = createRepos([
      connectorRow({
        provider: "gmail_send",
        status: "connected",
        config: { composio: { connectedAccountId: "ca_7" } },
      }),
    ]);
    const stub = createFetchStub([
      stubResponse({ status: 500 }),
      stubResponse({ status: 500 }),
      stubResponse({ status: 500 }),
    ]);

    const health = await disconnectProvider("gmail_send", {
      repos,
      client: createComposioClient({
        apiKey: API_KEY,
        baseUrl: TEST_BASE,
        fetchImpl: stub.fetchImpl,
      }),
    });

    expect(health.connected).toBe(false);
    expect(
      repos.connectors.getByProvider("gmail_send")?.credentials,
    ).toBeNull();
  });
});

describe("transport precedence", () => {
  const directCredentials = {
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshToken: "refresh-token",
    accessToken: "access-token",
    accessTokenExpiresAt: Date.now() + 3_600_000,
  };

  function gmailContext(
    credentials: Record<string, unknown> | null,
    fetchImpl: typeof fetch,
  ): ConnectorAdapterContext {
    return {
      connector: connectorRow({
        provider: "gmail_send",
        accountKey: "me@example.com",
        credentials,
        config: {
          fromAddress: "me@example.com",
          composio: { connectedAccountId: "ca_3", linkState: "active" },
        },
      }),
      fetchImpl,
    };
  }

  it("uses the direct transport when both direct credentials and a Composio key exist", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", API_KEY);
    const stub = createFetchStub([
      stubResponse({ body: { id: "gmail-direct-1", threadId: "t1" } }),
    ]);

    const result = await gmailSendAdapter.send(
      gmailContext(directCredentials, stub.fetchImpl),
      { to: "recruiter@example.com", subject: "Hi", body: "Hello" },
    );

    expect(result.messageId).toBe("gmail-direct-1");
    // Google's endpoint, not Composio's: direct wins whenever it is configured.
    expect(stub.calls[0]?.url).toContain(
      "gmail.googleapis.com/gmail/v1/users/me/messages/send",
    );
    expect(stub.calls.some((call) => call.url.includes("composio"))).toBe(
      false,
    );
  });

  it("falls back to Composio tool execution when direct credentials are absent", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", API_KEY);
    const stub = createFetchStub([
      stubResponse({
        body: {
          successful: true,
          error: null,
          data: { id: "m_9", threadId: "t_9" },
        },
      }),
    ]);

    const result = await gmailSendAdapter.send(
      gmailContext(null, stub.fetchImpl),
      { to: "recruiter@example.com", subject: "Hi", body: "Hello" },
    );

    expect(result.messageId).toBe("m_9");
    expect(stub.calls[0]?.url).toBe(
      `${COMPOSIO_API_BASE}/tools/execute/GMAIL_SEND_EMAIL`,
    );
    expect(stub.calls[0]?.body).toMatchObject({
      arguments: {
        recipient_email: "recruiter@example.com",
        subject: "Hi",
        body: "Hello",
      },
    });
  });

  it("names both setup paths when neither transport is configured", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "");
    const stub = createFetchStub([]);

    await expect(
      gmailSendAdapter.send(gmailContext(null, stub.fetchImpl), {
        to: "recruiter@example.com",
        subject: "Hi",
        body: "Hello",
      }),
    ).rejects.toThrow(/npm run connect google.*COMPOSIO_API_KEY/s);
    expect(stub.fetchImpl).not.toHaveBeenCalled();
  });

  it("routes a Notion page write directly when the connector holds a token", async () => {
    const repos = createRepos([
      connectorRow({
        provider: "notion",
        credentials: { accessToken: "ntn_secret" },
        config: { composio: { connectedAccountId: "ca_4" } },
      }),
    ]);
    const stub = createFetchStub([
      stubResponse({
        body: { id: "page-1", url: "https://www.notion.so/page-1" },
      }),
    ]);

    const page = await upsertNotionPage(
      { parentId: "db-1", title: "Staff Engineer @ Acme" },
      { repos, fetchImpl: stub.fetchImpl, apiKey: API_KEY },
    );

    expect(page).toEqual({
      id: "page-1",
      url: "https://www.notion.so/page-1",
      outcome: "created",
    });
    expect(stub.calls[0]?.url).toBe("https://api.notion.com/v1/pages");
  });

  it("routes a Notion page write through Composio when there is no token", async () => {
    const repos = createRepos([
      connectorRow({
        provider: "notion",
        config: {
          composio: { connectedAccountId: "ca_4", linkState: "active" },
        },
      }),
    ]);
    const stub = createFetchStub([
      stubResponse({
        body: { successful: true, error: null, data: { id: "page-2" } },
      }),
    ]);

    const page = await upsertNotionPage(
      { parentId: "db-1", title: "Staff Engineer @ Acme" },
      {
        repos,
        client: createComposioClient({
          apiKey: API_KEY,
          baseUrl: TEST_BASE,
          fetchImpl: stub.fetchImpl,
        }),
      },
    );

    expect(page.id).toBe("page-2");
    expect(stub.calls[0]?.url).toBe(
      `${TEST_BASE}/tools/execute/NOTION_CREATE_NOTION_PAGE`,
    );
  });
});

// ---------------------------------------------------------------------------
// Google Sheets over Composio
//
// The Sheets adapter needs no repos, only a connector row and a fetch, so
// these drive `googleSheetsAdapter.push` directly. Nothing here touches the
// network: every response is queued.
// ---------------------------------------------------------------------------

describe("google sheets transport selection", () => {
  const SHEETS_CREDENTIALS = {
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshToken: "refresh-token",
    accessToken: "access-token",
    accessTokenExpiresAt: Date.now() + 3_600_000,
  };

  function opportunity(
    overrides: Partial<OpportunityRow> = {},
  ): OpportunityRow {
    return {
      kind: "opportunity",
      key: "job-1",
      jobId: "1",
      company: "Acme",
      role: "Staff Engineer",
      location: "London, UK",
      source: "greenhouse",
      jobUrl: "https://jobs.example.com/1",
      salary: null,
      score: 88,
      scoreReason: "Strong platform match",
      sponsorScore: 72,
      isRemote: true,
      datePosted: "2026-09-01T00:00:00.000Z",
      discoveredAt: "2026-09-10T08:00:00.000Z",
      status: "sourced",
      ...overrides,
    };
  }

  function sheetsContext(
    args: {
      credentials?: Record<string, unknown> | null;
      config?: ConnectorConfig | null;
    },
    fetchImpl: typeof fetch,
  ): ConnectorAdapterContext {
    return {
      connector: connectorRow({
        provider: "google_sheets",
        credentials: args.credentials ?? null,
        config: args.config ?? {
          spreadsheetId: "sheet-abc",
          composio: { connectedAccountId: "ca_sheets", linkState: "active" },
        },
      }),
      fetchImpl,
    };
  }

  function ledger(
    entries: Array<{ row: OpportunityRow; remoteId: string; hash?: string }>,
  ): Map<string, ConnectorRecord> {
    return new Map(
      entries.map((entry) => [
        `opportunity:${entry.row.key}`,
        {
          id: `rec-${entry.row.key}`,
          connectorId: "connector-seed",
          provider: "google_sheets" as const,
          entityKind: "opportunity" as const,
          entityId: entry.row.key,
          remoteId: entry.remoteId,
          remoteUrl: null,
          contentHash: entry.hash ?? hashRow(entry.row),
          lastPushedAt: "2026-09-12T00:00:00.000Z",
        },
      ]),
    );
  }

  /** A tool-execution 200 that Composio considers a success. */
  function toolOk(data: unknown = {}): Response {
    return stubResponse({ body: { successful: true, error: null, data } });
  }

  it("writes through Google when the row holds credentials, key or no key", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", API_KEY);
    const stub = createFetchStub([
      // Spreadsheet metadata, then the column-A read, then the append: the
      // direct sequence, unchanged by the transport seam.
      stubResponse({
        body: {
          spreadsheetId: "sheet-abc",
          properties: { title: "Job Search Command Center" },
          sheets: [{ properties: { sheetId: 11, title: "Opportunities" } }],
        },
      }),
      stubResponse({ body: { range: "Opportunities!A:A", values: [["Key"]] } }),
      stubResponse({
        body: { updates: { updatedRange: "Opportunities!A2:O2" } },
      }),
    ]);

    const report = await googleSheetsAdapter.push(
      sheetsContext({ credentials: SHEETS_CREDENTIALS }, stub.fetchImpl),
      { rows: [opportunity()], known: new Map() },
    );

    expect(report.results).toEqual([
      {
        entityKind: "opportunity",
        entityId: "job-1",
        outcome: "created",
        remoteId: "Opportunities!A2",
        remoteUrl:
          "https://docs.google.com/spreadsheets/d/sheet-abc#gid=11&range=A2",
      },
    ]);
    expect(
      stub.calls.every((call) => call.url.includes("googleapis.com")),
    ).toBe(true);
  });

  it("falls back to Composio tool execution when the row holds no credentials", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", API_KEY);
    const stub = createFetchStub([
      toolOk({ sheetNames: ["Opportunities"] }),
      toolOk({ updatedRange: "Opportunities!A1:O2" }),
    ]);

    const report = await googleSheetsAdapter.push(
      sheetsContext({ credentials: null }, stub.fetchImpl),
      { rows: [opportunity()], known: new Map() },
    );

    expect(stub.calls.map((call) => call.url)).toEqual([
      `${COMPOSIO_API_BASE}/tools/execute/GOOGLESHEETS_GET_SHEET_NAMES`,
      `${COMPOSIO_API_BASE}/tools/execute/GOOGLESHEETS_VALUES_UPDATE`,
    ]);
    expect(stub.calls[1]?.body).toMatchObject({
      version: "latest",
      connected_account_id: "ca_sheets",
      arguments: {
        spreadsheet_id: "sheet-abc",
        range: "Opportunities!A1:O2",
        value_input_option: "RAW",
        major_dimension: "ROWS",
      },
    });
    // Headers come from the same column table the direct path renders from,
    // so the two transports cannot drift into different column orders.
    expect(bodyArguments(stub.calls[1]?.body).values).toEqual([
      SHEET_TABS.opportunity.headers,
      renderRow(opportunity()),
    ]);
    expect(report.results).toEqual([
      {
        entityKind: "opportunity",
        entityId: "job-1",
        outcome: "created",
        remoteId: "Opportunities!A2",
        remoteUrl: "https://docs.google.com/spreadsheets/d/sheet-abc#range=A2",
      },
    ]);
  });

  it("names both routes when neither transport is configured", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "");
    const stub = createFetchStub([]);

    await expect(
      googleSheetsAdapter.push(
        sheetsContext({ credentials: null }, stub.fetchImpl),
        { rows: [opportunity()], known: new Map() },
      ),
    ).rejects.toThrow(/npm run connect google.*COMPOSIO_API_KEY/s);
    expect(stub.fetchImpl).not.toHaveBeenCalled();
  });

  it("creates a missing tab before writing it", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", API_KEY);
    const stub = createFetchStub([
      toolOk({ sheetNames: ["Sheet1"] }),
      toolOk({ replies: [] }),
      toolOk({}),
    ]);

    await googleSheetsAdapter.push(
      sheetsContext({ credentials: null }, stub.fetchImpl),
      { rows: [opportunity()], known: new Map() },
    );

    expect(stub.calls[1]?.url).toBe(
      `${COMPOSIO_API_BASE}/tools/execute/GOOGLESHEETS_ADD_SHEET`,
    );
    expect(stub.calls[1]?.body).toMatchObject({
      arguments: {
        spreadsheet_id: "sheet-abc",
        title: "Opportunities",
        force_unique: false,
      },
    });
  });

  it("blanks the rows a shrunken lane used to occupy", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", API_KEY);
    const stub = createFetchStub([
      toolOk({ sheetNames: ["Opportunities"] }),
      toolOk({}),
    ]);
    const survivor = opportunity({ key: "job-1", status: "applied" });

    // The sheet holds four rows from earlier syncs (rows 2..5); this push
    // carries one. Without the blanks, rows 3-5 would keep showing
    // opportunities that are gone.
    await googleSheetsAdapter.push(
      sheetsContext({ credentials: null }, stub.fetchImpl),
      {
        rows: [survivor],
        known: ledger([
          { row: survivor, remoteId: "Opportunities!A2", hash: "stale" },
          {
            row: opportunity({ key: "job-2" }),
            remoteId: "Opportunities!A5",
          },
        ]),
      },
    );

    const values = bodyArguments(stub.calls[1]?.body).values;
    const blank = SHEET_TABS.opportunity.headers.map(() => "");
    expect(values).toEqual([
      SHEET_TABS.opportunity.headers,
      renderRow(survivor),
      blank,
      blank,
      blank,
    ]);
    expect(bodyArguments(stub.calls[1]?.body).range).toBe(
      "Opportunities!A1:O5",
    );
  });

  it("writes nothing when the ledger says the tab is unchanged", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", API_KEY);
    const stub = createFetchStub([toolOk({ sheetNames: ["Opportunities"] })]);
    const row = opportunity();

    const report = await googleSheetsAdapter.push(
      sheetsContext({ credentials: null }, stub.fetchImpl),
      {
        rows: [row],
        known: ledger([{ row, remoteId: "Opportunities!A2" }]),
      },
    );

    // Only the tab listing went out: a re-sync of an unchanged lane must not
    // rewrite it, which is what makes the whole-tab replace safe to repeat.
    expect(stub.calls).toHaveLength(1);
    expect(report.results).toEqual([
      {
        entityKind: "opportunity",
        entityId: "job-1",
        outcome: "unchanged",
        remoteId: "Opportunities!A2",
        remoteUrl: null,
      },
    ]);
  });

  it("treats a 200 carrying successful:false as a failed write", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", API_KEY);
    const stub = createFetchStub([
      toolOk({ sheetNames: ["Opportunities"] }),
      stubResponse({
        body: {
          successful: false,
          error: "Invalid value at 'value_input_option'",
          data: {},
        },
      }),
    ]);

    const report = await googleSheetsAdapter.push(
      sheetsContext({ credentials: null }, stub.fetchImpl),
      { rows: [opportunity()], known: new Map() },
    );

    // HTTP 200 with successful:false is a failure, and the message has to
    // carry both the tool and the field so one reading says what to fix.
    expect(report.results).toHaveLength(0);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.errorMessage).toContain(
      "GOOGLESHEETS_VALUES_UPDATE",
    );
    expect(report.failures[0]?.errorMessage).toContain("value_input_option");
    expect(report.failures[0]?.errorMessage).toContain(
      "sheetsValuesUpdateArguments",
    );
  });

  it("aborts the push on an invalid key instead of failing every lane", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", API_KEY);
    const stub = createFetchStub([
      stubResponse({
        status: 401,
        body: {
          error: {
            message: "Invalid API key: ck_**blFZ",
            slug: "APIKey_InvalidAPIKey",
            status: 401,
          },
        },
      }),
    ]);

    await expect(
      googleSheetsAdapter.push(
        sheetsContext({ credentials: null }, stub.fetchImpl),
        { rows: [opportunity()], known: new Map() },
      ),
    ).rejects.toThrow(/COMPOSIO_API_KEY is missing or invalid/);
  });

  it("refuses to write before a spreadsheet has been resolved", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", API_KEY);
    const stub = createFetchStub([]);

    await expect(
      googleSheetsAdapter.push(
        sheetsContext(
          {
            credentials: null,
            config: {
              composio: {
                connectedAccountId: "ca_sheets",
                linkState: "active",
              },
            },
          },
          stub.fetchImpl,
        ),
        { rows: [opportunity()], known: new Map() },
      ),
    ).rejects.toThrow(/ensureComposioSpreadsheet/);
    expect(stub.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("ensureComposioSpreadsheet", () => {
  it("creates one spreadsheet and stores its id where the direct path reads it", async () => {
    const repos = createRepos([
      connectorRow({
        provider: "google_sheets",
        config: {
          composio: { connectedAccountId: "ca_sheets", linkState: "active" },
        },
      }),
    ]);
    const stub = createFetchStub([
      stubResponse({
        body: {
          successful: true,
          error: null,
          data: { spreadsheetId: "sheet-new" },
        },
      }),
    ]);
    const deps = {
      repos,
      client: createComposioClient({
        apiKey: API_KEY,
        baseUrl: TEST_BASE,
        fetchImpl: stub.fetchImpl,
      }),
    };

    expect(await ensureComposioSpreadsheet(deps)).toEqual({
      spreadsheetId: "sheet-new",
      created: true,
    });
    expect(stub.calls[0]?.url).toBe(
      `${TEST_BASE}/tools/execute/GOOGLESHEETS_CREATE_GOOGLE_SHEET1`,
    );
    expect(stub.calls[0]?.body).toMatchObject({
      arguments: { title: "Job Search Command Center" },
    });

    const row = repos.connectors.getByProvider("google_sheets");
    // `spreadsheetId` is the key `sheetsConfigSchema` reads, and the Composio
    // block survives beside it.
    expect(row?.config).toMatchObject({
      spreadsheetId: "sheet-new",
      composio: { connectedAccountId: "ca_sheets" },
    });

    // Second call is free: linking twice must not leave two spreadsheets.
    expect(await ensureComposioSpreadsheet(deps)).toEqual({
      spreadsheetId: "sheet-new",
      created: false,
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("reuses the spreadsheet a direct connection already created", async () => {
    const repos = createRepos([
      connectorRow({
        provider: "google_sheets",
        config: { spreadsheetId: "sheet-from-direct" },
      }),
    ]);
    const stub = createFetchStub([]);

    expect(
      await ensureComposioSpreadsheet({
        repos,
        client: createComposioClient({
          apiKey: API_KEY,
          baseUrl: TEST_BASE,
          fetchImpl: stub.fetchImpl,
        }),
      }),
    ).toEqual({ spreadsheetId: "sheet-from-direct", created: false });
    expect(stub.fetchImpl).not.toHaveBeenCalled();
  });

  it("fails loudly when the create answers without an id", async () => {
    const stub = createFetchStub([
      stubResponse({
        body: { successful: true, error: null, data: { ok: true } },
      }),
    ]);

    await expect(
      ensureComposioSpreadsheet({
        repos: createRepos([connectorRow({ provider: "google_sheets" })]),
        client: createComposioClient({
          apiKey: API_KEY,
          baseUrl: TEST_BASE,
          fetchImpl: stub.fetchImpl,
        }),
      }),
    ).rejects.toThrow(
      /GOOGLESHEETS_CREATE_GOOGLE_SHEET1 answered without a spreadsheet id/,
    );
  });
});

describe("sendViaComposio", () => {
  it("refuses attachments rather than silently dropping a résumé", async () => {
    const repos = createRepos([
      connectorRow({
        provider: "gmail_send",
        config: {
          composio: { connectedAccountId: "ca_1", linkState: "active" },
        },
      }),
    ]);
    const stub = createFetchStub([]);

    await expect(
      sendViaComposio(
        {
          to: "a@b.com",
          subject: "Application",
          body: "Hello",
          attachments: [
            {
              filename: "cv.pdf",
              mimeType: "application/pdf",
              path: "/tmp/cv.pdf",
            },
          ],
        },
        {
          repos,
          client: createComposioClient({
            apiKey: API_KEY,
            baseUrl: TEST_BASE,
            fetchImpl: stub.fetchImpl,
          }),
        },
      ),
    ).rejects.toThrow(/npm run connect google/);
    expect(stub.fetchImpl).not.toHaveBeenCalled();
  });

  it("forwards the connected account so Composio sends as the linked mailbox", async () => {
    const repos = createRepos([
      connectorRow({
        provider: "gmail_send",
        config: {
          composio: { connectedAccountId: "ca_1", linkState: "active" },
        },
      }),
    ]);
    const stub = createFetchStub([
      stubResponse({
        body: { successful: true, error: null, data: { id: "m_1" } },
      }),
    ]);

    const result = await sendViaComposio(
      { to: " a@b.com ", subject: "Application", body: "Hello" },
      {
        repos,
        client: createComposioClient({
          apiKey: API_KEY,
          baseUrl: TEST_BASE,
          fetchImpl: stub.fetchImpl,
        }),
      },
    );

    expect(result.to).toBe("a@b.com");
    expect(result.webUrl).toBe("https://mail.google.com/mail/u/0/#all/m_1");
    expect(stub.calls[0]?.body).toMatchObject({ connected_account_id: "ca_1" });
  });
});
