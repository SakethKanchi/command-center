import { createHash } from "node:crypto";
import type {
  ApplicationRow,
  CommandCenterRow,
  Connector,
  ConnectorAdapterContext,
  ConnectorCredentials,
  ConnectorRecord,
  FollowUpRow,
  InterviewRow,
  OpportunityRow,
} from "@domain";
import { describe, expect, it, vi } from "vitest";
import { GOOGLE_TOKEN_URL, getValues } from "./api";
import { googleSheetsAdapter } from "./index";
import { hashRow, renderRow, SHEET_TABS } from "./layout";

// ---------------------------------------------------------------------------
// fetch stub. Every test drives the adapter through this; nothing here can
// reach the network, and `calls` is the observable record of what was sent.
// ---------------------------------------------------------------------------

type StubCall = { url: string; method: string; body: unknown };

type StubResponseInit = { status?: number; headers?: Record<string, string> };

type QueuedResponse = { match: RegExp; respond: () => Response };

type StubOptions = {
  spreadsheetTitle?: string;
  tabs?: Array<{ title: string; sheetId: number }>;
  /** Values keyed by decoded A1 range, as returned from a values GET. */
  values?: Record<string, string[][]>;
  /** First row number an append lands on, keyed by tab title. */
  appendStartRow?: Record<string, number>;
  /** Responses consumed before the defaults, matched against the URL. */
  queue?: QueuedResponse[];
  tokenStatus?: number;
  spreadsheetStatus?: number;
};

const DEFAULT_TABS = [
  { title: "Opportunities", sheetId: 11 },
  { title: "Applications", sheetId: 12 },
  { title: "Interviews", sheetId: 13 },
  { title: "Follow-ups", sheetId: 14 },
];

/** Last column of each tab, mirroring the header counts in `SHEET_TABS`. */
const LAST_COLUMN_BY_TITLE: Record<string, string> = {
  Opportunities: "O",
  Applications: "L",
  Interviews: "I",
  "Follow-ups": "I",
};

function stubResponse(body: unknown, init: StubResponseInit = {}): Response {
  const status = init.status ?? 200;
  const headers = new Map(
    Object.entries(init.headers ?? {}).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  const double = {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    json: async () => body,
  };
  // Test double: the client only reads ok/status/headers.get/json().
  return double as unknown as Response;
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function bodyValues(body: unknown): string[][] {
  if (
    body &&
    typeof body === "object" &&
    "values" in body &&
    Array.isArray(body.values)
  ) {
    const rows: string[][] = body.values;
    return rows;
  }
  return [];
}

function bodyRequests(
  body: unknown,
): Array<{ addSheet?: { properties?: { title?: string } } }> {
  if (
    body &&
    typeof body === "object" &&
    "requests" in body &&
    Array.isArray(body.requests)
  ) {
    const requests: Array<{ addSheet?: { properties?: { title?: string } } }> =
      body.requests;
    return requests;
  }
  return [];
}

function createStub(options: StubOptions = {}) {
  const calls: StubCall[] = [];
  const queue = [...(options.queue ?? [])];
  const tabs = options.tabs ?? DEFAULT_TABS;
  const values = options.values ?? {};
  const appendStartRow = options.appendStartRow ?? {};

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: parseBody(init?.body) });

    const queued = queue.find((entry) => entry.match.test(url));
    if (queued) {
      queue.splice(queue.indexOf(queued), 1);
      return queued.respond();
    }

    if (url === GOOGLE_TOKEN_URL) {
      if (options.tokenStatus && options.tokenStatus >= 400) {
        return stubResponse(
          {
            error: "invalid_grant",
            error_description: "Token has been expired or revoked.",
          },
          { status: options.tokenStatus },
        );
      }
      return stubResponse({ access_token: "access-token-1", expires_in: 3600 });
    }

    if (url.includes("?fields=")) {
      if (options.spreadsheetStatus && options.spreadsheetStatus >= 400) {
        return stubResponse(
          {
            error: {
              code: options.spreadsheetStatus,
              message: "Request had invalid authentication credentials.",
              status: "UNAUTHENTICATED",
            },
          },
          { status: options.spreadsheetStatus },
        );
      }
      return stubResponse({
        spreadsheetId: "sheet-abc",
        properties: {
          title: options.spreadsheetTitle ?? "Job Search Command Center",
        },
        sheets: tabs.map((tab) => ({
          properties: { sheetId: tab.sheetId, title: tab.title },
        })),
      });
    }

    if (url.endsWith(":batchUpdate")) {
      return stubResponse({ spreadsheetId: "sheet-abc", replies: [] });
    }

    const appendMatch = /\/values\/([^:?]+):append\?/.exec(url);
    if (appendMatch) {
      const range = decodeURIComponent(appendMatch[1] ?? "");
      const title = range.split("!")[0] ?? range;
      const appended = bodyValues(parseBody(init?.body));
      const start = appendStartRow[title] ?? 2;
      const end = start + Math.max(appended.length, 1) - 1;
      const lastColumn = LAST_COLUMN_BY_TITLE[title] ?? "Z";
      return stubResponse({
        spreadsheetId: "sheet-abc",
        updates: {
          updatedRange: `${title}!A${start}:${lastColumn}${end}`,
          updatedRows: appended.length,
        },
      });
    }

    const updateMatch = /\/values\/([^?]+)\?valueInputOption=RAW$/.exec(url);
    if (updateMatch) {
      const range = decodeURIComponent(updateMatch[1] ?? "");
      return stubResponse({
        spreadsheetId: "sheet-abc",
        updatedRange: range,
        updatedRows: 1,
      });
    }

    const readMatch = /\/values\/([^?]+)$/.exec(url);
    if (readMatch) {
      const range = decodeURIComponent(readMatch[1] ?? "");
      const rows = values[range];
      return rows
        ? stubResponse({ range, majorDimension: "ROWS", values: rows })
        : stubResponse({ range, majorDimension: "ROWS" });
    }

    throw new Error(`Unstubbed Google request: ${method} ${url}`);
  };

  return {
    fetchImpl,
    calls,
    valueWrites: () =>
      calls.filter(
        (call) => call.url.includes("/values/") && call.method !== "GET",
      ),
    valueReads: () =>
      calls.filter(
        (call) => call.url.includes("/values/") && call.method === "GET",
      ),
    updates: () => calls.filter((call) => call.method === "PUT"),
    appends: () => calls.filter((call) => call.url.includes(":append?")),
    batchUpdates: () =>
      calls.filter((call) => call.url.endsWith(":batchUpdate")),
    tokenCalls: () => calls.filter((call) => call.url === GOOGLE_TOKEN_URL),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: "connector-sheets-1",
    provider: "google_sheets",
    accountKey: "default",
    displayName: "Command Center",
    status: "connected",
    credentials: {
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    },
    config: { spreadsheetId: "sheet-abc" },
    lastConnectedAt: null,
    lastSyncedAt: "2023-11-14T22:13:20.000Z",
    lastError: null,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    ...overrides,
  };
}

function makeContext(
  fetchImpl: typeof fetch,
  overrides: Partial<Connector> = {},
  onCredentialsRefreshed?: (credentials: ConnectorCredentials) => void,
): ConnectorAdapterContext {
  return {
    connector: makeConnector(overrides),
    fetchImpl,
    onCredentialsRefreshed,
  };
}

const opportunity: OpportunityRow = {
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
};

const secondOpportunity: OpportunityRow = {
  ...opportunity,
  key: "job-2",
  jobId: "2",
  company: "Globex",
  role: "Principal Engineer",
  isRemote: false,
  score: null,
  scoreReason: null,
};

const application: ApplicationRow = {
  kind: "application",
  key: "app-1",
  jobId: "1",
  company: "Acme",
  role: "Staff Engineer",
  stage: "applied",
  outcome: null,
  appliedAt: "2026-09-11T09:30:00.000Z",
  resumePath: "/data/resumes/acme.pdf",
  resumeViews: 3,
  lastResumeViewAt: "2026-09-12T17:02:00.000Z",
  jobUrl: "https://jobs.example.com/1",
  score: 88,
};

const interview: InterviewRow = {
  kind: "interview",
  key: "int-1",
  jobId: "1",
  company: "Acme",
  role: "Staff Engineer",
  interviewId: "7",
  scheduledAt: "2026-09-20T13:00:00.000Z",
  durationMins: 45,
  interviewType: "technical",
  outcome: null,
};

const followUp: FollowUpRow = {
  kind: "follow_up",
  key: "fu-1",
  jobId: "1",
  company: "Acme",
  role: "Staff Engineer",
  taskId: "31",
  title: "Nudge recruiter",
  dueDate: "2026-09-16T00:00:00.000Z",
  isCompleted: false,
  reason: "resume opened 3x, no reply in 5d",
};

function ledger(
  entries: Array<{
    row: CommandCenterRow;
    contentHash?: string;
    remoteId: string;
    remoteUrl?: string | null;
  }>,
): Map<string, ConnectorRecord> {
  return new Map(
    entries.map((entry, index) => [
      `${entry.row.kind}:${entry.row.key}`,
      {
        id: `record-${index}`,
        connectorId: "connector-sheets-1",
        provider: "google_sheets",
        entityKind: entry.row.kind,
        entityId: entry.row.key,
        remoteId: entry.remoteId,
        remoteUrl: entry.remoteUrl ?? null,
        contentHash: entry.contentHash ?? hashRow(entry.row),
        lastPushedAt: "2023-11-14T22:13:20.000Z",
      },
    ]),
  );
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

describe("google sheets connector connect", () => {
  it("creates only the tabs that are missing", async () => {
    const stub = createStub({
      tabs: [
        { title: "Opportunities", sheetId: 11 },
        { title: "Applications", sheetId: 12 },
      ],
    });

    const health = await googleSheetsAdapter.connect(
      makeContext(stub.fetchImpl),
    );

    const batchUpdates = stub.batchUpdates();
    expect(batchUpdates).toHaveLength(1);
    const requests = bodyRequests(batchUpdates[0]?.body);
    expect(requests).toHaveLength(2);
    expect(
      requests.map((request) => request.addSheet?.properties?.title),
    ).toEqual(["Interviews", "Follow-ups"]);
    expect(health).toMatchObject({
      provider: "google_sheets",
      connected: true,
      status: "connected",
      target: "Job Search Command Center",
      destinationUrl: "https://docs.google.com/spreadsheets/d/sheet-abc",
    });
  });

  it("issues no addSheet requests when all four tabs already exist", async () => {
    const stub = createStub({
      values: {
        "Opportunities!A1:O1": [SHEET_TABS.opportunity.headers],
        "Applications!A1:L1": [SHEET_TABS.application.headers],
        "Interviews!A1:I1": [SHEET_TABS.interview.headers],
        "Follow-ups!A1:I1": [SHEET_TABS.follow_up.headers],
      },
    });

    await googleSheetsAdapter.connect(makeContext(stub.fetchImpl));

    expect(stub.batchUpdates()).toHaveLength(0);
    expect(stub.valueWrites()).toHaveLength(0);
  });

  it("writes the header row of every created tab", async () => {
    const stub = createStub({
      tabs: [{ title: "Opportunities", sheetId: 11 }],
      values: { "Opportunities!A1:O1": [SHEET_TABS.opportunity.headers] },
    });

    await googleSheetsAdapter.connect(makeContext(stub.fetchImpl));

    const writes = stub.updates();
    expect(
      writes.map((call) =>
        decodeURIComponent(call.url.split("/values/")[1] ?? ""),
      ),
    ).toEqual([
      "Applications!A1:L1?valueInputOption=RAW",
      "Interviews!A1:I1?valueInputOption=RAW",
      "Follow-ups!A1:I1?valueInputOption=RAW",
    ]);
    expect(bodyValues(writes[1]?.body)).toEqual([SHEET_TABS.interview.headers]);
    expect(bodyValues(writes[0]?.body)[0]?.[0]).toBe("Key");
  });

  it("repairs an existing tab whose header row does not match", async () => {
    const stub = createStub({
      values: {
        "Opportunities!A1:O1": [["Key", "Job ID", "Stale column"]],
        "Applications!A1:L1": [SHEET_TABS.application.headers],
        "Interviews!A1:I1": [SHEET_TABS.interview.headers],
        "Follow-ups!A1:I1": [SHEET_TABS.follow_up.headers],
      },
    });

    await googleSheetsAdapter.connect(makeContext(stub.fetchImpl));

    const writes = stub.updates();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.url).toContain(encodeURIComponent("Opportunities!A1:O1"));
    expect(bodyValues(writes[0]?.body)).toEqual([
      SHEET_TABS.opportunity.headers,
    ]);
  });

  it("hands the refreshed access token back to the caller", async () => {
    const stub = createStub();
    const onCredentialsRefreshed = vi.fn();

    await googleSheetsAdapter.connect(
      makeContext(stub.fetchImpl, {}, onCredentialsRefreshed),
    );

    expect(stub.tokenCalls()).toHaveLength(1);
    expect(onCredentialsRefreshed).toHaveBeenCalledTimes(1);
    expect(onCredentialsRefreshed.mock.calls[0]?.[0]).toMatchObject({
      refreshToken: "refresh-token",
      accessToken: "access-token-1",
    });
    const refreshed = onCredentialsRefreshed.mock.calls[0]?.[0];
    expect(refreshed?.accessTokenExpiresAt).toBeGreaterThan(Date.now());
  });

  it("reuses a cached access token instead of refreshing", async () => {
    const stub = createStub();
    const onCredentialsRefreshed = vi.fn();

    await googleSheetsAdapter.connect(
      makeContext(
        stub.fetchImpl,
        {
          credentials: {
            clientId: "client-id",
            clientSecret: "client-secret",
            refreshToken: "refresh-token",
            accessToken: "cached-token",
            accessTokenExpiresAt: Date.now() + 3_600_000,
          },
        },
        onCredentialsRefreshed,
      ),
    );

    expect(stub.tokenCalls()).toHaveLength(0);
    expect(onCredentialsRefreshed).not.toHaveBeenCalled();
    const metadataCall = stub.calls.find((call) =>
      call.url.includes("?fields="),
    );
    expect(metadataCall).toBeDefined();
  });

  it("rejects a connector whose config has no spreadsheetId", async () => {
    const stub = createStub();

    await expect(
      googleSheetsAdapter.connect(makeContext(stub.fetchImpl, { config: {} })),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(stub.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

describe("google sheets connector push", () => {
  it("writes nothing when every row matches the ledger hash", async () => {
    const stub = createStub();
    const rows: CommandCenterRow[] = [
      opportunity,
      application,
      interview,
      followUp,
    ];

    const report = await googleSheetsAdapter.push(makeContext(stub.fetchImpl), {
      rows,
      known: ledger([
        { row: opportunity, remoteId: "Opportunities!A2" },
        { row: application, remoteId: "Applications!A2" },
        { row: interview, remoteId: "Interviews!A2" },
        { row: followUp, remoteId: "Follow-ups!A2" },
      ]),
    });

    expect(stub.valueWrites()).toHaveLength(0);
    expect(stub.valueReads()).toHaveLength(0);
    expect(report.failures).toHaveLength(0);
    expect(report.results).toHaveLength(4);
    expect(report.results.every((row) => row.outcome === "unchanged")).toBe(
      true,
    );
    expect(report.results[0]).toEqual({
      entityKind: "opportunity",
      entityId: "job-1",
      outcome: "unchanged",
      remoteId: "Opportunities!A2",
      remoteUrl: null,
    });
    expect(report.destinationUrl).toBe(
      "https://docs.google.com/spreadsheets/d/sheet-abc",
    );
  });

  it("updates the existing row in place when the hash changed", async () => {
    const stub = createStub({
      values: {
        "Opportunities!A:A": [["Key"], ["job-0"], ["job-1"], ["job-9"]],
      },
    });

    const report = await googleSheetsAdapter.push(makeContext(stub.fetchImpl), {
      rows: [opportunity],
      known: ledger([
        {
          row: opportunity,
          contentHash: "stale-hash",
          remoteId: "Opportunities!A3",
          remoteUrl: "https://docs.google.com/spreadsheets/d/sheet-abc#gid=11",
        },
      ]),
    });

    const updates = stub.updates();
    expect(updates).toHaveLength(1);
    expect(updates[0]?.url).toContain(
      encodeURIComponent("Opportunities!A3:O3"),
    );
    expect(bodyValues(updates[0]?.body)).toEqual([renderRow(opportunity)]);
    expect(stub.appends()).toHaveLength(0);
    expect(report.results).toEqual([
      {
        entityKind: "opportunity",
        entityId: "job-1",
        outcome: "updated",
        remoteId: "Opportunities!A3",
        remoteUrl:
          "https://docs.google.com/spreadsheets/d/sheet-abc#gid=11&range=A3",
      },
    ]);
  });

  it("appends new keys once per tab and reports the parsed row numbers", async () => {
    const stub = createStub({
      values: { "Opportunities!A:A": [["Key"], ["job-0"], ["job-7"]] },
      appendStartRow: { Opportunities: 4, Applications: 2 },
    });

    const report = await googleSheetsAdapter.push(makeContext(stub.fetchImpl), {
      rows: [opportunity, secondOpportunity, application],
      known: new Map(),
    });

    const appends = stub.appends();
    expect(appends).toHaveLength(2);
    expect(appends[0]?.url).toContain(encodeURIComponent("Opportunities!A:A"));
    expect(bodyValues(appends[0]?.body)).toEqual([
      renderRow(opportunity),
      renderRow(secondOpportunity),
    ]);
    expect(bodyValues(appends[1]?.body)).toEqual([renderRow(application)]);
    expect(stub.updates()).toHaveLength(0);
    expect(stub.valueReads()).toHaveLength(2);

    expect(report.failures).toHaveLength(0);
    expect(report.results).toEqual([
      {
        entityKind: "opportunity",
        entityId: "job-1",
        outcome: "created",
        remoteId: "Opportunities!A4",
        remoteUrl:
          "https://docs.google.com/spreadsheets/d/sheet-abc#gid=11&range=A4",
      },
      {
        entityKind: "opportunity",
        entityId: "job-2",
        outcome: "created",
        remoteId: "Opportunities!A5",
        remoteUrl:
          "https://docs.google.com/spreadsheets/d/sheet-abc#gid=11&range=A5",
      },
      {
        entityKind: "application",
        entityId: "app-1",
        outcome: "created",
        remoteId: "Applications!A2",
        remoteUrl:
          "https://docs.google.com/spreadsheets/d/sheet-abc#gid=12&range=A2",
      },
    ]);
  });

  it("mixes unchanged, updated and created rows in one pass", async () => {
    const stub = createStub({
      values: { "Opportunities!A:A": [["Key"], ["job-1"]] },
      appendStartRow: { Opportunities: 3 },
    });

    const report = await googleSheetsAdapter.push(makeContext(stub.fetchImpl), {
      rows: [opportunity, secondOpportunity, followUp],
      known: ledger([
        {
          row: opportunity,
          contentHash: "stale-hash",
          remoteId: "Opportunities!A2",
        },
        { row: followUp, remoteId: "Follow-ups!A2" },
      ]),
    });

    // Results follow lane order (opportunity, application, interview,
    // follow_up), not the caller's row order.
    expect(report.results.map((row) => [row.entityId, row.outcome])).toEqual([
      ["job-1", "updated"],
      ["job-2", "created"],
      ["fu-1", "unchanged"],
    ]);
    // The follow-up lane is untouched, so its key column is never read.
    expect(stub.valueReads()).toHaveLength(1);
  });

  it("keeps other rows when a single row write fails", async () => {
    const stub = createStub({
      values: {
        "Opportunities!A:A": [["Key"], ["job-1"]],
        "Applications!A:A": [["Key"], ["app-1"]],
      },
      queue: [
        {
          match: /Opportunities!A2%3AO2/,
          respond: () =>
            stubResponse(
              {
                error: {
                  code: 403,
                  message: "The caller does not have permission",
                },
              },
              { status: 400 },
            ),
        },
      ],
    });

    const report = await googleSheetsAdapter.push(makeContext(stub.fetchImpl), {
      rows: [opportunity, application],
      known: new Map(),
    });

    expect(report.results.map((row) => row.entityId)).toEqual(["app-1"]);
    expect(report.failures).toEqual([
      {
        entityKind: "opportunity",
        entityId: "job-1",
        errorCode: "UPSTREAM_ERROR",
        errorMessage: expect.stringContaining("does not have permission"),
      },
    ]);
  });

  it("fails only the affected lane when its key column cannot be read", async () => {
    const stub = createStub({
      values: { "Applications!A:A": [["Key"]] },
      appendStartRow: { Applications: 2 },
      queue: [
        {
          match: /Opportunities!A%3AA/,
          respond: () =>
            stubResponse(
              { error: { code: 400, message: "Unable to parse range" } },
              { status: 400 },
            ),
        },
      ],
    });

    const report = await googleSheetsAdapter.push(makeContext(stub.fetchImpl), {
      rows: [opportunity, application],
      known: new Map(),
    });

    expect(report.failures.map((row) => row.entityId)).toEqual(["job-1"]);
    expect(report.results.map((row) => row.entityId)).toEqual(["app-1"]);
  });

  it("reports a failure when the append response omits updatedRange", async () => {
    const stub = createStub({
      queue: [
        {
          match: /:append\?/,
          respond: () => stubResponse({ spreadsheetId: "sheet-abc" }),
        },
      ],
    });

    const report = await googleSheetsAdapter.push(makeContext(stub.fetchImpl), {
      rows: [interview],
      known: new Map(),
    });

    expect(report.results).toHaveLength(0);
    expect(report.failures).toEqual([
      {
        entityKind: "interview",
        entityId: "int-1",
        errorCode: "UPSTREAM_ERROR",
        errorMessage: expect.stringContaining("updatedRange"),
      },
    ]);
  });

  it("refuses a repeated key inside one push instead of appending twice", async () => {
    const stub = createStub({ appendStartRow: { Opportunities: 2 } });

    const report = await googleSheetsAdapter.push(makeContext(stub.fetchImpl), {
      rows: [opportunity, { ...opportunity, company: "Acme Rebrand" }],
      known: new Map(),
    });

    const appends = stub.appends();
    expect(appends).toHaveLength(1);
    expect(bodyValues(appends[0]?.body)).toEqual([renderRow(opportunity)]);
    expect(report.results.map((row) => row.remoteId)).toEqual([
      "Opportunities!A2",
    ]);
    expect(report.failures).toEqual([
      {
        entityKind: "opportunity",
        entityId: "job-1",
        errorCode: "CONFLICT",
        errorMessage: expect.stringContaining("Duplicate key job-1"),
      },
    ]);
  });

  it("aborts the whole push on an auth failure", async () => {
    const stub = createStub({ spreadsheetStatus: 401 });

    await expect(
      googleSheetsAdapter.push(makeContext(stub.fetchImpl), {
        rows: [opportunity],
        known: new Map(),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

// ---------------------------------------------------------------------------
// status / disconnect
// ---------------------------------------------------------------------------

describe("google sheets connector status", () => {
  it("reports the spreadsheet title when reachable", async () => {
    const stub = createStub({ spreadsheetTitle: "Saketh Job Search" });

    const health = await googleSheetsAdapter.status(
      makeContext(stub.fetchImpl),
    );

    expect(health).toMatchObject({
      connected: true,
      status: "connected",
      target: "Saketh Job Search",
      lastError: null,
    });
  });

  it("reports connected false on a 401 instead of throwing", async () => {
    const stub = createStub({ spreadsheetStatus: 401 });

    const health = await googleSheetsAdapter.status(
      makeContext(stub.fetchImpl),
    );

    expect(health.connected).toBe(false);
    expect(health.status).toBe("error");
    expect(health.lastError).toContain("invalid authentication credentials");
    expect(health.destinationUrl).toBe(
      "https://docs.google.com/spreadsheets/d/sheet-abc",
    );
  });

  it("reports connected false when the refresh token is revoked", async () => {
    const stub = createStub({ tokenStatus: 400 });

    const health = await googleSheetsAdapter.status(
      makeContext(stub.fetchImpl),
    );

    expect(health.connected).toBe(false);
    expect(health.lastError).toContain("invalid_grant");
  });

  it("disconnects without any remote call", async () => {
    const stub = createStub();

    const health = await googleSheetsAdapter.disconnect(
      makeContext(stub.fetchImpl),
    );

    expect(stub.calls).toHaveLength(0);
    expect(health).toMatchObject({
      connected: false,
      status: "disconnected",
      target: null,
      destinationUrl: "https://docs.google.com/spreadsheets/d/sheet-abc",
    });
  });
});

// ---------------------------------------------------------------------------
// retry policy
// ---------------------------------------------------------------------------

describe("google sheets retry policy", () => {
  it("succeeds when a 429 is followed by a 200", async () => {
    const stub = createStub({
      values: { "Opportunities!A:A": [["Key"], ["job-1"]] },
      queue: [
        {
          match: /Opportunities!A%3AA/,
          respond: () =>
            stubResponse(
              { error: { code: 429, message: "Quota exceeded" } },
              { status: 429, headers: { "Retry-After": "0.01" } },
            ),
        },
      ],
    });

    const range = await getValues(
      "access-token-1",
      stub.fetchImpl,
      "sheet-abc",
      "Opportunities!A:A",
    );

    expect(range.values).toEqual([["Key"], ["job-1"]]);
    expect(stub.valueReads()).toHaveLength(2);
  });

  it("surfaces a failure after three 429s rather than hanging", async () => {
    const throttled = () =>
      stubResponse(
        { error: { code: 429, message: "Quota exceeded" } },
        { status: 429 },
      );
    const stub = createStub({
      queue: [
        { match: /values/, respond: throttled },
        { match: /values/, respond: throttled },
        { match: /values/, respond: throttled },
      ],
    });

    await expect(
      getValues(
        "access-token-1",
        stub.fetchImpl,
        "sheet-abc",
        "Interviews!A:A",
      ),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(stub.valueReads()).toHaveLength(3);
  });

  it("retries a throttled append inside push", async () => {
    const stub = createStub({
      appendStartRow: { Interviews: 2 },
      queue: [
        {
          match: /:append\?/,
          respond: () =>
            stubResponse(
              { error: { code: 503, message: "Backend error" } },
              { status: 503 },
            ),
        },
      ],
    });

    const report = await googleSheetsAdapter.push(makeContext(stub.fetchImpl), {
      rows: [interview],
      known: new Map(),
    });

    expect(stub.appends()).toHaveLength(2);
    expect(report.failures).toHaveLength(0);
    expect(report.results[0]).toMatchObject({
      entityId: "int-1",
      outcome: "created",
      remoteId: "Interviews!A2",
    });
  });
});

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

describe("google sheets layout", () => {
  it("anchors every tab on the Key column", () => {
    expect(Object.values(SHEET_TABS).map((tab) => tab.title)).toEqual([
      "Opportunities",
      "Applications",
      "Interviews",
      "Follow-ups",
    ]);
    for (const tab of Object.values(SHEET_TABS)) {
      expect(tab.headers[0]).toBe("Key");
    }
  });

  it("renders cells aligned to the tab headers", () => {
    expect(renderRow(opportunity)).toEqual([
      "job-1",
      "1",
      "Acme",
      "Staff Engineer",
      "London, UK",
      "greenhouse",
      "https://jobs.example.com/1",
      "",
      "88",
      "Strong platform match",
      "72",
      "yes",
      "2026-09-01T00:00:00.000Z",
      "2026-09-10T08:00:00.000Z",
      "sourced",
    ]);
    expect(renderRow(opportunity)).toHaveLength(
      SHEET_TABS.opportunity.headers.length,
    );
    expect(renderRow(secondOpportunity)[11]).toBe("no");
    expect(renderRow(followUp)).toHaveLength(
      SHEET_TABS.follow_up.headers.length,
    );
    expect(renderRow(followUp)[7]).toBe("no");
    expect(renderRow(application)[8]).toBe("3");
  });

  it("hashes rows independently of key order and follows the pinned algorithm", () => {
    const shuffled = Object.fromEntries(
      Object.entries(opportunity).reverse(),
    ) as OpportunityRow;
    expect(Object.keys(shuffled)[0]).not.toBe(Object.keys(opportunity)[0]);
    expect(hashRow(shuffled)).toBe(hashRow(opportunity));

    const pinned = createHash("sha256")
      .update(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(opportunity).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          ),
        ),
      )
      .digest("hex");
    expect(hashRow(opportunity)).toBe(pinned);

    expect(hashRow({ ...opportunity, score: 89 })).not.toBe(
      hashRow(opportunity),
    );
    expect(hashRow({ ...opportunity, scoreReason: null })).not.toBe(
      hashRow(opportunity),
    );
  });
});
