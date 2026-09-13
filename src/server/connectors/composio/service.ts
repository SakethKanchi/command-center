/**
 * Provider-facing Composio operations: start a hosted consent link, poll it,
 * revoke it, and send through it.
 *
 * Persistence is the existing connectors repo — same table, same row, same
 * `ConnectorHealth` shape as the direct adapters. Composio is the fallback
 * transport, not a parallel world.
 */

import {
  CONNECTOR_ENTITY_KINDS,
  type Connector,
  type ConnectorAuthMode,
  type ConnectorHealth,
  type ConnectorProvider,
  type ConnectorStatus,
  type OutboundEmailRequest,
  type OutboundEmailResult,
} from "@domain";
import { nowIso } from "@server/db";
import { badRequest, toAppError, upstreamError } from "@server/infra/errors";
import { logger } from "@server/infra/logger";
import type { RepoBundle } from "@server/repos";
import { type NotionDatabaseIds, notionConfigSchema } from "../notion/api";
import {
  composioDatabaseProperties,
  NOTION_DATABASES,
} from "../notion/properties";
import { createDirectNotionRowTransport } from "../notion/transport";
import { sheetsConfigSchema, spreadsheetWebUrl } from "../sheets/api";
import { COMMAND_CENTER_SPREADSHEET_TITLE } from "../sheets/layout";
import {
  type ComposioAccountStatus,
  type ComposioClient,
  createComposioClient,
} from "./client";
import {
  COMPOSIO_ACCOUNT_KEY,
  type ComposioState,
  mergeComposioState,
  readComposioState,
} from "./state";
import {
  composioToolkitFor,
  isComposioProvider,
  NOTION_CREATE_DATABASE_TOOL,
  NOTION_FETCH_DATA_TOOL,
  notionCreateDatabaseArguments,
  notionFetchDatabasesArguments,
  SHEETS_CREATE_SPREADSHEET_TOOL,
  sheetsCreateSpreadsheetArguments,
} from "./toolkits";
import {
  createComposioGmailTransport,
  createComposioNotionTransport,
  type GmailSendTransport,
  hasComposioApiKey,
  type NotionPageRef,
  type NotionPageTransport,
  type NotionPageWrite,
  notConfiguredMessage,
  readNotionDatabases,
  readNotionId,
  readSpreadsheetId,
  requireAuthMode,
  resolveAuthMode,
} from "./transport";

export type ComposioDeps = {
  repos: RepoBundle;
  /** Injected for tests; never reaches the global `fetch` in one. */
  fetchImpl?: typeof fetch;
  /** Pre-built client, used by tests instead of stubbing the environment. */
  client?: ComposioClient;
  apiKey?: string | null;
  userId?: string;
  /** Composio API base; overridden in tests so a stray call is obvious. */
  composioBaseUrl?: string;
  /** Where Composio returns the browser after consent. */
  callbackUrl?: string | null;
};

export type ComposioLinkTicket = {
  redirectUrl: string;
  /** ISO-8601 UTC. */
  expiresAt: string;
  connectedAccountId: string;
};

function resolveClient(deps: ComposioDeps): ComposioClient {
  return (
    deps.client ??
    createComposioClient({
      apiKey: deps.apiKey,
      baseUrl: deps.composioBaseUrl,
      fetchImpl: deps.fetchImpl,
      userId: deps.userId,
    })
  );
}

/** An injected client stands in for a key: tests must not need the env var. */
function composioAvailable(deps: ComposioDeps): boolean {
  return deps.client !== undefined || hasComposioApiKey(deps.apiKey);
}

function loadRow(
  provider: ConnectorProvider,
  deps: ComposioDeps,
): Connector | null {
  return deps.repos.connectors.getByProvider(provider, COMPOSIO_ACCOUNT_KEY);
}

/**
 * Which transport a provider is on right now, with `null` meaning neither is
 * set up. Health probes call this; anything that acts calls `requireAuthMode`.
 */
export function providerAuthMode(
  provider: ConnectorProvider,
  deps: ComposioDeps,
): ConnectorAuthMode | null {
  const row = loadRow(provider, deps);
  return resolveAuthMode({
    hasDirectCredentials: Boolean(row?.credentials),
    // Every registered toolkit is a usable transport, Sheets included: the
    // guard is about the registry being total, not about Sheets being special.
    hasComposio: composioAvailable(deps) && isComposioProvider(provider),
  });
}

/**
 * Write the Composio block back, preserving the rest of `config`.
 *
 * `upsertConnected` is the repo's only insert path and it forces status
 * `connected`, so a freshly created row is immediately corrected: a link
 * awaiting consent must never read as connected.
 */
function persistState(
  provider: ConnectorProvider,
  deps: ComposioDeps,
  patch: {
    state: Partial<ComposioState> | null;
    status: ConnectorStatus;
    lastError?: string | null;
    lastConnectedAt?: string | null;
    displayName?: string | null;
    /**
     * Non-Composio `config` keys to merge on top, for state the direct path
     * reads too — `spreadsheetId` is the only one, and it is deliberately the
     * same key, so the two transports address one spreadsheet.
     */
    config?: Record<string, unknown>;
  },
): Connector {
  const existing = loadRow(provider, deps);
  const config = {
    ...mergeComposioState(existing, patch.state),
    ...(patch.config ?? {}),
  };

  if (existing) {
    return (
      deps.repos.connectors.updateState({
        id: existing.id,
        config,
        status: patch.status,
        lastError: patch.lastError ?? null,
        ...(patch.lastConnectedAt === undefined
          ? {}
          : { lastConnectedAt: patch.lastConnectedAt }),
        ...(patch.displayName === undefined
          ? {}
          : { displayName: patch.displayName }),
      }) ?? existing
    );
  }

  const created = deps.repos.connectors.upsertConnected({
    provider,
    accountKey: COMPOSIO_ACCOUNT_KEY,
    ...(patch.displayName === undefined
      ? {}
      : { displayName: patch.displayName }),
    config,
  });
  return (
    deps.repos.connectors.updateState({
      id: created.id,
      status: patch.status,
      lastError: patch.lastError ?? null,
    }) ?? created
  );
}

function buildHealth(args: {
  provider: ConnectorProvider;
  row: Connector | null;
  connected: boolean;
  status: ConnectorStatus;
  state: ComposioState;
  target?: string | null;
  destinationUrl?: string | null;
  lastError?: string | null;
  setupHint?: string | null;
}): ConnectorHealth {
  return {
    provider: args.provider,
    accountKey: COMPOSIO_ACCOUNT_KEY,
    connected: args.connected,
    status: args.status,
    target: args.target ?? args.state.label ?? null,
    destinationUrl: args.destinationUrl ?? null,
    lastSyncedAt: args.row?.lastSyncedAt ?? null,
    lastError: args.lastError ?? null,
    authMode: "composio",
    linkState: args.state.linkState,
    connectedAccountId: args.state.connectedAccountId,
    setupHint: args.setupHint ?? null,
  };
}

/** Health for a provider with neither transport configured. */
export function notConfiguredHealth(
  provider: ConnectorProvider,
  row: Connector | null,
): ConnectorHealth {
  const hint = notConfiguredMessage(provider);
  return {
    provider,
    accountKey: COMPOSIO_ACCOUNT_KEY,
    connected: false,
    status: row?.status ?? "disconnected",
    target: null,
    destinationUrl: null,
    lastSyncedAt: row?.lastSyncedAt ?? null,
    lastError: row?.lastError ?? hint,
    // Neither transport is set up, and saying "direct" here would be a
    // guess — `providerAuthMode` only answers "direct" when the row actually
    // holds credentials. Omitting it lets the UI tell "not connectable, read
    // the hint" apart from "credentials exist, offer Verify".
    linkState: "none",
    connectedAccountId: null,
    setupHint: hint,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start a hosted Connect Link. The user clicks the returned URL, consents in
 * Composio's own flow, and the account becomes ACTIVE — no OAuth client, no
 * redirect URI to register, no client secret in this repo.
 */
export async function linkProvider(
  provider: ConnectorProvider,
  deps: ComposioDeps,
): Promise<ComposioLinkTicket> {
  if (!composioAvailable(deps)) {
    throw badRequest(notConfiguredMessage(provider));
  }
  const toolkit = composioToolkitFor(provider);
  const client = resolveClient(deps);

  const authConfigId = await client.ensureAuthConfig(toolkit.toolkitSlug);
  const link = await client.createLink({
    authConfigId,
    callbackUrl: deps.callbackUrl ?? null,
  });

  persistState(provider, deps, {
    state: {
      authConfigId,
      connectedAccountId: link.connectedAccountId,
      linkState: "pending",
    },
    // Consent has not happened yet. Anything but `disconnected` here would
    // show a green connector the user never authorized.
    status: "disconnected",
    lastError: null,
  });

  logger.info("Started a Composio connect link", {
    provider,
    toolkitSlug: toolkit.toolkitSlug,
    connectedAccountId: link.connectedAccountId,
  });

  return {
    redirectUrl: link.redirectUrl,
    expiresAt: link.expiresAt,
    connectedAccountId: link.connectedAccountId,
  };
}

const STATUS_BY_ACCOUNT_STATUS: Record<
  ComposioAccountStatus,
  { status: ConnectorStatus; linkState: ComposioState["linkState"] }
> = {
  ACTIVE: { status: "connected", linkState: "active" },
  INITIATED: { status: "disconnected", linkState: "pending" },
  INITIALIZING: { status: "disconnected", linkState: "pending" },
  FAILED: { status: "error", linkState: "failed" },
  EXPIRED: { status: "error", linkState: "expired" },
  INACTIVE: { status: "disconnected", linkState: "none" },
  UNKNOWN: { status: "disconnected", linkState: "none" },
};

/**
 * Poll the link. Called repeatedly by the UI while `linkState` is `pending`,
 * so it adopts an already-linked account when the local id is missing: a
 * restarted server, or a link completed in another tab, still resolves.
 */
export async function syncProviderStatus(
  provider: ConnectorProvider,
  deps: ComposioDeps,
): Promise<ConnectorHealth> {
  const row = loadRow(provider, deps);
  const state = readComposioState(row);

  if (!composioAvailable(deps)) return notConfiguredHealth(provider, row);
  const toolkit = composioToolkitFor(provider);
  const client = resolveClient(deps);

  let accountId = state.connectedAccountId;
  if (!accountId) {
    const accounts = await client.listConnectedAccounts(toolkit.toolkitSlug);
    // A toolkit can hold several accounts, and a stale one outlives the
    // account that works: this user's Composio holds a FAILED `notion` and
    // an EXPIRED `gmail` beside the ACTIVE pair. `accounts[0]` would bind
    // the dead one and report a connected app that cannot execute a tool.
    // INITIATED is kept as the second tier because the hosted Connect Link
    // polls an account that is INITIATED and not yet ACTIVE, so an
    // ACTIVE-only rule would stall consent instead of completing it.
    const live =
      accounts.find((account) => account.status === "ACTIVE") ??
      accounts.find(
        (account) =>
          account.status === "INITIATED" || account.status === "INITIALIZING",
      );
    accountId = live?.id ?? null;
  }

  if (!accountId) {
    return buildHealth({
      provider,
      row,
      connected: false,
      status: "disconnected",
      state: { ...state, connectedAccountId: null, linkState: "none" },
      setupHint: `Click Connect to authorize ${toolkit.toolkitSlug} through Composio — no Google Cloud project needed.`,
    });
  }

  const account = await client.getConnectedAccount(accountId);
  const mapped = STATUS_BY_ACCOUNT_STATUS[account.status];
  const connected = account.status === "ACTIVE";
  // A consumer entity id (`consumer-<uuid>-<org>`) is machine plumbing, not
  // something to show on a card. Prefer a name the user recognises and fall
  // back to the toolkit, never to the raw id.
  const label =
    (account.userId?.startsWith("consumer-")
      ? `${toolkit.toolkitSlug} via Composio`
      : account.userId) ??
    account.toolkitSlug ??
    toolkit.toolkitSlug;
  const lastError = connected
    ? null
    : (account.statusReason ??
      (mapped.linkState === "pending"
        ? null
        : `Composio reported the ${toolkit.toolkitSlug} account as ${account.status}.`));

  const nextState: Partial<ComposioState> = {
    connectedAccountId: account.id,
    linkState: mapped.linkState,
    label,
    ...(connected ? { linkedAt: state.linkedAt ?? nowIso() } : {}),
  };

  const saved = persistState(provider, deps, {
    state: nextState,
    status: mapped.status,
    lastError,
    ...(connected ? { lastConnectedAt: nowIso() } : {}),
  });

  return buildHealth({
    provider,
    row: saved,
    connected,
    status: mapped.status,
    state: readComposioState(saved),
    target: label,
    lastError,
    setupHint:
      mapped.linkState === "pending"
        ? "Finish the consent screen in the popup, then this will flip to connected."
        : null,
  });
}

/**
 * Forget the connector locally and revoke Composio's connected account.
 *
 * Never touches the user's Gmail messages or Notion pages: no tool is
 * executed here at all. Disconnecting an integration must not be able to
 * delete data the user created.
 */
export async function disconnectProvider(
  provider: ConnectorProvider,
  deps: ComposioDeps,
): Promise<ConnectorHealth> {
  const row = loadRow(provider, deps);
  const state = readComposioState(row);

  if (row) {
    // Local first, so a Composio outage cannot leave the app showing a
    // connector the user asked to remove.
    deps.repos.connectors.disconnect(row.id);
    deps.repos.connectors.updateState({
      id: row.id,
      config: mergeComposioState(row, null),
      status: "disconnected",
      lastError: null,
    });
  }

  if (state.connectedAccountId && composioAvailable(deps)) {
    try {
      await resolveClient(deps).deleteConnectedAccount(
        state.connectedAccountId,
      );
    } catch (error) {
      // Best effort: the local disconnect already happened, and the account id
      // is logged so a stale grant can be revoked from Composio's dashboard.
      logger.warn("Composio connected account delete failed", {
        provider,
        connectedAccountId: state.connectedAccountId,
        message: toAppError(error).message,
      });
    }
  }

  // Reuse the not-configured shape: after a disconnect that is exactly what
  // this connector is, and the hint tells the user how to come back.
  return {
    ...notConfiguredHealth(provider, loadRow(provider, deps)),
    // Not an error — the user asked for this.
    lastError: null,
  };
}

// ---------------------------------------------------------------------------
// Outbound calls
// ---------------------------------------------------------------------------

/** Gmail send over Composio, for callers that are not the adapter itself. */
export async function sendViaComposio(
  request: OutboundEmailRequest,
  deps: ComposioDeps,
): Promise<OutboundEmailResult> {
  if (!composioAvailable(deps)) {
    throw badRequest(notConfiguredMessage("gmail_send"));
  }
  const state = readComposioState(loadRow("gmail_send", deps));
  const transport: GmailSendTransport = createComposioGmailTransport({
    client: resolveClient(deps),
    connectedAccountId: state.connectedAccountId,
  });
  return transport.send(request);
}

/**
 * The direct half of the Notion page transport, built from the same
 * `notion/api.ts` primitives the adapter pushes through. Kept as a thin
 * adaptor over `createDirectNotionRowTransport` so a page write and a row
 * write render properties identically.
 */
export function createDirectNotionTransport(args: {
  token: string;
  fetchImpl: typeof fetch;
}): NotionPageTransport {
  return createDirectNotionRowTransport({
    readToken: () => args.token,
    fetchImpl: args.fetchImpl,
  });
}

/**
 * Write one Notion page through whichever transport is active.
 *
 * This is the Notion counterpart to the Gmail seam: one interface, the direct
 * implementation above and the Composio one in `transport.ts`, chosen by the
 * shared predicate. Direct wins whenever the connector row holds a token.
 */
export async function upsertNotionPage(
  input: NotionPageWrite,
  deps: ComposioDeps,
): Promise<NotionPageRef> {
  const row = loadRow("notion", deps);
  const token =
    typeof row?.credentials?.accessToken === "string"
      ? row.credentials.accessToken
      : null;

  const mode = requireAuthMode({
    provider: "notion",
    hasDirectCredentials: token !== null,
    hasComposio: composioAvailable(deps),
  });

  if (mode === "direct" && token) {
    return createDirectNotionTransport({
      token,
      fetchImpl: deps.fetchImpl ?? fetch,
    }).write(input);
  }

  const state = readComposioState(row);
  return createComposioNotionTransport({
    client: resolveClient(deps),
    connectedAccountId: state.connectedAccountId,
  }).write(input);
}

/**
 * The spreadsheet the Composio Sheets transport writes into.
 *
 * Stored under the same `config.spreadsheetId` the direct path reads, so a
 * user who links Sheets twice — or links it over Composio having previously
 * connected it directly — keeps one spreadsheet instead of collecting a new
 * one per link. The id is persisted before any row is written, because a
 * created-then-forgotten spreadsheet is an orphan in the user's Drive that the
 * next sync would silently duplicate.
 *
 * A stored id costs no request at all; this only executes a tool the first
 * time Sheets is synced over Composio.
 */
export async function ensureComposioSpreadsheet(
  deps: ComposioDeps,
  args: { title?: string } = {},
): Promise<{ spreadsheetId: string; created: boolean }> {
  const row = loadRow("google_sheets", deps);
  const stored = sheetsConfigSchema.safeParse(row?.config);
  if (stored.success) {
    return { spreadsheetId: stored.data.spreadsheetId, created: false };
  }

  if (!composioAvailable(deps)) {
    throw badRequest(notConfiguredMessage("google_sheets"));
  }

  const state = readComposioState(row);
  const title = args.title?.trim() || COMMAND_CENTER_SPREADSHEET_TITLE;
  const created = await resolveClient(deps).executeTool(
    SHEETS_CREATE_SPREADSHEET_TOOL,
    {
      arguments: sheetsCreateSpreadsheetArguments({ title }),
      connectedAccountId: state.connectedAccountId,
    },
  );

  const spreadsheetId = readSpreadsheetId(created.data);
  if (!spreadsheetId) {
    throw upstreamError(
      `Composio ${SHEETS_CREATE_SPREADSHEET_TOOL} answered without a spreadsheet id, so the new spreadsheet cannot be addressed and a retry would create a second one. Check the tool's response shape in readSpreadsheetId() in src/server/connectors/composio/transport.ts, or connect Google directly (npm run connect google).`,
      { logId: created.logId, tool: SHEETS_CREATE_SPREADSHEET_TOOL },
    );
  }

  persistState("google_sheets", deps, {
    // Empty patch, not `null`: the Composio block holds the linked account and
    // must survive writing the spreadsheet id next to it.
    state: {},
    status: row?.status ?? "disconnected",
    lastError: row?.lastError ?? null,
    config: {
      spreadsheetId,
      spreadsheetUrl: spreadsheetWebUrl(spreadsheetId),
    },
  });

  logger.info("Created a Google Sheets spreadsheet through Composio", {
    spreadsheetId,
    title,
  });

  return { spreadsheetId, created: true };
}

/**
 * The lane databases the Composio Notion transport writes into.
 *
 * Same job as `ensureComposioSpreadsheet`, same storage: the ids land in
 * `config.databaseIds`, which is the key the direct adapter reads, so a
 * workspace never ends up with two "Opportunities" databases because the user
 * linked Notion twice. Resolution order per lane is: the stored id, then a
 * database already in the workspace with the lane's title, then — only if
 * `config.parentPageId` names a page shared with the integration — a new one.
 *
 * With every id stored this costs no requests at all.
 */
export async function ensureComposioNotionDatabases(
  deps: ComposioDeps,
): Promise<NotionDatabaseIds> {
  const row = loadRow("notion", deps);
  const config = notionConfigSchema.safeParse(row?.config ?? {});
  const stored: NotionDatabaseIds = config.success
    ? { ...(config.data.databaseIds ?? {}) }
    : {};

  const missing = CONNECTOR_ENTITY_KINDS.filter((kind) => !stored[kind]);
  if (missing.length === 0) return stored;

  if (!composioAvailable(deps)) {
    throw badRequest(notConfiguredMessage("notion"));
  }
  const client = resolveClient(deps);
  const state = readComposioState(row);
  const connectedAccountId = state.connectedAccountId;

  // One listing answers every missing lane, and adopting by title is what
  // keeps a second sync from provisioning duplicates.
  const listed = await client.executeTool(NOTION_FETCH_DATA_TOOL, {
    arguments: notionFetchDatabasesArguments({}),
    connectedAccountId,
  });
  const databases = readNotionDatabases(listed.data);
  if (databases === null) {
    throw upstreamError(
      `Composio ${NOTION_FETCH_DATA_TOOL} returned the workspace's databases in an unreadable shape, so an existing lane database cannot be told from a missing one — provisioning now could duplicate one. Set config.databaseIds for the ${missing.join(", ")} lane(s) explicitly, or connect Notion directly (npm run connect notion).`,
      { logId: listed.logId, tool: NOTION_FETCH_DATA_TOOL },
    );
  }
  const byTitle = new Map(
    databases.map((database) => [database.title.toLowerCase(), database.id]),
  );

  const parentPageId = config.success
    ? (config.data.parentPageId ?? null)
    : null;

  for (const kind of missing) {
    const spec = NOTION_DATABASES[kind];
    const adopted = byTitle.get(spec.title.toLowerCase());
    if (adopted) {
      stored[kind] = adopted;
      continue;
    }

    if (!parentPageId) {
      throw badRequest(
        `Notion over Composio has no "${spec.title}" database for the ${kind} lane, and no page to create it under. Set config.parentPageId on the Notion connector to a page you have shared with the Composio integration in Notion (Settings & Members -> Connections), or set config.databaseIds.${kind} to an existing database id.`,
      );
    }

    const created = await client.executeTool(NOTION_CREATE_DATABASE_TOOL, {
      arguments: notionCreateDatabaseArguments({
        parentPageId,
        title: spec.title,
        properties: composioDatabaseProperties(kind),
      }),
      connectedAccountId,
    });
    const databaseId = readNotionId(created.data);
    if (!databaseId) {
      throw upstreamError(
        `Composio ${NOTION_CREATE_DATABASE_TOOL} answered without a database id for the ${kind} lane, so it cannot be addressed and a retry would create a second one.`,
        { logId: created.logId, tool: NOTION_CREATE_DATABASE_TOOL },
      );
    }
    stored[kind] = databaseId;
    logger.info("Created a Notion lane database through Composio", {
      kind,
      title: spec.title,
      databaseId,
    });
  }

  persistState("notion", deps, {
    // Empty patch, not `null`: the linked account must survive writing the
    // database ids next to it.
    state: {},
    status: row?.status ?? "disconnected",
    lastError: row?.lastError ?? null,
    config: { databaseIds: stored },
  });

  return stored;
}
