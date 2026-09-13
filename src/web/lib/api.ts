import type {
  AgentRun,
  AgentRunDetail,
  AgentRunMode,
  AgentStepDecision,
  CommandCenterSnapshot,
  ConnectorHealth,
  ConnectorProvider,
  ConnectorPushReport,
  ConnectorSummary,
  JobCard,
} from "@domain";

/** The single envelope every endpoint answers with. */
export type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

/**
 * Carries the server's own error code and message so the UI can show what the
 * server said instead of a generic failure.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export type LaneSummary = {
  opportunities: number;
  applications: number;
  interviews: number;
  followUps: number;
  total: number;
};

export type SnapshotResponse = {
  snapshot: CommandCenterSnapshot;
  summary: LaneSummary;
};

export type ConnectorsResponse = {
  connectors: ConnectorSummary[];
  health: ConnectorHealth[];
};

export type SyncResponse = {
  reports: ConnectorPushReport[];
  skipped: Array<{ provider: string; reason: string }>;
  summary: LaneSummary;
};

/**
 * Unwraps the envelope. A transport failure, a non-JSON body and an
 * `{ ok: false }` payload all arrive as one `ApiError`, so callers have a
 * single catch to write.
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(
      `Cannot reach the Command Center server at ${path}. Is it running on port 8787?`,
      "NETWORK",
      0,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(
      `${path} answered ${response.status} with a body that is not JSON.`,
      "BAD_RESPONSE",
      response.status,
    );
  }

  const envelope = payload as ApiEnvelope<T>;
  if (envelope && typeof envelope === "object" && envelope.ok === false) {
    throw new ApiError(
      envelope.error?.message ?? "The server rejected the request.",
      envelope.error?.code ?? "UNKNOWN",
      response.status,
    );
  }
  if (!envelope || typeof envelope !== "object" || envelope.ok !== true) {
    throw new ApiError(
      `${path} answered in an unrecognised shape.`,
      "BAD_RESPONSE",
      response.status,
    );
  }
  return envelope.data;
}

const postJson = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body ?? {}),
});

export const api = {
  snapshot: () => request<SnapshotResponse>("/api/snapshot"),

  connectors: () => request<ConnectorsResponse>("/api/connectors"),

  connect: (provider: ConnectorProvider) =>
    request<{ health: ConnectorHealth }>(
      `/api/connectors/${provider}/connect`,
      postJson({}),
    ),

  disconnect: (provider: ConnectorProvider) =>
    request<{ health: ConnectorHealth }>(
      `/api/connectors/${provider}/disconnect`,
      postJson({}),
    ),

  sync: (providers?: string[]) =>
    request<SyncResponse>(
      "/api/sync",
      postJson(providers ? { providers } : {}),
    ),

  apply: (input: {
    jobId: string;
    mode?: AgentRunMode;
    contactEmail?: string;
  }) => request<{ run: AgentRunDetail }>("/api/agent/apply", postJson(input)),

  /** Confirm or clear the outreach recipient. `null` clears the override. */
  setJobContact: (jobId: string, email: string | null) =>
    request<{ job: JobCard }>(
      `/api/jobs/${jobId}/contact`,
      postJson({ email }),
    ),

  runs: (limit = 20) =>
    request<{ runs: AgentRun[] }>(`/api/agent/runs?limit=${limit}`),

  run: (id: string) =>
    request<{ run: AgentRunDetail }>(`/api/agent/runs/${id}`),

  decide: (stepId: string, decision: AgentStepDecision) =>
    request<{ run: AgentRunDetail }>(
      `/api/agent/steps/${stepId}/decision`,
      postJson({ decision }),
    ),
};
