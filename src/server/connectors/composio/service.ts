/**
 * Provider-facing Composio operations: start a hosted consent link, poll it,
 * revoke it, and send through it.
 *
 * Persistence is the existing connectors repo — same table, same row, same
 * `ConnectorHealth` shape as the direct adapters. Composio is the fallback
 * transport, not a parallel world.
 */

import type {
  Connector,
  ConnectorAuthMode,
  ConnectorHealth,
  ConnectorProvider,
  ConnectorStatus,
  OutboundEmailRequest,
  OutboundEmailResult,
} from "@domain";
import { nowIso } from "@server/db";
import { badRequest, toAppError, upstreamError } from "@server/infra/errors";
import { logger } from "@server/infra/logger";
import type { RepoBundle } from "@server/repos";
import { createPage, updatePage } from "../notion/api";
import { NOTION_KEY_PROPERTY } from "../notion/properties";
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
  notionUrlFor,
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
    accountId =
      accounts.find((account) => account.status === "ACTIVE")?.id ??
      accounts[0]?.id ??
      null;
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
  const label = account.userId ?? account.toolkitSlug ?? toolkit.toolkitSlug;
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
 * `notion/api.ts` primitives the existing adapter pushes through.
 */
export function createDirectNotionTransport(args: {
  token: string;
  fetchImpl: typeof fetch;
}): NotionPageTransport {
  return {
    mode: "direct",

    async write(input) {
      const properties = input.properties ?? {
        [NOTION_KEY_PROPERTY]: {
          title: [{ text: { content: input.title } }],
        },
      };

      if (input.pageId) {
        const page = await updatePage(
          args.token,
          args.fetchImpl,
          input.pageId,
          properties,
        );
        return {
          id: page.id,
          url: page.url ?? notionUrlFor(page.id),
          outcome: "updated",
        };
      }

      const page = await createPage(
        args.token,
        args.fetchImpl,
        input.parentId,
        properties,
      );
      return {
        id: page.id,
        url: page.url ?? notionUrlFor(page.id),
        outcome: "created",
      };
    },
  };
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
