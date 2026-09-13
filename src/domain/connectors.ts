/**
 * Command Center outbound connectors.
 *
 * A connector is an *outbound* destination the agent writes to: a Google Sheets
 * command center, a Notion opportunity database, or the Gmail identity used to
 * send follow-ups. This is deliberately separate from
 * `./post-application.ts`, which models *inbound* mailbox ingestion.
 *
 * Every connector implements the same four-verb lifecycle (connect / status /
 * push / disconnect) so the agent's tool layer treats all three external apps
 * identically and the reliability harness can replay them against fixtures.
 */

export const CONNECTOR_PROVIDERS = [
  "google_sheets",
  "notion",
  "gmail_send",
] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

export const CONNECTOR_STATUSES = [
  "disconnected",
  "connected",
  "error",
] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

/**
 * How a connector's outbound calls are authorized.
 *
 * `direct` wins whenever the provider's own credentials are on the connector
 * row: those implementations talk to Google and Notion first-hand. `composio`
 * is the fallback that makes the app connectable with no Google Cloud project
 * and no Notion integration secret — the user clicks a hosted consent link.
 */
export const CONNECTOR_AUTH_MODES = ["direct", "composio"] as const;
export type ConnectorAuthMode = (typeof CONNECTOR_AUTH_MODES)[number];

/**
 * Progress of a hosted (Composio) consent link. Kept separate from
 * `ConnectorStatus` because the `connectors.status` column is constrained to
 * three values, and because a UI polling for consent needs to tell "waiting on
 * the user" apart from "disconnected".
 *
 * `pending` is the only non-terminal value.
 */
export const CONNECTOR_LINK_STATES = [
  "none",
  "pending",
  "active",
  "failed",
  "expired",
] as const;
export type ConnectorLinkState = (typeof CONNECTOR_LINK_STATES)[number];

export const CONNECTOR_SYNC_RUN_STATUSES = [
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ConnectorSyncRunStatus =
  (typeof CONNECTOR_SYNC_RUN_STATUSES)[number];

export const CONNECTOR_SYNC_TRIGGERS = ["manual", "agent", "schedule"] as const;
export type ConnectorSyncTrigger = (typeof CONNECTOR_SYNC_TRIGGERS)[number];

/**
 * The four lanes of the command center. Each lane maps to one Sheets tab, one
 * Notion database view, and one row shape.
 */
export const CONNECTOR_ENTITY_KINDS = [
  "opportunity",
  "application",
  "interview",
  "follow_up",
] as const;
export type ConnectorEntityKind = (typeof CONNECTOR_ENTITY_KINDS)[number];

export type ConnectorCredentials = Record<string, unknown>;
export type ConnectorConfig = Record<string, unknown>;

export type Connector = {
  id: string;
  provider: ConnectorProvider;
  accountKey: string;
  displayName: string | null;
  status: ConnectorStatus;
  /** Never serialized to the client; redacted at the route boundary. */
  credentials: ConnectorCredentials | null;
  config: ConnectorConfig | null;
  lastConnectedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Client-safe projection: credentials stripped, presence reported as a flag. */
export type ConnectorSummary = Omit<Connector, "credentials"> & {
  hasCredentials: boolean;
};

export type ConnectorSyncRun = {
  id: string;
  connectorId: string | null;
  provider: ConnectorProvider;
  accountKey: string;
  status: ConnectorSyncRunStatus;
  trigger: ConnectorSyncTrigger;
  startedAt: string;
  completedAt: string | null;
  recordsConsidered: number;
  recordsCreated: number;
  recordsUpdated: number;
  recordsUnchanged: number;
  recordsFailed: number;
  errorCode: string | null;
  errorMessage: string | null;
};

/**
 * Idempotency ledger entry. `contentHash` is the hash of the rendered payload,
 * so a re-push of unchanged data is a no-op rather than a duplicate write.
 */
export type ConnectorRecord = {
  id: string;
  connectorId: string;
  provider: ConnectorProvider;
  entityKind: ConnectorEntityKind;
  entityId: string;
  remoteId: string;
  remoteUrl: string | null;
  contentHash: string;
  lastPushedAt: string;
};

// ---------------------------------------------------------------------------
// Canonical row shapes
//
// These are the single source of truth for what lands in Sheets and Notion.
// Both adapters render from the same objects, which is what makes the two
// destinations verifiably consistent with each other.
// ---------------------------------------------------------------------------

/** Shared identity every lane carries, so rows can be reconciled across apps. */
export type CommandCenterRowBase = {
  /** Stable natural key written into the destination for idempotent upsert. */
  key: string;
  jobId: string;
  company: string;
  role: string;
};

export type OpportunityRow = CommandCenterRowBase & {
  kind: "opportunity";
  location: string | null;
  source: string;
  jobUrl: string | null;
  salary: string | null;
  /** 0-100 LLM suitability score. */
  score: number | null;
  scoreReason: string | null;
  /** 0-100 visa sponsor register match, when the employer is on a register. */
  sponsorScore: number | null;
  isRemote: boolean | null;
  datePosted: string | null;
  discoveredAt: string | null;
  status: string;
};

export type ApplicationRow = CommandCenterRowBase & {
  kind: "application";
  stage: string;
  outcome: string | null;
  appliedAt: string | null;
  resumePath: string | null;
  /** Non-bot tracer-link opens on the submitted resume. */
  resumeViews: number;
  lastResumeViewAt: string | null;
  jobUrl: string | null;
  score: number | null;
};

export type InterviewRow = CommandCenterRowBase & {
  kind: "interview";
  interviewId: string;
  scheduledAt: string;
  durationMins: number | null;
  interviewType: string;
  outcome: string | null;
};

export type FollowUpRow = CommandCenterRowBase & {
  kind: "follow_up";
  taskId: string;
  title: string;
  dueDate: string | null;
  isCompleted: boolean;
  /** Why the agent scheduled it, e.g. "resume opened 3x, no reply in 5d". */
  reason: string | null;
};

export type CommandCenterRow =
  | OpportunityRow
  | ApplicationRow
  | InterviewRow
  | FollowUpRow;

/** One lane's worth of rows, ready to push. */
export type CommandCenterSnapshot = {
  opportunities: OpportunityRow[];
  applications: ApplicationRow[];
  interviews: InterviewRow[];
  followUps: FollowUpRow[];
  generatedAt: string;
};

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export type ConnectorPushOutcome = "created" | "updated" | "unchanged";

export type ConnectorPushResult = {
  entityKind: ConnectorEntityKind;
  entityId: string;
  outcome: ConnectorPushOutcome;
  remoteId: string;
  remoteUrl: string | null;
};

export type ConnectorPushFailure = {
  entityKind: ConnectorEntityKind;
  entityId: string;
  errorCode: string;
  errorMessage: string;
};

export type ConnectorPushReport = {
  provider: ConnectorProvider;
  accountKey: string;
  results: ConnectorPushResult[];
  failures: ConnectorPushFailure[];
  /** Destination deep link, surfaced in the dashboard and the agent trace. */
  destinationUrl: string | null;
};

export type ConnectorHealth = {
  provider: ConnectorProvider;
  accountKey: string;
  connected: boolean;
  status: ConnectorStatus;
  /** Human-readable target, e.g. the spreadsheet title or database name. */
  target: string | null;
  destinationUrl: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  /**
   * Which transport is authorizing this connector. Optional so the direct
   * adapters keep building health payloads unchanged; the API layer always
   * fills it in.
   */
  authMode?: ConnectorAuthMode;
  /** Consent-link progress. Absent or `none` means no link is in flight. */
  linkState?: ConnectorLinkState;
  /** Composio's handle for the linked account, needed to poll and to revoke. */
  connectedAccountId?: string | null;
  /** Actionable next step when the connector is not usable yet. */
  setupHint?: string | null;
};

/**
 * Gmail send is a connector too, but it sends messages rather than pushing
 * rows, so it exposes this payload instead of `CommandCenterRow`.
 */
export type OutboundEmailRequest = {
  to: string;
  subject: string;
  /** Plain-text body. HTML is deliberately unsupported: recruiters' ATS strip it. */
  body: string;
  /** Gmail thread to reply within, so follow-ups thread correctly. */
  threadId?: string | null;
  inReplyToMessageId?: string | null;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    /** Absolute path on disk; read at send time, never held in the DB. */
    path: string;
  }>;
};

export type OutboundEmailResult = {
  messageId: string;
  threadId: string;
  to: string;
  subject: string;
  sentAt: string;
  /** Deep link to the sent message. */
  webUrl: string;
};

export type ConnectorAdapterContext = {
  connector: Connector;
  /** Injected for tests; adapters MUST NOT call global fetch directly. */
  fetchImpl: typeof fetch;
  /**
   * Called when an adapter refreshes an OAuth access token, so the service
   * layer can persist it. Adapters stay free of database access; without this
   * hook every call would repeat the refresh round trip.
   *
   * Optional so an adapter holding a non-expiring token (Notion) can ignore it,
   * and so unit tests can omit it.
   */
  onCredentialsRefreshed?: (credentials: ConnectorCredentials) => void;
};

export interface ConnectorAdapter {
  readonly key: ConnectorProvider;
  /** Lanes this adapter accepts; `gmail_send` accepts none. */
  readonly supportedEntityKinds: readonly ConnectorEntityKind[];

  /**
   * Validate credentials and provision the destination (create missing tabs,
   * verify the database schema). Idempotent: safe to call on every connect.
   */
  connect(ctx: ConnectorAdapterContext): Promise<ConnectorHealth>;

  status(ctx: ConnectorAdapterContext): Promise<ConnectorHealth>;

  /**
   * Upsert rows by their natural `key`. Implementations MUST be idempotent:
   * pushing the same snapshot twice yields `unchanged` the second time.
   */
  push(
    ctx: ConnectorAdapterContext,
    input: {
      rows: CommandCenterRow[];
      /** Prior ledger entries, keyed `${entityKind}:${entityId}`. */
      known: Map<string, ConnectorRecord>;
    },
  ): Promise<ConnectorPushReport>;

  disconnect(ctx: ConnectorAdapterContext): Promise<ConnectorHealth>;
}

export interface OutboundEmailAdapter {
  readonly key: "gmail_send";
  connect(ctx: ConnectorAdapterContext): Promise<ConnectorHealth>;
  status(ctx: ConnectorAdapterContext): Promise<ConnectorHealth>;
  send(
    ctx: ConnectorAdapterContext,
    request: OutboundEmailRequest,
  ): Promise<OutboundEmailResult>;
  disconnect(ctx: ConnectorAdapterContext): Promise<ConnectorHealth>;
}
