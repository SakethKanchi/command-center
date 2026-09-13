/**
 * Notion outbound connector: one database per command-center lane, upserted by
 * the row's natural key.
 *
 * Idempotency has two layers. The ledger (`known`) short-circuits rows whose
 * content hash is unchanged so a repeated push performs no remote write at
 * all; for the rows that do change, the lane's `Key` title property is queried
 * in one batched filter to decide update-vs-create. That second layer is what
 * keeps the destination duplicate-free even when the ledger is empty (fresh
 * install, restored backup, or a manually created page).
 */

import {
  CONNECTOR_ENTITY_KINDS,
  type CommandCenterRow,
  type ConnectorAdapter,
  type ConnectorAdapterContext,
  type ConnectorEntityKind,
  type ConnectorHealth,
  type ConnectorPushFailure,
  type ConnectorPushReport,
  type ConnectorPushResult,
  type ConnectorRecord,
  type ConnectorStatus,
} from "@domain";
import { type AppError, badRequest, toAppError } from "@server/infra/errors";
import { logger } from "@server/infra/logger";
import {
  type NotionLaneRef,
  resolveNotionRowTransport,
} from "../composio/transport";
import {
  createDatabase,
  type NotionConfig,
  type NotionDatabaseIds,
  type NotionObject,
  notionConfigSchema,
  notionCredentialsSchema,
  notionUrlFromId,
  plainText,
  retrieveDatabase,
  search,
  searchDatabases,
} from "./api";
import { hashRow, NOTION_DATABASES } from "./properties";
import {
  createDirectNotionRowTransport,
  indexByTitle,
  readNotionToken,
} from "./transport";

export type NotionLaneTarget = {
  kind: ConnectorEntityKind;
  databaseId: string;
  title: string;
  url: string;
};

function readConfig(ctx: ConnectorAdapterContext): NotionConfig {
  const parsed = notionConfigSchema.safeParse(ctx.connector.config ?? {});
  if (!parsed.success) {
    throw badRequest(
      "Notion connector config is malformed: expected { parentPageId?, databaseIds? }.",
      parsed.error.flatten(),
    );
  }
  return parsed.data;
}

function buildHealth(
  ctx: ConnectorAdapterContext,
  args: {
    connected: boolean;
    status: ConnectorStatus;
    target: string | null;
    destinationUrl: string | null;
    lastError: string | null;
  },
): ConnectorHealth {
  return {
    provider: "notion",
    accountKey: ctx.connector.accountKey,
    connected: args.connected,
    status: args.status,
    target: args.target,
    destinationUrl: args.destinationUrl,
    lastSyncedAt: ctx.connector.lastSyncedAt,
    lastError: args.lastError,
  };
}

function toLaneTarget(
  kind: ConnectorEntityKind,
  database: NotionObject,
): NotionLaneTarget {
  const title = plainText(database.title).trim();
  return {
    kind,
    databaseId: database.id,
    title: title === "" ? NOTION_DATABASES[kind].title : title,
    url: database.url ?? notionUrlFromId(database.id),
  };
}

async function resolveLane(args: {
  ctx: ConnectorAdapterContext;
  token: string;
  kind: ConnectorEntityKind;
  config: NotionConfig;
  byTitle: Map<string, NotionObject>;
}): Promise<NotionLaneTarget> {
  const { ctx, token, kind, config } = args;
  const spec = NOTION_DATABASES[kind];
  const configuredId = config.databaseIds?.[kind];

  if (configuredId) {
    try {
      const database = await retrieveDatabase(
        token,
        ctx.fetchImpl,
        configuredId,
      );
      return toLaneTarget(kind, database);
    } catch (error) {
      // A stale id in config should not brick the lane: fall through to the
      // title lookup. Auth failures still propagate.
      if (toAppError(error).code !== "NOT_FOUND") throw error;
      logger.warn("Notion connector lane database id is unreachable", {
        kind,
        databaseId: configuredId,
      });
    }
  }

  const existing = args.byTitle.get(spec.title.toLowerCase());
  if (existing) return toLaneTarget(kind, existing);

  if (!config.parentPageId) {
    throw badRequest(
      `Notion connector cannot provision the "${spec.title}" database: set config.parentPageId to a page shared with the integration, or set config.databaseIds.${kind} to an existing database id.`,
    );
  }

  const created = await createDatabase(
    token,
    ctx.fetchImpl,
    config.parentPageId,
    spec.title,
    spec.properties,
  );
  logger.info("Notion connector provisioned a lane database", {
    kind,
    title: spec.title,
    databaseId: created.id,
  });
  return toLaneTarget(kind, created);
}

/**
 * Resolve (adopting or creating) every lane database. Exported so the service
 * layer can persist the resolved ids back into `connector.config` — the health
 * payload has nowhere to carry them, and persisting means later pushes skip
 * the workspace search entirely.
 */
export async function resolveNotionDatabases(
  ctx: ConnectorAdapterContext,
): Promise<{ targets: NotionLaneTarget[]; databaseIds: NotionDatabaseIds }> {
  const token = readNotionToken(ctx);
  const config = readConfig(ctx);
  // Doubles as the credential check: a bad token fails here with 401.
  const byTitle = indexByTitle(await searchDatabases(token, ctx.fetchImpl));

  const targets: NotionLaneTarget[] = [];
  // Serial on purpose: Notion rate-limits an integration at ~3 requests/second.
  for (const kind of CONNECTOR_ENTITY_KINDS) {
    targets.push(await resolveLane({ ctx, token, kind, config, byTitle }));
  }

  const databaseIds: NotionDatabaseIds = {};
  for (const target of targets) {
    databaseIds[target.kind] = target.databaseId;
  }
  return { targets, databaseIds };
}

export type NotionPushLane = {
  kind: ConnectorEntityKind;
  rows: CommandCenterRow[];
};

function groupByKind(rows: CommandCenterRow[]): NotionPushLane[] {
  const lanes: Record<ConnectorEntityKind, CommandCenterRow[]> = {
    opportunity: [],
    application: [],
    interview: [],
    follow_up: [],
  };
  for (const row of rows) {
    lanes[row.kind].push(row);
  }
  // Fixed lane order keeps a push deterministic for the replay harness.
  return CONNECTOR_ENTITY_KINDS.flatMap((kind) =>
    lanes[kind].length > 0 ? [{ kind, rows: lanes[kind] }] : [],
  );
}

export const notionAdapter: ConnectorAdapter = {
  key: "notion",
  supportedEntityKinds: CONNECTOR_ENTITY_KINDS,

  async connect(ctx: ConnectorAdapterContext): Promise<ConnectorHealth> {
    const { targets } = await resolveNotionDatabases(ctx);
    return buildHealth(ctx, {
      connected: true,
      status: "connected",
      target: targets.map((target) => target.title).join(", "),
      destinationUrl: targets[0]?.url ?? null,
      lastError: null,
    });
  },

  async status(ctx: ConnectorAdapterContext): Promise<ConnectorHealth> {
    try {
      const token = readNotionToken(ctx);
      const config = readConfig(ctx);
      // Cheapest call that proves the token still works.
      await search(token, ctx.fetchImpl, "", {
        property: "object",
        value: "database",
      });

      const configured: Array<{
        kind: ConnectorEntityKind;
        databaseId: string;
      }> = [];
      for (const kind of CONNECTOR_ENTITY_KINDS) {
        const databaseId = config.databaseIds?.[kind];
        if (databaseId) configured.push({ kind, databaseId });
      }

      if (configured.length === 0) {
        return buildHealth(ctx, {
          connected: false,
          status: "disconnected",
          target: null,
          destinationUrl: null,
          lastError:
            "Notion credentials work but no lane databases are provisioned yet — run connect.",
        });
      }

      const targets: NotionLaneTarget[] = [];
      for (const lane of configured) {
        const database = await retrieveDatabase(
          token,
          ctx.fetchImpl,
          lane.databaseId,
        );
        targets.push(toLaneTarget(lane.kind, database));
      }

      return buildHealth(ctx, {
        connected: true,
        status: "connected",
        target: targets.map((target) => target.title).join(", "),
        destinationUrl: targets[0]?.url ?? null,
        lastError: null,
      });
    } catch (error) {
      const appError = toAppError(error);
      logger.warn("Notion connector status check failed", {
        code: appError.code,
        message: appError.message,
      });
      return buildHealth(ctx, {
        connected: false,
        status: appError.code === "INVALID_REQUEST" ? "disconnected" : "error",
        target: null,
        destinationUrl: null,
        lastError: appError.message,
      });
    }
  },

  /**
   * Push rows to the lane databases through whichever transport is
   * configured.
   *
   * The ledger comparison and the per-row failure isolation stay here; the
   * transport decides how a row reaches Notion — a REST page write with the
   * nested property payload, or `NOTION_INSERT_ROW_DATABASE` with the flat
   * one. Both carry the same typed columns, from the same definition.
   */
  async push(
    ctx: ConnectorAdapterContext,
    input: { rows: CommandCenterRow[]; known: Map<string, ConnectorRecord> },
  ): Promise<ConnectorPushReport> {
    const config = readConfig(ctx);
    const transport = resolveNotionRowTransport({
      connector: ctx.connector,
      fetchImpl: ctx.fetchImpl,
      hasDirectCredentials: notionCredentialsSchema.safeParse(
        ctx.connector.credentials ?? {},
      ).success,
      direct: createDirectNotionRowTransport({
        readToken: () => readNotionToken(ctx),
        fetchImpl: ctx.fetchImpl,
      }),
      databaseIds: config.databaseIds ?? null,
    });

    const results: ConnectorPushResult[] = [];
    const failures: ConnectorPushFailure[] = [];
    // Seed the report link from config so even an all-unchanged push (which
    // performs no request at all) still returns a usable destination.
    let destinationUrl: string | null = null;
    for (const kind of CONNECTOR_ENTITY_KINDS) {
      const configuredId = config.databaseIds?.[kind];
      if (configuredId) {
        destinationUrl = notionUrlFromId(configuredId);
        break;
      }
    }

    for (const lane of groupByKind(input.rows)) {
      const planned = lane.rows.map((row) => ({
        row,
        hash: hashRow(row),
        prior: input.known.get(`${row.kind}:${row.key}`),
      }));
      const pending = planned.filter(
        (entry) => entry.prior?.contentHash !== entry.hash,
      );

      // Every row unchanged: no database id to resolve, no query, no write.
      if (pending.length === 0) {
        for (const entry of planned) {
          if (!entry.prior) continue;
          results.push({
            entityKind: lane.kind,
            entityId: entry.row.key,
            outcome: "unchanged",
            remoteId: entry.prior.remoteId,
            remoteUrl: entry.prior.remoteUrl,
          });
        }
        continue;
      }

      let target: NotionLaneRef;
      try {
        target = await transport.openLane({
          kind: lane.kind,
          databaseId: config.databaseIds?.[lane.kind] ?? null,
        });
      } catch (error) {
        const appError = toAppError(error);
        // A dead token or key dooms every lane; a missing database only this one.
        if (appError.code === "UNAUTHORIZED") throw appError;
        for (const entry of planned) {
          failures.push({
            entityKind: lane.kind,
            entityId: entry.row.key,
            errorCode: appError.code,
            errorMessage: appError.message,
          });
        }
        continue;
      }

      destinationUrl ??= notionUrlFromId(target.databaseId);

      let existingPages = new Map<string, string>();
      let lookupError: AppError | null = null;
      try {
        existingPages = await transport.findRowsByKey(
          target,
          pending.map((entry) => entry.row.key),
        );
      } catch (error) {
        const appError = toAppError(error);
        if (appError.code === "UNAUTHORIZED") throw appError;
        lookupError = appError;
      }

      for (const entry of planned) {
        if (entry.prior && entry.prior.contentHash === entry.hash) {
          results.push({
            entityKind: lane.kind,
            entityId: entry.row.key,
            outcome: "unchanged",
            remoteId: entry.prior.remoteId,
            remoteUrl: entry.prior.remoteUrl,
          });
          continue;
        }

        if (lookupError) {
          failures.push({
            entityKind: lane.kind,
            entityId: entry.row.key,
            errorCode: lookupError.code,
            errorMessage: lookupError.message,
          });
          continue;
        }

        try {
          const existingId = existingPages.get(entry.row.key) ?? null;
          const page = await transport.write({
            parentId: target.databaseId,
            title: entry.row.key,
            row: entry.row,
            pageId: existingId,
          });

          results.push({
            entityKind: lane.kind,
            entityId: entry.row.key,
            outcome: page.outcome,
            remoteId: page.id,
            remoteUrl: page.url,
          });
        } catch (error) {
          const appError = toAppError(error);
          if (appError.code === "UNAUTHORIZED") throw appError;
          failures.push({
            entityKind: lane.kind,
            entityId: entry.row.key,
            errorCode: appError.code,
            errorMessage: appError.message,
          });
        }
      }
    }

    return {
      provider: "notion",
      accountKey: ctx.connector.accountKey,
      results,
      failures,
      destinationUrl,
    };
  },

  async disconnect(ctx: ConnectorAdapterContext): Promise<ConnectorHealth> {
    // Deliberately no remote call: the user's databases and pages are theirs,
    // so disconnecting forgets the credential locally and archives nothing.
    return buildHealth(ctx, {
      connected: false,
      status: "disconnected",
      target: null,
      destinationUrl: null,
      lastError: null,
    });
  },
};
