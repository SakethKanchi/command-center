import { createHash } from "node:crypto";
import type {
  CommandCenterRow,
  CommandCenterSnapshot,
  Connector,
  ConnectorAdapterContext,
  ConnectorEntityKind,
  ConnectorHealth,
  ConnectorProvider,
  ConnectorPushReport,
  ConnectorSyncTrigger,
  OutboundEmailRequest,
  OutboundEmailResult,
} from "@domain";
import { nowIso } from "@server/db";
import { badRequest, toAppError } from "@server/infra/errors";
import { logger } from "@server/infra/logger";
import type { RepoBundle } from "@server/repos";
import {
  ensureComposioNotionDatabases,
  ensureComposioSpreadsheet,
  providerAuthMode,
  sendViaComposio,
} from "./composio/service";
import { readComposioState } from "./composio/state";
import { resolveNotionDatabases } from "./notion";
import {
  getLifecycleAdapter,
  isRowConnectorProvider,
  outboundEmailAdapter,
  ROW_CONNECTOR_ADAPTERS,
  ROW_CONNECTOR_PROVIDERS,
  type RowConnectorProvider,
} from "./registry";
import { buildCommandCenterSnapshot } from "./snapshot";

/**
 * Everything this module needs from the outside world, passed in rather than
 * imported: `fetchImpl` is what lets a route or agent test drive a real
 * adapter with no network, and the bundle is what keeps the SQL in one layer.
 */
export type ConnectorDeps = {
  repos: RepoBundle;
  fetchImpl?: typeof fetch;
};

function loadConnected(
  provider: ConnectorProvider,
  accountKey: string,
  deps: ConnectorDeps,
): Connector {
  const connector = deps.repos.connectors.getByProvider(provider, accountKey);
  if (!connector) {
    throw badRequest(
      `Connector ${provider}/${accountKey} is not configured. Run: node scripts/connect.mjs`,
    );
  }
  if (!connector.credentials) {
    throw badRequest(
      `Connector ${provider}/${accountKey} has no credentials. Re-run: node scripts/connect.mjs`,
    );
  }
  return connector;
}

/**
 * Build the adapter context, wiring the refresh hook to the repository so a
 * rotated access token is persisted exactly once per call rather than on every
 * subsequent request.
 */
function buildContext(
  connector: Connector,
  deps: ConnectorDeps,
): ConnectorAdapterContext {
  return {
    connector,
    fetchImpl: deps.fetchImpl ?? fetch,
    onCredentialsRefreshed: (credentials) => {
      try {
        deps.repos.connectors.updateState({ id: connector.id, credentials });
      } catch (error) {
        // A failed persist is not fatal: the call in flight already holds a
        // valid token and the next call simply refreshes again.
        logger.warn("Failed to persist refreshed connector credentials", {
          provider: connector.provider,
          accountKey: connector.accountKey,
          error: toAppError(error).message,
        });
      }
    },
  };
}

export async function connectConnector(
  input: { provider: ConnectorProvider; accountKey?: string },
  deps: ConnectorDeps,
): Promise<ConnectorHealth> {
  const accountKey = input.accountKey ?? "default";
  const connector = loadConnected(input.provider, accountKey, deps);
  const adapter = getLifecycleAdapter(input.provider);

  try {
    const ctx = buildContext(connector, deps);
    const health = await adapter.connect(ctx);

    // Notion resolves (or creates) one database per lane during connect, but
    // `ConnectorHealth` has nowhere to carry those ids. Persisting them into
    // `config` means every later push addresses the databases directly instead
    // of re-searching the workspace on each sync.
    const resolvedConfig =
      input.provider === "notion" && health.connected
        ? {
            ...(connector.config ?? {}),
            databaseIds: (await resolveNotionDatabases(ctx)).databaseIds,
          }
        : undefined;

    deps.repos.connectors.updateState({
      id: connector.id,
      status: health.connected ? "connected" : "error",
      lastError: health.lastError,
      lastConnectedAt: health.connected ? nowIso() : undefined,
      ...(resolvedConfig ? { config: resolvedConfig } : {}),
    });
    return health;
  } catch (error) {
    const appError = toAppError(error);
    deps.repos.connectors.updateState({
      id: connector.id,
      status: "error",
      lastError: appError.message,
    });
    throw appError;
  }
}

export async function getConnectorHealth(
  input: { provider: ConnectorProvider; accountKey?: string },
  deps: ConnectorDeps,
): Promise<ConnectorHealth> {
  const accountKey = input.accountKey ?? "default";
  const connector = deps.repos.connectors.getByProvider(
    input.provider,
    accountKey,
  );

  if (!connector || !connector.credentials) {
    return {
      provider: input.provider,
      accountKey,
      connected: false,
      status: connector?.status ?? "disconnected",
      target: null,
      destinationUrl: null,
      lastSyncedAt: connector?.lastSyncedAt ?? null,
      lastError: connector?.lastError ?? "Not configured",
    };
  }

  const adapter = getLifecycleAdapter(input.provider);
  return adapter.status(buildContext(connector, deps));
}

export async function listConnectorHealth(
  deps: ConnectorDeps,
): Promise<ConnectorHealth[]> {
  const providers: ConnectorProvider[] = [
    ...ROW_CONNECTOR_PROVIDERS,
    "gmail_send",
  ];
  return Promise.all(
    providers.map((provider) =>
      getConnectorHealth({ provider }, deps).catch((error) => ({
        provider,
        accountKey: "default",
        connected: false,
        status: "error" as const,
        target: null,
        destinationUrl: null,
        lastSyncedAt: null,
        lastError: toAppError(error).message,
      })),
    ),
  );
}

export async function disconnectConnector(
  input: { provider: ConnectorProvider; accountKey?: string },
  deps: ConnectorDeps,
): Promise<ConnectorHealth> {
  const accountKey = input.accountKey ?? "default";
  const connector = loadConnected(input.provider, accountKey, deps);
  const adapter = getLifecycleAdapter(input.provider);

  // Revoke remotely first; only drop the local credential once that settles,
  // so a failed revoke does not orphan a live token we can no longer reach.
  const health = await adapter.disconnect(buildContext(connector, deps));
  deps.repos.connectors.disconnect(connector.id);
  return health;
}

function rowsForProvider(
  snapshot: CommandCenterSnapshot,
  kinds: readonly ConnectorEntityKind[],
): CommandCenterRow[] {
  const rows: CommandCenterRow[] = [];
  if (kinds.includes("opportunity")) rows.push(...snapshot.opportunities);
  if (kinds.includes("application")) rows.push(...snapshot.applications);
  if (kinds.includes("interview")) rows.push(...snapshot.interviews);
  if (kinds.includes("follow_up")) rows.push(...snapshot.followUps);
  return rows;
}

export type PushCommandCenterResult = {
  reports: ConnectorPushReport[];
  snapshot: CommandCenterSnapshot;
  /** Providers skipped because they are not configured, with the reason. */
  skipped: Array<{ provider: ConnectorProvider; reason: string }>;
};

/**
 * Push the current command center to every requested row destination.
 *
 * Each provider gets its own sync-run row and its own ledger update, so one
 * destination failing never blocks the others and the dashboard can show which
 * app is behind.
 */
export async function pushCommandCenter(
  input: {
    providers?: RowConnectorProvider[];
    trigger?: ConnectorSyncTrigger;
    snapshot?: CommandCenterSnapshot;
    limit?: number;
    minScore?: number;
  },
  deps: ConnectorDeps,
): Promise<PushCommandCenterResult> {
  const providers = input.providers ?? ROW_CONNECTOR_PROVIDERS;
  const trigger = input.trigger ?? "manual";
  const snapshot =
    input.snapshot ??
    buildCommandCenterSnapshot(deps.repos, {
      limit: input.limit,
      minScore: input.minScore,
    });

  const reports: ConnectorPushReport[] = [];
  const skipped: PushCommandCenterResult["skipped"] = [];

  for (const provider of providers) {
    if (!isRowConnectorProvider(provider)) {
      skipped.push({ provider, reason: "Provider does not accept row pushes" });
      continue;
    }

    let connector = deps.repos.connectors.getByProvider(provider, "default");
    const mode = providerAuthMode(provider, { repos: deps.repos });
    if (!connector || !mode) {
      skipped.push({ provider, reason: "Not configured" });
      continue;
    }
    if (mode === "composio") {
      // A key in the environment is not a linked account: without consent
      // every row would fail with Composio's own wording, which reads like a
      // bug rather than an unfinished setup.
      const state = readComposioState(connector);
      if (!state.connectedAccountId || state.linkState !== "active") {
        skipped.push({
          provider,
          reason:
            "Composio link not finished — click Connect on the Apps page and complete the consent screen",
        });
        continue;
      }
      // Resolve and persist the destination before the adapter runs: the ids
      // then survive a failure mid-push, and the adapter reads them off the
      // row it is handed, so re-reading the row here is load-bearing.
      const composioDeps = {
        repos: deps.repos,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      };
      if (provider === "google_sheets") {
        await ensureComposioSpreadsheet(composioDeps);
      } else {
        await ensureComposioNotionDatabases(composioDeps);
      }
      connector =
        deps.repos.connectors.getByProvider(provider, "default") ?? connector;
    }

    const adapter = ROW_CONNECTOR_ADAPTERS[provider];
    const rows = rowsForProvider(snapshot, adapter.supportedEntityKinds);
    const run = deps.repos.connectors.startSyncRun({
      connectorId: connector.id,
      provider,
      accountKey: connector.accountKey,
      trigger,
    });

    try {
      const known = deps.repos.connectors.getRecords(connector.id);
      const report = await adapter.push(buildContext(connector, deps), {
        rows,
        known,
      });

      // Persist the ledger for rows that actually landed. `unchanged` rows keep
      // their existing entry, so re-pushing stays a no-op.
      const rowByKey = new Map(rows.map((row) => [row.key, row]));
      const written = report.results.filter(
        (result) => result.outcome !== "unchanged",
      );
      if (written.length > 0) {
        deps.repos.connectors.upsertRecords(
          connector.id,
          written.map((result) => {
            const row = rowByKey.get(result.entityId);
            if (!row) {
              throw badRequest(
                `Adapter ${provider} reported entityId ${result.entityId}, which is not in the pushed snapshot.`,
              );
            }
            return {
              entityKind: result.entityKind,
              entityId: result.entityId,
              remoteId: result.remoteId,
              remoteUrl: result.remoteUrl,
              contentHash: hashCommandCenterRow(row),
            };
          }),
        );
      }

      const counts = {
        considered: rows.length,
        created: report.results.filter((r) => r.outcome === "created").length,
        updated: report.results.filter((r) => r.outcome === "updated").length,
        unchanged: report.results.filter((r) => r.outcome === "unchanged")
          .length,
        failed: report.failures.length,
      };

      // A run where some rows landed is `completed` with `recordsFailed > 0`;
      // `failed` is reserved for a run that achieved nothing. The status
      // vocabulary has no "partial", and the CHECK constraint rejects anything
      // outside running/completed/failed/cancelled.
      const landedNothing =
        report.results.length === 0 && report.failures.length > 0;
      deps.repos.connectors.finishSyncRun({
        id: run.id,
        status: landedNothing ? "failed" : "completed",
        recordsConsidered: counts.considered,
        recordsCreated: counts.created,
        recordsUpdated: counts.updated,
        recordsUnchanged: counts.unchanged,
        recordsFailed: counts.failed,
      });
      deps.repos.connectors.updateState({
        id: connector.id,
        lastSyncedAt: nowIso(),
        lastError:
          report.failures.length > 0
            ? `${report.failures.length} row(s) failed to sync`
            : null,
      });

      logger.info("Connector push completed", { provider, ...counts });
      reports.push(report);
    } catch (error) {
      const appError = toAppError(error);
      deps.repos.connectors.finishSyncRun({
        id: run.id,
        status: "failed",
        recordsConsidered: rows.length,
        recordsCreated: 0,
        recordsUpdated: 0,
        recordsUnchanged: 0,
        recordsFailed: rows.length,
        errorCode: appError.code,
        errorMessage: appError.message,
      });
      deps.repos.connectors.updateState({
        id: connector.id,
        status: "error",
        lastError: appError.message,
      });
      logger.error("Connector push failed", {
        provider,
        error: appError.message,
      });
      reports.push({
        provider,
        accountKey: connector.accountKey,
        results: [],
        failures: rows.map((row) => ({
          entityKind: row.kind,
          entityId: row.key,
          errorCode: appError.code,
          errorMessage: appError.message,
        })),
        destinationUrl: null,
      });
    }
  }

  return { reports, snapshot, skipped };
}

/**
 * Canonical row hash shared by the ledger and every adapter.
 *
 * Keys are sorted before serialization so field ordering cannot change the
 * digest; that is what makes "unchanged" a reliable verdict rather than an
 * accident of object construction order.
 *
 * The comparison is deliberately by UTF-16 code unit, not `localeCompare`:
 * locale collation varies by ICU data and environment, which would make the
 * same row hash differently on two machines and defeat the whole ledger.
 * Both row adapters pin the identical comparator.
 */
export function hashCommandCenterRow(row: CommandCenterRow): string {
  const sorted = Object.fromEntries(
    Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

export async function sendOutboundEmail(
  request: OutboundEmailRequest,
  deps: ConnectorDeps,
): Promise<OutboundEmailResult> {
  // Gmail has two transports and the send path only knew about one, so a
  // Composio-linked account failed with "no credentials" — a direct-OAuth
  // message for an account that never uses direct OAuth. Branch on the same
  // resolver the push path uses so the two cannot disagree.
  if (providerAuthMode("gmail_send", { repos: deps.repos }) === "composio") {
    return await sendViaComposio(request, {
      repos: deps.repos,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    });
  }
  const connector = loadConnected("gmail_send", "default", deps);
  const result = await outboundEmailAdapter.send(
    buildContext(connector, deps),
    request,
  );
  deps.repos.connectors.updateState({
    id: connector.id,
    lastSyncedAt: nowIso(),
    lastError: null,
  });
  return result;
}
