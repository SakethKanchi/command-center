/**
 * Google Sheets command-center connector.
 *
 * The spreadsheet is the shared artifact a human actually looks at, so writes
 * are conservative: column A holds each row's natural key, and a row whose
 * content hash matches the ledger is never rewritten.
 *
 * `push` selects a transport rather than calling Google itself. The direct
 * implementation (`sheets/transport.ts`) reads column A once per tab and
 * updates in place or appends once; the Composio implementation
 * (`composio/transport.ts`) executes `GOOGLESHEETS_VALUES_UPDATE`, needing no
 * OAuth token of our own. Direct wins whenever the connector row holds
 * credentials, so nothing about a directly connected setup changed.
 */

import type {
  ConnectorAdapter,
  ConnectorAdapterContext,
  ConnectorEntityKind,
  ConnectorHealth,
  ConnectorPushFailure,
  ConnectorPushReport,
  ConnectorPushResult,
  ConnectorStatus,
} from "@domain";
import { CONNECTOR_ENTITY_KINDS } from "@domain";
import { conflict, toAppError } from "@server/infra/errors";
import { logger } from "@server/infra/logger";
import {
  resolveSheetsTransport,
  type SheetsRowWrite,
} from "../composio/transport";
import {
  batchUpdate,
  getSpreadsheet,
  getValues,
  parseSheetsConfig,
  sheetsConfigSchema,
  sheetsCredentialsSchema,
  updateValues,
} from "./api";
import {
  hashRow,
  parseRangeStartRow,
  renderRow,
  rowRange,
  SHEET_TABS,
} from "./layout";
import {
  authorizeSheets,
  createDirectSheetsTransport,
  resolveSpreadsheetUrl,
} from "./transport";

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
    provider: "google_sheets",
    accountKey: ctx.connector.accountKey,
    connected: args.connected,
    status: args.status,
    target: args.target,
    destinationUrl: args.destinationUrl,
    lastSyncedAt: ctx.connector.lastSyncedAt,
    lastError: args.lastError,
  };
}

/** Best-effort destination link for paths that must not throw on bad config. */
function destinationUrlOrNull(config: unknown): string | null {
  const parsed = sheetsConfigSchema.safeParse(config);
  return parsed.success ? resolveSpreadsheetUrl(parsed.data) : null;
}

function toFailure(
  entityKind: ConnectorEntityKind,
  entityId: string,
  error: unknown,
): ConnectorPushFailure {
  const appError = toAppError(error);
  return {
    entityKind,
    entityId,
    errorCode: appError.code,
    errorMessage: appError.message,
  };
}

/** Deep link to a single row: the sheet's gid plus an A-column selection. */
function rowWebUrl(
  baseUrl: string,
  sheetId: number | null,
  rowNumber: number,
): string {
  const [base] = baseUrl.split("#");
  const selection = `range=A${rowNumber}`;
  return sheetId === null
    ? `${base}#${selection}`
    : `${base}#gid=${sheetId}&${selection}`;
}

export const googleSheetsAdapter: ConnectorAdapter = {
  key: "google_sheets",
  supportedEntityKinds: CONNECTOR_ENTITY_KINDS,

  async connect(ctx: ConnectorAdapterContext): Promise<ConnectorHealth> {
    const { token, config } = await authorizeSheets(ctx);
    const spreadsheet = await getSpreadsheet(
      token,
      ctx.fetchImpl,
      config.spreadsheetId,
    );

    const presentTitles = new Set(
      spreadsheet.sheets.map((sheet) => sheet.properties.title),
    );
    const missingKinds = CONNECTOR_ENTITY_KINDS.filter(
      (kind) => !presentTitles.has(SHEET_TABS[kind].title),
    );

    if (missingKinds.length > 0) {
      await batchUpdate(
        token,
        ctx.fetchImpl,
        config.spreadsheetId,
        missingKinds.map((kind) => ({
          addSheet: { properties: { title: SHEET_TABS[kind].title } },
        })),
      );
      logger.info("Google Sheets connector created command center tabs", {
        connectorId: ctx.connector.id,
        tabs: missingKinds.map((kind) => SHEET_TABS[kind].title),
      });
    }

    const createdTitles = new Set(
      missingKinds.map((kind) => SHEET_TABS[kind].title),
    );

    for (const kind of CONNECTOR_ENTITY_KINDS) {
      const tab = SHEET_TABS[kind];
      const headerRange = rowRange(tab.title, tab.headers.length, 1);

      if (!createdTitles.has(tab.title)) {
        const current = await getValues(
          token,
          ctx.fetchImpl,
          config.spreadsheetId,
          headerRange,
        );
        const firstRow = current.values?.[0] ?? [];
        const alreadyCorrect = tab.headers.every(
          (header, column) => (firstRow[column] ?? "").trim() === header,
        );
        if (alreadyCorrect) continue;
      }

      await updateValues(
        token,
        ctx.fetchImpl,
        config.spreadsheetId,
        headerRange,
        [tab.headers],
      );
    }

    return buildHealth(ctx, {
      connected: true,
      status: "connected",
      target: spreadsheet.properties.title || null,
      destinationUrl: resolveSpreadsheetUrl(config),
      lastError: null,
    });
  },

  async status(ctx: ConnectorAdapterContext): Promise<ConnectorHealth> {
    try {
      const { token, config } = await authorizeSheets(ctx);
      const spreadsheet = await getSpreadsheet(
        token,
        ctx.fetchImpl,
        config.spreadsheetId,
      );
      return buildHealth(ctx, {
        connected: true,
        status: "connected",
        target: spreadsheet.properties.title || null,
        destinationUrl: resolveSpreadsheetUrl(config),
        lastError: null,
      });
    } catch (error) {
      // A status probe reports; it never crashes the dashboard that called it.
      const appError = toAppError(error);
      logger.warn("Google Sheets connector status check failed", {
        connectorId: ctx.connector.id,
        code: appError.code,
        message: appError.message,
      });
      return buildHealth(ctx, {
        connected: false,
        status: "error",
        target: null,
        destinationUrl: destinationUrlOrNull(ctx.connector.config),
        lastError: appError.message,
      });
    }
  },

  /**
   * Push rows to the spreadsheet through whichever transport is configured.
   *
   * The ledger comparison, the duplicate-key refusal and the row deep links
   * stay here, because they are the same whichever transport runs. What the
   * transport decides is how a row reaches the sheet — updated in place from a
   * column-A read, or as part of a whole-tab replace.
   */
  async push(
    ctx: ConnectorAdapterContext,
    input: Parameters<ConnectorAdapter["push"]>[1],
  ): Promise<ConnectorPushReport> {
    const config = sheetsConfigSchema.safeParse(ctx.connector.config);
    const transport = resolveSheetsTransport({
      connector: ctx.connector,
      fetchImpl: ctx.fetchImpl,
      hasDirectCredentials: sheetsCredentialsSchema.safeParse(
        ctx.connector.credentials ?? {},
      ).success,
      direct: createDirectSheetsTransport(ctx),
      // Same stored id either way: the Composio path writes into the
      // spreadsheet the direct path would have written into.
      spreadsheetId: config.success ? config.data.spreadsheetId : null,
      spreadsheetUrl: config.success
        ? (config.data.spreadsheetUrl ?? null)
        : null,
    });

    const target = await transport.openSpreadsheet();
    const baseUrl = target.url;
    const results: ConnectorPushResult[] = [];
    const failures: ConnectorPushFailure[] = [];

    // Highest row this connector has already written in each tab. Rows that
    // have since disappeared from the snapshot still count — they are exactly
    // the ones a whole-tab replace has to blank out, so reading only the rows
    // being pushed would leave them on the sheet for good.
    const previousExtents = new Map<ConnectorEntityKind, number>();
    for (const record of input.known.values()) {
      previousExtents.set(
        record.entityKind,
        Math.max(
          previousExtents.get(record.entityKind) ?? 0,
          parseRangeStartRow(record.remoteId) ?? 0,
        ),
      );
    }

    for (const kind of CONNECTOR_ENTITY_KINDS) {
      const rows = input.rows.filter((row) => row.kind === kind);
      if (rows.length === 0) continue;

      const tab = SHEET_TABS[kind];
      const sheetId = target.tabs?.get(tab.title) ?? null;
      const ledgerFor = (key: string) => input.known.get(`${kind}:${key}`);

      const writes: SheetsRowWrite[] = [];
      const seenKeys = new Set<string>();
      for (const row of rows) {
        if (seenKeys.has(row.key)) {
          // Two rows sharing a key in one push would append twice and leave
          // the lane permanently ambiguous, so the repeat is refused.
          failures.push(
            toFailure(
              kind,
              row.key,
              conflict(
                `Duplicate key ${row.key} in the ${tab.title} rows of a single push.`,
              ),
            ),
          );
          continue;
        }
        seenKeys.add(row.key);

        const known = ledgerFor(row.key);
        writes.push({
          key: row.key,
          cells: renderRow(row),
          changed: !known || known.contentHash !== hashRow(row),
          tracked: known !== undefined,
        });
      }

      /** Ledger verdict for a row no transport touched. */
      const reportUnchanged = (key: string) => {
        const known = ledgerFor(key);
        results.push({
          entityKind: kind,
          entityId: key,
          outcome: "unchanged",
          remoteId: known?.remoteId ?? `${tab.title}!A1`,
          remoteUrl: known?.remoteUrl ?? null,
        });
      };

      // Ledger check first: a tab where nothing changed costs zero calls.
      if (!writes.some((row) => row.changed)) {
        for (const row of writes) reportUnchanged(row.key);
        continue;
      }

      const written = await transport.writeTab(target, {
        title: tab.title,
        headers: tab.headers,
        rows: writes,
        previousExtent: previousExtents.get(kind) ?? 0,
      });

      const touched = new Set<string>([
        ...written.placements.map((placement) => placement.key),
        ...written.failures.map((failure) => failure.key),
      ]);
      for (const row of writes) {
        if (!touched.has(row.key)) reportUnchanged(row.key);
      }
      for (const placement of written.placements) {
        results.push({
          entityKind: kind,
          entityId: placement.key,
          outcome: placement.outcome,
          remoteId: `${tab.title}!A${placement.rowNumber}`,
          remoteUrl: rowWebUrl(baseUrl, sheetId, placement.rowNumber),
        });
      }
      for (const failure of written.failures) {
        failures.push(toFailure(kind, failure.key, failure.cause));
      }
    }

    return {
      provider: "google_sheets",
      accountKey: ctx.connector.accountKey,
      results,
      failures,
      destinationUrl: baseUrl,
    };
  },

  async disconnect(ctx: ConnectorAdapterContext): Promise<ConnectorHealth> {
    // Deliberately no remote call: the spreadsheet is the user's data and
    // survives disconnecting.
    return buildHealth(ctx, {
      connected: false,
      status: "disconnected",
      target: null,
      destinationUrl: destinationUrlOrNull(ctx.connector.config),
      lastError: null,
    });
  },
};
