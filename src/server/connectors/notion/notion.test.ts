import type {
  ApplicationRow,
  Connector,
  ConnectorAdapterContext,
  ConnectorConfig,
  ConnectorCredentials,
  ConnectorEntityKind,
  ConnectorRecord,
  FollowUpRow,
  OpportunityRow,
} from "@domain";
import { describe, expect, it } from "vitest";
import { notionAdapter } from "./index";
import { hashRow, toNotionProperties } from "./properties";

type StubCall = {
  /** Path below `/v1`, e.g. `search` or `databases/db-opp/query`. */
  path: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
};

const NOTION_PREFIX = "https://api.notion.com/v1/";

function jsonResponse(
  body: unknown,
  args?: { status?: number; headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(body), {
    status: args?.status ?? 200,
    headers: { "content-type": "application/json", ...(args?.headers ?? {}) },
  });
}

function createFetchStub(handler: (call: StubCall) => Response): {
  fetchImpl: typeof fetch;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    expect(url.startsWith(NOTION_PREFIX)).toBe(true);
    const rawBody = init?.body;
    const call: StubCall = {
      path: url.slice(NOTION_PREFIX.length),
      method: init?.method ?? "GET",
      body: typeof rawBody === "string" ? JSON.parse(rawBody) : null,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

function createContext(args: {
  fetchImpl: typeof fetch;
  credentials?: ConnectorCredentials | null;
  config?: ConnectorConfig | null;
}): ConnectorAdapterContext {
  const connector: Connector = {
    id: "connector-1",
    provider: "notion",
    accountKey: "default",
    displayName: "Notion",
    status: "connected",
    credentials:
      args.credentials === undefined
        ? { accessToken: "secret_test" }
        : args.credentials,
    config: args.config ?? {},
    lastConnectedAt: null,
    lastSyncedAt: "2023-11-14T22:13:20.000Z",
    lastError: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
  return { connector, fetchImpl: args.fetchImpl };
}

const ALL_DATABASE_IDS = {
  opportunity: "db-opp",
  application: "db-app",
  interview: "db-int",
  follow_up: "db-fu",
};

const DATABASE_TITLES: Record<string, string> = {
  "db-opp": "Opportunities",
  "db-app": "Applications",
  "db-int": "Interviews",
  "db-fu": "Follow-ups",
};

const OPPORTUNITY: OpportunityRow = {
  kind: "opportunity",
  key: "job-1",
  jobId: "1",
  company: "Acme",
  role: "Platform Engineer",
  location: "London",
  source: "linkedin",
  jobUrl: "https://acme.example/jobs/1",
  salary: "£80k-£95k",
  score: 87,
  scoreReason: "Kubernetes plus Go, sponsors visas",
  sponsorScore: 62,
  isRemote: true,
  datePosted: "2026-09-01",
  discoveredAt: "2026-09-10T12:00:00.000Z",
  status: "new",
};

const APPLICATION: ApplicationRow = {
  kind: "application",
  key: "app-1",
  jobId: "1",
  company: "Acme",
  role: "Platform Engineer",
  stage: "applied",
  outcome: null,
  appliedAt: "2026-09-11T09:30:00.000Z",
  resumePath: "/resumes/acme.pdf",
  resumeViews: 3,
  lastResumeViewAt: null,
  jobUrl: "https://acme.example/jobs/1",
  score: 87,
};

const FOLLOW_UP: FollowUpRow = {
  kind: "follow_up",
  key: "fu-1",
  jobId: "1",
  company: "Acme",
  role: "Platform Engineer",
  taskId: "task-1",
  title: "Nudge the recruiter",
  dueDate: null,
  isCompleted: false,
  reason: null,
};

function opportunity(overrides: Partial<OpportunityRow>): OpportunityRow {
  return { ...OPPORTUNITY, ...overrides };
}

function ledgerRecord(args: {
  entityKind: ConnectorEntityKind;
  entityId: string;
  contentHash: string;
  remoteId?: string;
  remoteUrl?: string | null;
}): ConnectorRecord {
  return {
    id: `record-${args.entityId}`,
    connectorId: "connector-1",
    provider: "notion",
    entityKind: args.entityKind,
    entityId: args.entityId,
    remoteId: args.remoteId ?? "page-1",
    remoteUrl: args.remoteUrl ?? "https://www.notion.so/page1",
    contentHash: args.contentHash,
    lastPushedAt: "2023-11-14T22:13:20.000Z",
  };
}

function retrieveDatabaseResponse(id: string): Response {
  return jsonResponse({
    id,
    url: `https://www.notion.so/${id}`,
    title: [{ plain_text: DATABASE_TITLES[id] ?? id }],
  });
}

describe("notionAdapter.connect", () => {
  it("adopts the database ids supplied in config without creating anything", async () => {
    const { fetchImpl, calls } = createFetchStub((call) => {
      if (call.path === "search") {
        return jsonResponse({ results: [], has_more: false });
      }
      if (call.method === "GET" && call.path.startsWith("databases/")) {
        return retrieveDatabaseResponse(call.path.slice("databases/".length));
      }
      throw new Error(`unexpected ${call.method} ${call.path}`);
    });

    const health = await notionAdapter.connect(
      createContext({ fetchImpl, config: { databaseIds: ALL_DATABASE_IDS } }),
    );

    expect(health).toMatchObject({
      provider: "notion",
      accountKey: "default",
      connected: true,
      status: "connected",
      target: "Opportunities, Applications, Interviews, Follow-ups",
      destinationUrl: "https://www.notion.so/db-opp",
      lastError: null,
    });
    expect(
      calls.filter(
        (call) => call.method === "POST" && call.path === "databases",
      ),
    ).toHaveLength(0);
    expect(
      calls.every(
        (call) =>
          call.headers.authorization === "Bearer secret_test" &&
          call.headers["notion-version"] === "2022-06-28" &&
          call.headers["content-type"] === "application/json",
      ),
    ).toBe(true);
  });

  it("creates the missing lane databases under the configured parent page", async () => {
    let created = 0;
    const { fetchImpl, calls } = createFetchStub((call) => {
      if (call.path === "search") {
        return jsonResponse({
          results: [
            {
              object: "database",
              id: "db-app",
              url: "https://www.notion.so/db-app",
              title: [{ plain_text: "Applications" }],
            },
          ],
          has_more: false,
        });
      }
      if (call.method === "POST" && call.path === "databases") {
        created += 1;
        return jsonResponse({
          id: `db-created-${created}`,
          url: `https://www.notion.so/db-created-${created}`,
        });
      }
      throw new Error(`unexpected ${call.method} ${call.path}`);
    });

    const health = await notionAdapter.connect(
      createContext({ fetchImpl, config: { parentPageId: "page-1" } }),
    );

    const createCalls = calls.filter(
      (call) => call.method === "POST" && call.path === "databases",
    );
    expect(createCalls.map((call) => call.body)).toMatchObject([
      {
        parent: { type: "page_id", page_id: "page-1" },
        title: [{ text: { content: "Opportunities" } }],
        properties: { Key: { title: {} }, Score: { number: {} } },
      },
      { title: [{ text: { content: "Interviews" } }] },
      { title: [{ text: { content: "Follow-ups" } }] },
    ]);
    // The adopted "Applications" database is never recreated.
    expect(health.connected).toBe(true);
    expect(health.target).toBe(
      "Opportunities, Applications, Interviews, Follow-ups",
    );
  });

  it("refuses to provision when neither a database id nor a parent page exists", async () => {
    const { fetchImpl, calls } = createFetchStub((call) => {
      if (call.path === "search") {
        return jsonResponse({ results: [], has_more: false });
      }
      throw new Error(`unexpected ${call.method} ${call.path}`);
    });

    await expect(
      notionAdapter.connect(createContext({ fetchImpl, config: {} })),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("config.parentPageId"),
    });
    expect(calls.filter((call) => call.path === "databases")).toHaveLength(0);
  });
});

describe("notionAdapter.status", () => {
  it("reports the resolved databases without provisioning", async () => {
    const { fetchImpl, calls } = createFetchStub((call) => {
      if (call.path === "search") {
        return jsonResponse({ results: [], has_more: false });
      }
      if (call.method === "GET" && call.path.startsWith("databases/")) {
        return retrieveDatabaseResponse(call.path.slice("databases/".length));
      }
      throw new Error(`unexpected ${call.method} ${call.path}`);
    });

    const health = await notionAdapter.status(
      createContext({ fetchImpl, config: { databaseIds: ALL_DATABASE_IDS } }),
    );

    expect(health.connected).toBe(true);
    expect(health.status).toBe("connected");
    expect(health.destinationUrl).toBe("https://www.notion.so/db-opp");
    expect(
      calls.filter(
        (call) => call.method === "POST" && call.path === "databases",
      ),
    ).toHaveLength(0);
  });

  it("degrades instead of throwing when the token is rejected", async () => {
    const { fetchImpl } = createFetchStub(() =>
      jsonResponse(
        { code: "unauthorized", message: "API token is invalid." },
        { status: 401 },
      ),
    );

    const health = await notionAdapter.status(
      createContext({ fetchImpl, config: { databaseIds: ALL_DATABASE_IDS } }),
    );

    expect(health.connected).toBe(false);
    expect(health.status).toBe("error");
    expect(health.lastError).toContain("unauthorized");
  });

  it("reports disconnected when credentials are absent", async () => {
    const { fetchImpl, calls } = createFetchStub(() => {
      throw new Error("status must not call Notion without credentials");
    });

    const health = await notionAdapter.status(
      createContext({ fetchImpl, credentials: null }),
    );

    expect(health.connected).toBe(false);
    expect(health.status).toBe("disconnected");
    expect(health.lastError).toContain("accessToken");
    expect(calls).toHaveLength(0);
  });
});

describe("notionAdapter.push", () => {
  it("performs no write when the known hash still matches", async () => {
    const { fetchImpl, calls } = createFetchStub(() => {
      throw new Error("an unchanged push must not touch Notion");
    });
    const known = new Map<string, ConnectorRecord>([
      [
        "opportunity:job-1",
        ledgerRecord({
          entityKind: "opportunity",
          entityId: "job-1",
          contentHash: hashRow(OPPORTUNITY),
        }),
      ],
    ]);

    const report = await notionAdapter.push(
      createContext({ fetchImpl, config: { databaseIds: ALL_DATABASE_IDS } }),
      { rows: [OPPORTUNITY], known },
    );

    expect(calls).toHaveLength(0);
    expect(report.results).toEqual([
      {
        entityKind: "opportunity",
        entityId: "job-1",
        outcome: "unchanged",
        remoteId: "page-1",
        remoteUrl: "https://www.notion.so/page1",
      },
    ]);
    expect(report.failures).toEqual([]);
    // No request happened, so the link is derived from the id (dashes gone).
    expect(report.destinationUrl).toBe("https://www.notion.so/dbopp");
  });

  it("updates a key that resolves to a page and creates one that does not", async () => {
    const { fetchImpl, calls } = createFetchStub((call) => {
      if (call.path === "databases/db-opp/query") {
        return jsonResponse({
          results: [
            {
              id: "page-1",
              url: "https://www.notion.so/page1",
              properties: { Key: { title: [{ plain_text: "job-1" }] } },
            },
          ],
          has_more: false,
        });
      }
      if (call.method === "PATCH" && call.path === "pages/page-1") {
        return jsonResponse({
          id: "page-1",
          url: "https://www.notion.so/page1",
        });
      }
      if (call.method === "POST" && call.path === "pages") {
        return jsonResponse({
          id: "page-2",
          url: "https://www.notion.so/page2",
        });
      }
      throw new Error(`unexpected ${call.method} ${call.path}`);
    });

    const report = await notionAdapter.push(
      createContext({ fetchImpl, config: { databaseIds: ALL_DATABASE_IDS } }),
      {
        rows: [OPPORTUNITY, opportunity({ key: "job-2", jobId: "2" })],
        known: new Map(),
      },
    );

    expect(report.results).toEqual([
      {
        entityKind: "opportunity",
        entityId: "job-1",
        outcome: "updated",
        remoteId: "page-1",
        remoteUrl: "https://www.notion.so/page1",
      },
      {
        entityKind: "opportunity",
        entityId: "job-2",
        outcome: "created",
        remoteId: "page-2",
        remoteUrl: "https://www.notion.so/page2",
      },
    ]);
    expect(report.failures).toEqual([]);

    // Both keys are looked up in a single filtered query, not one per row.
    const queries = calls.filter((call) => call.path.endsWith("/query"));
    expect(queries).toHaveLength(1);
    expect(queries[0]?.body).toMatchObject({
      filter: {
        or: [
          { property: "Key", title: { equals: "job-1" } },
          { property: "Key", title: { equals: "job-2" } },
        ],
      },
    });
    expect(
      calls.find((call) => call.method === "POST" && call.path === "pages")
        ?.body,
    ).toMatchObject({
      parent: { type: "database_id", database_id: "db-opp" },
      properties: { Key: { title: [{ text: { content: "job-2" } }] } },
    });
  });

  it("routes each lane to its own database", async () => {
    const { fetchImpl, calls } = createFetchStub((call) => {
      if (call.path.endsWith("/query")) {
        return jsonResponse({ results: [], has_more: false });
      }
      if (call.method === "POST" && call.path === "pages") {
        return jsonResponse({ id: "page-new", url: "https://www.notion.so/n" });
      }
      throw new Error(`unexpected ${call.method} ${call.path}`);
    });

    const report = await notionAdapter.push(
      createContext({ fetchImpl, config: { databaseIds: ALL_DATABASE_IDS } }),
      { rows: [FOLLOW_UP, APPLICATION], known: new Map() },
    );

    expect(report.results.map((result) => result.entityKind)).toEqual([
      "application",
      "follow_up",
    ]);
    const queried = calls
      .filter((call) => call.path.endsWith("/query"))
      .map((call) => call.path);
    expect(queried).toEqual([
      "databases/db-app/query",
      "databases/db-fu/query",
    ]);
  });

  it("retries a rate-limited write that carries Retry-After and then succeeds", async () => {
    let writes = 0;
    const { fetchImpl, calls } = createFetchStub((call) => {
      if (call.path.endsWith("/query")) {
        return jsonResponse({ results: [], has_more: false });
      }
      if (call.method === "POST" && call.path === "pages") {
        writes += 1;
        if (writes === 1) {
          return jsonResponse(
            { code: "rate_limited", message: "Rate limited." },
            { status: 429, headers: { "retry-after": "0" } },
          );
        }
        return jsonResponse({
          id: "page-9",
          url: "https://www.notion.so/page9",
        });
      }
      throw new Error(`unexpected ${call.method} ${call.path}`);
    });

    const report = await notionAdapter.push(
      createContext({ fetchImpl, config: { databaseIds: ALL_DATABASE_IDS } }),
      { rows: [OPPORTUNITY], known: new Map() },
    );

    expect(
      calls.filter((call) => call.method === "POST" && call.path === "pages"),
    ).toHaveLength(2);
    expect(report.failures).toEqual([]);
    expect(report.results).toEqual([
      {
        entityKind: "opportunity",
        entityId: "job-1",
        outcome: "created",
        remoteId: "page-9",
        remoteUrl: "https://www.notion.so/page9",
      },
    ]);
  });

  it("isolates a rejected row so its siblings still land", async () => {
    let writes = 0;
    const { fetchImpl } = createFetchStub((call) => {
      if (call.path.endsWith("/query")) {
        return jsonResponse({ results: [], has_more: false });
      }
      if (call.method === "POST" && call.path === "pages") {
        writes += 1;
        if (writes === 2) {
          return jsonResponse(
            {
              code: "validation_error",
              message: "Score is expected to be a number.",
            },
            { status: 400 },
          );
        }
        return jsonResponse({
          id: `page-${writes}`,
          url: `https://www.notion.so/page${writes}`,
        });
      }
      throw new Error(`unexpected ${call.method} ${call.path}`);
    });

    const report = await notionAdapter.push(
      createContext({ fetchImpl, config: { databaseIds: ALL_DATABASE_IDS } }),
      {
        rows: [
          OPPORTUNITY,
          opportunity({ key: "job-2", jobId: "2" }),
          opportunity({ key: "job-3", jobId: "3" }),
        ],
        known: new Map(),
      },
    );

    expect(report.results.map((result) => result.entityId)).toEqual([
      "job-1",
      "job-3",
    ]);
    expect(report.failures).toEqual([
      {
        entityKind: "opportunity",
        entityId: "job-2",
        errorCode: "UPSTREAM_ERROR",
        errorMessage: expect.stringContaining("validation_error"),
      },
    ]);
  });

  it("throws when the credential itself is dead, rather than failing row by row", async () => {
    const { fetchImpl } = createFetchStub(() =>
      jsonResponse(
        { code: "unauthorized", message: "API token is invalid." },
        { status: 401 },
      ),
    );

    await expect(
      notionAdapter.push(
        createContext({ fetchImpl, config: { databaseIds: ALL_DATABASE_IDS } }),
        { rows: [OPPORTUNITY], known: new Map() },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("notionAdapter.disconnect", () => {
  it("forgets the connection locally without touching the workspace", async () => {
    const { fetchImpl, calls } = createFetchStub(() => {
      throw new Error("disconnect must never archive or delete user pages");
    });

    const health = await notionAdapter.disconnect(
      createContext({ fetchImpl, config: { databaseIds: ALL_DATABASE_IDS } }),
    );

    expect(calls).toHaveLength(0);
    expect(health).toMatchObject({
      connected: false,
      status: "disconnected",
      target: null,
      destinationUrl: null,
    });
  });
});

describe("toNotionProperties", () => {
  it("emits Notion's exact payload shape for every property type", () => {
    const properties = toNotionProperties(OPPORTUNITY);

    expect(properties.Key).toEqual({
      title: [{ type: "text", text: { content: "job-1" } }],
    });
    expect(properties.Company).toEqual({
      rich_text: [{ type: "text", text: { content: "Acme" } }],
    });
    expect(properties.Score).toEqual({ number: 87 });
    expect(properties["Sponsor Score"]).toEqual({ number: 62 });
    expect(properties.Remote).toEqual({ checkbox: true });
    expect(properties["Job URL"]).toEqual({
      url: "https://acme.example/jobs/1",
    });
    expect(properties.Status).toEqual({ select: { name: "new" } });
    expect(properties.Source).toEqual({ select: { name: "linkedin" } });
    expect(properties["Date Posted"]).toEqual({
      date: { start: "2026-09-01" },
    });
    expect(properties["Discovered At"]).toEqual({
      date: { start: "2026-09-10T12:00:00.000Z" },
    });
  });

  it("omits a null date instead of sending a null payload", () => {
    const properties = toNotionProperties(
      opportunity({ datePosted: null, discoveredAt: null }),
    );

    expect(properties).not.toHaveProperty("Date Posted");
    expect(properties).not.toHaveProperty("Discovered At");
    expect(toNotionProperties(FOLLOW_UP)).not.toHaveProperty("Due Date");
  });

  it("truncates rich text at Notion's 2000-character limit", () => {
    const properties = toNotionProperties(
      opportunity({ scoreReason: "x".repeat(2500) }),
    );

    expect(properties["Score Reason"]).toEqual({
      rich_text: [{ type: "text", text: { content: "x".repeat(2000) } }],
    });
  });

  it("clears empty values instead of writing junk options", () => {
    const application = toNotionProperties(APPLICATION);
    const followUp = toNotionProperties(FOLLOW_UP);

    expect(application.Outcome).toEqual({ select: null });
    expect(application["Resume Views"]).toEqual({ number: 3 });
    expect(followUp.Reason).toEqual({ rich_text: [] });
    expect(followUp.Completed).toEqual({ checkbox: false });
    expect(
      toNotionProperties(opportunity({ jobUrl: null }))["Job URL"],
    ).toEqual({ url: null });
  });
});

describe("hashRow", () => {
  it("ignores key order and reacts to any field change", () => {
    // Same fields, reversed insertion order: the digest must not notice.
    const reordered = Object.fromEntries(
      Object.entries(OPPORTUNITY).reverse(),
    ) as OpportunityRow;

    expect(hashRow(reordered)).toBe(hashRow(OPPORTUNITY));
    expect(hashRow(opportunity({ score: 88 }))).not.toBe(hashRow(OPPORTUNITY));
    expect(hashRow(opportunity({ scoreReason: null }))).not.toBe(
      hashRow(OPPORTUNITY),
    );
  });

  it("pins the cross-adapter digest for a known row", () => {
    // Sheets, Notion and the ledger must agree byte for byte, so this literal
    // is the shared contract: sha256 of the row's code-unit key-sorted JSON.
    expect(hashRow(FOLLOW_UP)).toBe(
      "1e1252f29c6a614032f6096e3cc474927c86332b6525ff0c4435cc96d609030f",
    );
  });
});
