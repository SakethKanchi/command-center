/**
 * The direct half of the Sheets write transport: the same Google calls the
 * adapter made inline before, moved behind `SheetsTransport` so the Composio
 * implementation can stand in the one place `push` selects.
 *
 * Nothing about the direct path changed here. Column A is still read once per
 * tab, a known key is still updated in place, unknown keys are still appended
 * in a single call per tab, and an auth failure still aborts the whole push
 * rather than being reported per row.
 */

import type { ConnectorAdapterContext } from "@domain";
import { upstreamError } from "@server/infra/errors";
import type {
  SheetsRowFailure,
  SheetsRowPlacement,
  SheetsRowWrite,
  SheetsTabWrite,
  SheetsTarget,
  SheetsTransport,
} from "../composio/transport";
import {
  appendValues,
  getSpreadsheet,
  getValues,
  isSheetsAuthError,
  parseSheetsConfig,
  parseSheetsCredentials,
  resolveSheetsAccessToken,
  type SheetsConfig,
  spreadsheetWebUrl,
  updateValues,
} from "./api";
import { parseRangeStartRow, rowRange } from "./layout";

/** Explicit config URL wins, so a published/embedded sheet keeps its link. */
export function resolveSpreadsheetUrl(config: SheetsConfig): string {
  const configured = config.spreadsheetUrl?.trim();
  return configured && configured.length > 0
    ? configured
    : spreadsheetWebUrl(config.spreadsheetId);
}

/**
 * `key -> 1-based row number` for a tab, from a single column-A read. Row 1 is
 * the header, and the first occurrence wins if a human duplicated a key.
 */
export function indexKeyColumn(
  values: string[][] | undefined,
): Map<string, number> {
  const index = new Map<string, number>();
  const rows = values ?? [];
  for (let offset = 1; offset < rows.length; offset += 1) {
    const key = rows[offset]?.[0];
    if (typeof key === "string" && key.length > 0 && !index.has(key)) {
      index.set(key, offset + 1);
    }
  }
  return index;
}

/**
 * Resolve the connector's OAuth credentials, refreshing the access token when
 * it is close to expiry and handing the refreshed set back to the caller so
 * the next call skips the round trip.
 */
export async function authorizeSheets(
  ctx: ConnectorAdapterContext,
): Promise<{ token: string; config: SheetsConfig }> {
  const credentials = parseSheetsCredentials(ctx.connector.credentials);
  const config = parseSheetsConfig(ctx.connector.config);
  const resolved = await resolveSheetsAccessToken(credentials, ctx.fetchImpl);

  if (resolved.accessToken !== credentials.accessToken) {
    ctx.onCredentialsRefreshed?.(resolved);
  }
  if (!resolved.accessToken) {
    throw upstreamError("Google Sheets access token could not be resolved.");
  }

  return { token: resolved.accessToken, config };
}

export function createDirectSheetsTransport(
  ctx: ConnectorAdapterContext,
): SheetsTransport {
  /**
   * One authorization per push, whichever method needs it first: the token
   * refresh is a network call, and doing it twice would double it.
   */
  let authorizing: Promise<{ token: string; config: SheetsConfig }> | null =
    null;
  function authorized() {
    authorizing ??= authorizeSheets(ctx);
    return authorizing;
  }

  return {
    mode: "direct",

    async openSpreadsheet() {
      const { token, config } = await authorized();
      const spreadsheet = await getSpreadsheet(
        token,
        ctx.fetchImpl,
        config.spreadsheetId,
      );

      return {
        spreadsheetId: config.spreadsheetId,
        title: spreadsheet.properties.title || null,
        url: resolveSpreadsheetUrl(config),
        tabs: new Map(
          spreadsheet.sheets.map((sheet) => [
            sheet.properties.title,
            sheet.properties.sheetId,
          ]),
        ),
      };
    },

    async writeTab(target: SheetsTarget, tab: SheetsTabWrite) {
      const { token } = await authorized();
      const pending = tab.rows.filter((row) => row.changed);
      const placements: SheetsRowPlacement[] = [];
      const failures: SheetsRowFailure[] = [];

      let keyIndex: Map<string, number>;
      try {
        const keyColumn = await getValues(
          token,
          ctx.fetchImpl,
          target.spreadsheetId,
          `${tab.title}!A:A`,
        );
        keyIndex = indexKeyColumn(keyColumn.values);
      } catch (error) {
        if (isSheetsAuthError(error)) throw error;
        // One unreadable tab must not sink the other three lanes.
        return {
          placements,
          failures: pending.map((row) => ({ key: row.key, cause: error })),
        };
      }

      const appends: SheetsRowWrite[] = [];
      for (const row of pending) {
        const rowNumber = keyIndex.get(row.key);
        if (rowNumber === undefined) {
          appends.push(row);
          continue;
        }
        try {
          await updateValues(
            token,
            ctx.fetchImpl,
            target.spreadsheetId,
            rowRange(tab.title, tab.headers.length, rowNumber),
            [row.cells],
          );
          placements.push({ key: row.key, outcome: "updated", rowNumber });
        } catch (error) {
          if (isSheetsAuthError(error)) throw error;
          failures.push({ key: row.key, cause: error });
        }
      }

      if (appends.length === 0) return { placements, failures };

      try {
        // One append per tab, never one per row.
        const appended = await appendValues(
          token,
          ctx.fetchImpl,
          target.spreadsheetId,
          `${tab.title}!A:A`,
          appends.map((row) => row.cells),
        );
        const startRow = parseRangeStartRow(appended.updates?.updatedRange);
        if (startRow === null) {
          // The rows landed but their identity is unknown, so recording a
          // guessed row number would corrupt the ledger. Reporting a failure
          // lets the next push find the keys in column A and update in place.
          for (const row of appends) {
            failures.push({
              key: row.key,
              cause: upstreamError(
                "Google Sheets append response did not include updates.updatedRange.",
              ),
            });
          }
          return { placements, failures };
        }

        appends.forEach((row, offset) => {
          placements.push({
            key: row.key,
            outcome: "created",
            rowNumber: startRow + offset,
          });
        });
      } catch (error) {
        if (isSheetsAuthError(error)) throw error;
        for (const row of appends) {
          failures.push({ key: row.key, cause: error });
        }
      }

      return { placements, failures };
    },
  };
}
