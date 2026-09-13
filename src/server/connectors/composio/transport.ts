/**
 * The one place that decides how a connector's outbound calls are authorized.
 *
 * Precedence is fixed and deliberate:
 *
 *   1. direct credentials on the connector row  -> the existing direct adapter
 *   2. otherwise, COMPOSIO_API_KEY is set       -> Composio tool execution
 *   3. otherwise                                -> not configured, both named
 *
 * Direct wins because those implementations talk to Google and Notion
 * first-hand; Composio exists so the app is still connectable without a Google
 * Cloud project. Every transport below is selected through `resolveAuthMode`,
 * so there is exactly one predicate to read and exactly one to change.
 */

import type {
  Connector,
  ConnectorAuthMode,
  ConnectorProvider,
  OutboundEmailRequest,
  OutboundEmailResult,
} from "@domain";
import { nowIso } from "@server/db";
import {
  AppError,
  badRequest,
  toAppError,
  upstreamError,
} from "@server/infra/errors";
import { logger } from "@server/infra/logger";
import { z } from "zod";
import { isSheetsAuthError, spreadsheetWebUrl } from "../sheets/api";
import { columnLetter } from "../sheets/layout";
import type { ComposioClient } from "./client";
import { COMPOSIO_DASHBOARD_URL, createComposioClient } from "./client";
import { readComposioState } from "./state";
import {
  GMAIL_SEND_EMAIL_TOOL,
  gmailSendArguments,
  NOTION_ADD_PAGE_CONTENT_TOOL,
  NOTION_CREATE_PAGE_TOOL,
  notionAddContentArguments,
  notionCreatePageArguments,
  SHEETS_ADD_SHEET_TOOL,
  SHEETS_GET_SHEET_NAMES_TOOL,
  SHEETS_VALUES_UPDATE_TOOL,
  sheetsAddSheetArguments,
  sheetsGetSheetNamesArguments,
  sheetsValuesUpdateArguments,
} from "./toolkits";

/** The direct path for each provider, quoted in every not-configured message. */
const DIRECT_SETUP_COMMAND: Record<ConnectorProvider, string> = {
  google_sheets: "npm run connect google",
  gmail_send: "npm run connect google",
  notion: "npm run connect notion",
};

export function hasComposioApiKey(apiKey?: string | null): boolean {
  return (apiKey ?? process.env.COMPOSIO_API_KEY ?? "").trim() !== "";
}

/**
 * THE predicate. Both inputs are booleans so this stays pure and every caller
 * decides "is Composio usable here" in its own terms — an env var for the
 * adapter, an injected client for a test, plus toolkit support for a provider.
 *
 * `null` means neither transport is available. Callers that only report
 * (health probes) branch on it; callers that must act use `requireAuthMode`.
 */
export function resolveAuthMode(args: {
  hasDirectCredentials: boolean;
  hasComposio: boolean;
}): ConnectorAuthMode | null {
  if (args.hasDirectCredentials) return "direct";
  return args.hasComposio ? "composio" : null;
}

/**
 * Both routes, in the order they are preferred, for every provider. This used
 * to overstate Composio for `google_sheets` — it named the key for a provider
 * that had no Composio transport at all, so following the hint got the user a
 * linked account they still could not write through. Sheets now writes through
 * `GOOGLESHEETS_VALUES_UPDATE` like the other two write through their tools, so
 * both halves of this sentence are true for all three.
 */
export function notConfiguredMessage(provider: ConnectorProvider): string {
  return `${provider} is not connected. Two ways in: connect it directly (${DIRECT_SETUP_COMMAND[provider]}), or set COMPOSIO_API_KEY in .env and click Connect — a free key from ${COMPOSIO_DASHBOARD_URL} authorizes it in Composio's own consent flow, with no Google Cloud project and no client secret in this repo.`;
}

export function requireAuthMode(args: {
  provider: ConnectorProvider;
  hasDirectCredentials: boolean;
  hasComposio: boolean;
}): ConnectorAuthMode {
  const mode = resolveAuthMode(args);
  if (!mode) throw badRequest(notConfiguredMessage(args.provider));
  return mode;
}

// ---------------------------------------------------------------------------
// Gmail send transport
// ---------------------------------------------------------------------------

/**
 * The outbound half of the Gmail connector, behind one interface so the direct
 * implementation in `gmail-send/index.ts` and the Composio one below are
 * interchangeable at the single call site in the adapter.
 */
export type GmailSendTransport = {
  readonly mode: ConnectorAuthMode;
  send(request: OutboundEmailRequest): Promise<OutboundEmailResult>;
};

/**
 * Gmail's own send response, forwarded by Composio under `data`. Composio
 * nests the provider payload one level deep on some tools, hence the union.
 */
const gmailSendDataSchema = z.union([
  z.object({
    id: z.string().min(1),
    threadId: z.string().nullish(),
  }),
  z.object({
    response_data: z.object({
      id: z.string().min(1),
      threadId: z.string().nullish(),
    }),
  }),
]);

export function createComposioGmailTransport(args: {
  client: ComposioClient;
  connectedAccountId?: string | null;
}): GmailSendTransport {
  return {
    mode: "composio",

    async send(request) {
      if (request.attachments && request.attachments.length > 0) {
        // Composio takes attachments as an uploaded file reference, not a local
        // path. Failing here is better than silently dropping the resume from a
        // live application email.
        throw badRequest(
          "Attachments are not supported over the Composio Gmail transport yet. Connect Gmail directly (npm run connect google) to send a résumé attachment.",
        );
      }

      const result = await args.client.executeTool(GMAIL_SEND_EMAIL_TOOL, {
        arguments: gmailSendArguments({
          to: request.to.trim(),
          subject: request.subject,
          body: request.body,
        }),
        connectedAccountId: args.connectedAccountId ?? null,
      });

      const parsed = gmailSendDataSchema.safeParse(result.data);
      if (!parsed.success) {
        throw upstreamError(
          `Composio ${GMAIL_SEND_EMAIL_TOOL} returned no Gmail message id, so the send cannot be confirmed.`,
          { logId: result.logId },
        );
      }
      const sent =
        "response_data" in parsed.data
          ? parsed.data.response_data
          : parsed.data;

      return {
        messageId: sent.id,
        threadId: sent.threadId ?? request.threadId ?? sent.id,
        to: request.to.trim(),
        subject: request.subject,
        sentAt: nowIso(),
        webUrl: `https://mail.google.com/mail/u/0/#all/${sent.id}`,
      };
    },
  };
}

/**
 * The single selection point for Gmail's outbound transport.
 *
 * The direct implementation is passed in rather than imported, because it
 * lives in `gmail-send/index.ts` alongside the credential schema it needs —
 * importing it here would be a cycle, and duplicating the predicate is the
 * bug this function exists to prevent.
 */
export function resolveGmailSendTransport(args: {
  connector: Connector;
  fetchImpl: typeof fetch;
  hasDirectCredentials: boolean;
  direct: GmailSendTransport;
  apiKey?: string | null;
}): GmailSendTransport {
  const mode = requireAuthMode({
    provider: "gmail_send",
    hasDirectCredentials: args.hasDirectCredentials,
    hasComposio: hasComposioApiKey(args.apiKey),
  });
  if (mode === "direct") return args.direct;

  const state = readComposioState(args.connector);
  return createComposioGmailTransport({
    client: createComposioClient({
      fetchImpl: args.fetchImpl,
      apiKey: args.apiKey,
    }),
    connectedAccountId: state.connectedAccountId,
  });
}

// ---------------------------------------------------------------------------
// Notion page transport
// ---------------------------------------------------------------------------

export type NotionPageWrite = {
  /** Database or page the new page hangs under. Ignored when updating. */
  parentId: string;
  title: string;
  /** Notion property payload; only the direct transport can apply it. */
  properties?: Record<string, unknown>;
  /** Body text appended to the page. */
  content?: string | null;
  /** Present ⇒ update that page instead of creating one. */
  pageId?: string | null;
};

export type NotionPageRef = {
  id: string;
  url: string;
  outcome: "created" | "updated";
};

/**
 * The outbound half of the Notion connector: write one page. The direct
 * implementation is built from `notion/api.ts` primitives (see
 * `createDirectNotionTransport` in `service.ts`), the Composio one is below.
 */
export type NotionPageTransport = {
  readonly mode: ConnectorAuthMode;
  write(input: NotionPageWrite): Promise<NotionPageRef>;
};

const notionPageDataSchema = z.union([
  z.object({ id: z.string().min(1), url: z.string().nullish() }),
  z.object({
    response_data: z.object({
      id: z.string().min(1),
      url: z.string().nullish(),
    }),
  }),
]);

export function notionUrlFor(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, "")}`;
}

export function createComposioNotionTransport(args: {
  client: ComposioClient;
  connectedAccountId?: string | null;
}): NotionPageTransport {
  return {
    mode: "composio",

    async write(input) {
      if (input.pageId) {
        // Composio's update path appends blocks rather than rewriting
        // properties, so an update with no body has nothing to send.
        const content = input.content?.trim();
        if (!content) {
          return {
            id: input.pageId,
            url: notionUrlFor(input.pageId),
            outcome: "updated",
          };
        }
        await args.client.executeTool(NOTION_ADD_PAGE_CONTENT_TOOL, {
          arguments: notionAddContentArguments({
            pageId: input.pageId,
            content,
          }),
          connectedAccountId: args.connectedAccountId ?? null,
        });
        return {
          id: input.pageId,
          url: notionUrlFor(input.pageId),
          outcome: "updated",
        };
      }

      const created = await args.client.executeTool(NOTION_CREATE_PAGE_TOOL, {
        arguments: notionCreatePageArguments({
          parentId: input.parentId,
          title: input.title,
        }),
        connectedAccountId: args.connectedAccountId ?? null,
      });

      const parsed = notionPageDataSchema.safeParse(created.data);
      if (!parsed.success) {
        throw upstreamError(
          `Composio ${NOTION_CREATE_PAGE_TOOL} returned no page id, so the write cannot be confirmed.`,
          { logId: created.logId },
        );
      }
      const page =
        "response_data" in parsed.data
          ? parsed.data.response_data
          : parsed.data;

      const body = input.content?.trim();
      if (body) {
        await args.client.executeTool(NOTION_ADD_PAGE_CONTENT_TOOL, {
          arguments: notionAddContentArguments({
            pageId: page.id,
            content: body,
          }),
          connectedAccountId: args.connectedAccountId ?? null,
        });
      }

      return {
        id: page.id,
        url: page.url ?? notionUrlFor(page.id),
        outcome: "created",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Google Sheets tab transport
// ---------------------------------------------------------------------------

/** One rendered command-center row, addressed by its column-A natural key. */
export type SheetsRowWrite = {
  key: string;
  /** Cells aligned to the tab's headers, from `renderRow`. */
  cells: string[];
  /** The row differs from the ledger, so its cells have to reach the sheet. */
  changed: boolean;
  /** The ledger already holds a remote row for this key. */
  tracked: boolean;
};

export type SheetsTabWrite = {
  /** Tab title, e.g. `Opportunities`. */
  title: string;
  /** Header row, from the same column table `renderRow` renders cells from. */
  headers: string[];
  /** Every row of the tab, in snapshot order. */
  rows: SheetsRowWrite[];
  /**
   * Highest row number this connector has already written in the tab, read
   * from the ledger. A whole-tab replace blanks down to it, so a lane that
   * shrank from forty rows to twelve leaves no ghosts behind; 0 means the
   * connector has never written the tab.
   */
  previousExtent: number;
};

export type SheetsRowPlacement = {
  key: string;
  outcome: "created" | "updated";
  /** 1-based row the cells landed on; row 1 is the header. */
  rowNumber: number;
};

/** A row that did not land. `cause` keeps its `AppError` code and message. */
export type SheetsRowFailure = { key: string; cause: unknown };

export type SheetsTabResult = {
  /** Rows written, in the order they were written. */
  placements: SheetsRowPlacement[];
  /** Rows that failed; the remaining lanes still run. */
  failures: SheetsRowFailure[];
};

/** The spreadsheet both transports write into. */
export type SheetsTarget = {
  spreadsheetId: string;
  /** Spreadsheet title, when the transport can see it. */
  title: string | null;
  /** Canonical deep link, used as the push report's destination. */
  url: string;
  /**
   * Tabs that exist right now: title -> numeric sheet id, or null when the
   * transport cannot see ids (Composio lists names only). `null` for the whole
   * map means the tab list could not be read at all, which is not the same as
   * "there are no tabs" and must not be treated as one.
   */
  tabs: Map<string, number | null> | null;
};

/**
 * The outbound half of the Sheets connector: resolve the spreadsheet, then
 * write one tab at a time. This is the smallest surface `push` needs, and it
 * is deliberately tab-shaped rather than cell-shaped, because the two
 * transports disagree about granularity: the direct one reads column A and
 * updates single rows in place, and Composio has no non-deprecated
 * read-values tool, so it replaces the tab's contents. Both answer the same
 * question — where did each row land — which is all the ledger needs.
 */
export type SheetsTransport = {
  readonly mode: ConnectorAuthMode;
  openSpreadsheet(): Promise<SheetsTarget>;
  writeTab(target: SheetsTarget, tab: SheetsTabWrite): Promise<SheetsTabResult>;
};

/** A tab title, in each of the shapes Composio has been seen to answer with. */
const sheetTitleSchema = z.union([
  z.string().min(1),
  z.object({ title: z.string().min(1) }),
  z.object({ name: z.string().min(1) }),
  z.object({ sheet_name: z.string().min(1) }),
  z.object({ properties: z.object({ title: z.string().min(1) }) }),
]);

const sheetNamesDataSchema = z.union([
  z.array(sheetTitleSchema),
  z.object({ sheetNames: z.array(sheetTitleSchema) }),
  z.object({ sheet_names: z.array(sheetTitleSchema) }),
  z.object({ sheets: z.array(sheetTitleSchema) }),
]);

const spreadsheetIdSchema = z.union([
  z.object({ spreadsheetId: z.string().min(1) }),
  z.object({ spreadsheet_id: z.string().min(1) }),
]);

/** Composio nests the provider payload under `response_data` on some tools. */
function unwrapToolData(data: unknown): unknown {
  if (data && typeof data === "object" && "response_data" in data) {
    return data.response_data;
  }
  return data;
}

/** The spreadsheet id a create answered with, in either casing. */
export function readSpreadsheetId(data: unknown): string | null {
  const parsed = spreadsheetIdSchema.safeParse(unwrapToolData(data));
  if (!parsed.success) return null;
  return "spreadsheetId" in parsed.data
    ? parsed.data.spreadsheetId
    : parsed.data.spreadsheet_id;
}

/**
 * Tab titles from a `GOOGLESHEETS_GET_SHEET_NAMES` payload, or null when the
 * payload is a shape this does not know. Null is honest: it means "unknown",
 * and the caller must not conclude the tab is missing and create a second one.
 */
export function readSheetTitles(data: unknown): string[] | null {
  const parsed = sheetNamesDataSchema.safeParse(unwrapToolData(data));
  if (!parsed.success) return null;

  const entries = Array.isArray(parsed.data)
    ? parsed.data
    : "sheetNames" in parsed.data
      ? parsed.data.sheetNames
      : "sheet_names" in parsed.data
        ? parsed.data.sheet_names
        : parsed.data.sheets;

  return entries.map((entry) => {
    if (typeof entry === "string") return entry;
    if ("title" in entry) return entry.title;
    if ("name" in entry) return entry.name;
    if ("sheet_name" in entry) return entry.sheet_name;
    return entry.properties.title;
  });
}

/**
 * Composio names the field it rejected; this names the tool, the tab and the
 * builder that produced the arguments, so one reading of the error says what
 * to change and where. The original `AppError` code is preserved, so a 400
 * stays a 400 and is never retried.
 */
function sheetsToolError(args: {
  tool: string;
  builder: string;
  doing: string;
  cause: unknown;
}): AppError {
  const app = toAppError(args.cause);
  return new AppError(
    app.code,
    `Composio ${args.tool} failed while ${args.doing}: ${app.message} If Composio rejected an argument, correct that field in ${args.builder}() in src/server/connectors/composio/toolkits.ts — it is the only place the name appears.`,
    app.details,
  );
}

/**
 * Google Sheets over Composio tool execution. No OAuth token is involved: the
 * grant stays with Composio, exactly as it does for Notion and Gmail.
 *
 * A tab is written whole — header row, every row, then blanks down to the
 * connector's previous extent — because the toolkit has no non-deprecated tool
 * for reading values back, so there is no way to locate one key's row. The
 * caller keeps the write off the wire entirely when the ledger says nothing in
 * the tab changed, which is what makes a re-sync free rather than a rewrite.
 */
export function createComposioSheetsTransport(args: {
  client: ComposioClient;
  connectedAccountId?: string | null;
  /**
   * The spreadsheet to write into. Resolved and persisted by
   * `ensureComposioSpreadsheet` in `service.ts` before a push, so this
   * transport never creates a second spreadsheet for the same connector.
   */
  spreadsheetId: string;
  spreadsheetUrl?: string | null;
}): SheetsTransport {
  const connectedAccountId = args.connectedAccountId ?? null;

  return {
    mode: "composio",

    async openSpreadsheet() {
      let titles: string[] | null = null;
      try {
        const listed = await args.client.executeTool(
          SHEETS_GET_SHEET_NAMES_TOOL,
          {
            arguments: sheetsGetSheetNamesArguments({
              spreadsheetId: args.spreadsheetId,
            }),
            connectedAccountId,
          },
        );
        titles = readSheetTitles(listed.data);
        if (titles === null) {
          // Not fatal, and not "no tabs": the write below still says exactly
          // which tab Google could not find if one is genuinely missing.
          logger.warn("Composio returned unreadable Google Sheets tab names", {
            tool: SHEETS_GET_SHEET_NAMES_TOOL,
            spreadsheetId: args.spreadsheetId,
          });
        }
      } catch (error) {
        throw sheetsToolError({
          tool: SHEETS_GET_SHEET_NAMES_TOOL,
          builder: "sheetsGetSheetNamesArguments",
          doing: `listing the tabs of spreadsheet ${args.spreadsheetId}`,
          cause: error,
        });
      }

      return {
        spreadsheetId: args.spreadsheetId,
        title: null,
        url: args.spreadsheetUrl?.trim()
          ? args.spreadsheetUrl.trim()
          : spreadsheetWebUrl(args.spreadsheetId),
        tabs:
          titles === null
            ? null
            : new Map(titles.map((title) => [title, null])),
      };
    },

    async writeTab(target, tab) {
      const values = composioTabValues(tab);
      const range = `${tab.title}!A1:${columnLetter(tab.headers.length)}${values.length}`;

      try {
        if (target.tabs && !target.tabs.has(tab.title)) {
          await args.client.executeTool(SHEETS_ADD_SHEET_TOOL, {
            arguments: sheetsAddSheetArguments({
              spreadsheetId: target.spreadsheetId,
              title: tab.title,
            }),
            connectedAccountId,
          });
          target.tabs.set(tab.title, null);
        }

        await args.client.executeTool(SHEETS_VALUES_UPDATE_TOOL, {
          arguments: sheetsValuesUpdateArguments({
            spreadsheetId: target.spreadsheetId,
            range,
            values,
          }),
          connectedAccountId,
        });
      } catch (error) {
        // An invalid key or a revoked grant fails every lane identically, so
        // it aborts the push rather than being reported four times.
        if (isSheetsAuthError(error)) throw error;
        const failure = sheetsToolError({
          tool: SHEETS_VALUES_UPDATE_TOOL,
          builder: "sheetsValuesUpdateArguments",
          doing: `writing ${range}`,
          cause: error,
        });
        return {
          placements: [],
          failures: tab.rows.map((row) => ({ key: row.key, cause: failure })),
        };
      }

      return {
        // Every row was rewritten, so every row's position is this call's to
        // report: a row the ledger has not seen is a create, the rest are
        // updates. Reporting only the changed ones would leave the ledger
        // pointing at the row numbers they had before the replace.
        placements: tab.rows.map((row, offset) => ({
          key: row.key,
          outcome: row.tracked ? "updated" : "created",
          rowNumber: offset + 2,
        })),
        failures: [],
      };
    },
  };
}

/**
 * Header row, every row, then blank rows down to the previous extent. The
 * blanks are the whole reason the extent is tracked: Sheets keeps whatever it
 * is not told to overwrite, so a shrinking lane would otherwise leave stale
 * rows below the new last row, showing applications that no longer exist.
 */
export function composioTabValues(tab: SheetsTabWrite): string[][] {
  const values = [tab.headers, ...tab.rows.map((row) => row.cells)];
  const blank = tab.headers.map(() => "");
  for (let row = values.length; row < tab.previousExtent; row += 1) {
    values.push(blank);
  }
  return values;
}

/**
 * The single selection point for the Sheets write transport, and the Sheets
 * counterpart to `resolveGmailSendTransport`: same predicate, same precedence,
 * direct implementation injected rather than imported so the adapter keeps
 * owning its own Google calls.
 */
export function resolveSheetsTransport(args: {
  connector: Connector;
  fetchImpl: typeof fetch;
  hasDirectCredentials: boolean;
  direct: SheetsTransport;
  /** Spreadsheet the Composio path writes into; see `spreadsheetId` above. */
  spreadsheetId?: string | null;
  spreadsheetUrl?: string | null;
  apiKey?: string | null;
}): SheetsTransport {
  const mode = requireAuthMode({
    provider: "google_sheets",
    hasDirectCredentials: args.hasDirectCredentials,
    hasComposio: hasComposioApiKey(args.apiKey),
  });
  if (mode === "direct") return args.direct;

  const spreadsheetId = args.spreadsheetId?.trim();
  if (!spreadsheetId) {
    throw badRequest(
      "Google Sheets over Composio has no spreadsheet yet. A sync resolves one through ensureComposioSpreadsheet() and stores its id on the connector; run the sync from the Apps page, or connect Google directly (npm run connect google) to use an existing spreadsheet.",
    );
  }

  const state = readComposioState(args.connector);
  return createComposioSheetsTransport({
    client: createComposioClient({
      fetchImpl: args.fetchImpl,
      apiKey: args.apiKey,
    }),
    connectedAccountId: state.connectedAccountId,
    spreadsheetId,
    spreadsheetUrl: args.spreadsheetUrl ?? null,
  });
}
