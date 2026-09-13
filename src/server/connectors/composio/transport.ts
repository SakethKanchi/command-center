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
  CommandCenterRow,
  Connector,
  ConnectorAuthMode,
  ConnectorEntityKind,
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
import {
  NOTION_KEY_PROPERTY,
  toComposioProperties,
} from "../notion/properties";
import { isSheetsAuthError, spreadsheetWebUrl } from "../sheets/api";
import { columnLetter } from "../sheets/layout";
import type { ComposioClient, ComposioToolResult } from "./client";
import { COMPOSIO_DASHBOARD_URL, createComposioClient } from "./client";
import { hasComposioCredential } from "./credentials";
import { readComposioState } from "./state";
import {
  GMAIL_SEND_EMAIL_TOOL,
  gmailSendArguments,
  NOTION_ADD_CONTENT_TOOL,
  NOTION_CREATE_PAGE_TOOL,
  NOTION_INSERT_ROW_TOOL,
  NOTION_QUERY_DATABASE_TOOL,
  NOTION_UPDATE_ROW_TOOL,
  notionAddContentArguments,
  notionCreatePageArguments,
  notionInsertRowArguments,
  notionQueryByKeyArguments,
  notionUpdateRowArguments,
  SHEETS_ADD_SHEET_TOOL,
  SHEETS_GET_SHEET_NAMES_TOOL,
  SHEETS_VALUES_UPDATE_TOOL,
  sheetsAddSheetArguments,
  sheetsGetSheetNamesArguments,
  sheetsValuesUpdateArguments,
} from "./toolkits";

/** Notion allows at most 100 conditions inside a compound filter. */
export const NOTION_FILTER_CONDITION_LIMIT = 100;

/** The direct path for each provider, quoted in every not-configured message. */
const DIRECT_SETUP_COMMAND: Record<ConnectorProvider, string> = {
  google_sheets: "npm run connect google",
  gmail_send: "npm run connect google",
  notion: "npm run connect notion",
};

/**
 * Whether Composio can be used at all. A key in the environment is only one
 * of the two credential classes: an individual who ran `composio login` has a
 * user key on disk and no env var, and answering "false" for them is what
 * made the Apps page offer three dead cards.
 */
export function hasComposioApiKey(apiKey?: string | null): boolean {
  return hasComposioCredential(apiKey);
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
// Tool payload helpers, shared by every Composio transport below
// ---------------------------------------------------------------------------

/** Composio nests the provider payload under `response_data` on some tools. */
function unwrapToolData(data: unknown): unknown {
  if (data && typeof data === "object" && "response_data" in data) {
    return data.response_data;
  }
  return data;
}

/**
 * Composio names the field it rejected; this names the tool, what was being
 * written, and the builder that produced the arguments — so one reading of the
 * error says what to change and where. The original `AppError` code is
 * preserved, so a 400 stays a 400 and is never retried.
 */
function composioToolError(args: {
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
// Notion row transport
// ---------------------------------------------------------------------------

export type NotionPageWrite = {
  /** Database the row lands in, or the parent page for a plain page. */
  parentId: string;
  title: string;
  /**
   * The command-center row this page carries. Both transports render its
   * typed columns from the one definition in `notion/properties.ts` — nested
   * for the direct REST call, flat for Composio tool execution — so a linked
   * account gets Score, Status, Date Posted and the rest, not a bare title.
   */
  row?: CommandCenterRow | null;
  /** Body text appended to the page. */
  content?: string | null;
  /** Present ⇒ update that row/page instead of creating one. */
  pageId?: string | null;
};

export type NotionPageRef = {
  id: string;
  url: string;
  outcome: "created" | "updated";
};

/** One lane's database, whichever transport resolved it. */
export type NotionLaneRef = {
  kind: ConnectorEntityKind;
  databaseId: string;
  url: string;
};

/**
 * The outbound half of the Notion connector: write one page. The direct
 * implementation is built from `notion/api.ts` primitives (see
 * `createDirectNotionRowTransport` in `notion/transport.ts`), the Composio one
 * is below.
 */
export type NotionPageTransport = {
  readonly mode: ConnectorAuthMode;
  write(input: NotionPageWrite): Promise<NotionPageRef>;
};

/**
 * What a row push needs on top of writing a page: which database the lane
 * writes to, and which rows are already there. Notion's own `Key` title is the
 * second idempotency layer behind the hash ledger — it is what keeps the
 * workspace duplicate-free when the ledger is empty (fresh install, restored
 * backup, page created by hand), so both transports must answer it.
 */
export type NotionRowTransport = NotionPageTransport & {
  openLane(input: {
    kind: ConnectorEntityKind;
    /** Database id from connector config, when it has one. */
    databaseId?: string | null;
  }): Promise<NotionLaneRef>;
  findRowsByKey(
    lane: NotionLaneRef,
    keys: string[],
  ): Promise<Map<string, string>>;
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

/** A queried row: its page id plus the `Key` title it carries. */
const notionQueryRowSchema = z.object({
  id: z.string().min(1),
  properties: z.record(z.unknown()).nullish(),
});

const notionQueryDataSchema = z.union([
  z.array(notionQueryRowSchema),
  z.object({ results: z.array(notionQueryRowSchema) }),
  z.object({
    response_data: z.object({ results: z.array(notionQueryRowSchema) }),
  }),
]);

const notionTitleCellSchema = z.object({
  title: z.array(
    z.object({
      plain_text: z.string().nullish(),
      text: z.object({ content: z.string().nullish() }).nullish(),
    }),
  ),
});

export function notionUrlFor(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, "")}`;
}

/** The `Key` title of a queried row, so a page can be matched to a row. */
export function readNotionKeyCell(
  properties: Record<string, unknown> | null | undefined,
  keyProperty: string,
): string {
  const parsed = notionTitleCellSchema.safeParse(properties?.[keyProperty]);
  if (!parsed.success) return "";
  return parsed.data.title
    .map((item) => item.plain_text ?? item.text?.content ?? "")
    .join("")
    .trim();
}

/** A database as `NOTION_FETCH_DATA` reports it: an id plus some title form. */
const notionDatabaseSchema = z.object({
  id: z.string().min(1),
  title: z
    .union([
      z.string(),
      z.array(
        z.object({
          plain_text: z.string().nullish(),
          text: z.object({ content: z.string().nullish() }).nullish(),
        }),
      ),
    ])
    .nullish(),
  name: z.string().nullish(),
});

const notionDatabaseListSchema = z.union([
  z.array(notionDatabaseSchema),
  z.object({ databases: z.array(notionDatabaseSchema) }),
  z.object({ results: z.array(notionDatabaseSchema) }),
  z.object({ items: z.array(notionDatabaseSchema) }),
]);

/**
 * Databases from a `NOTION_FETCH_DATA` payload as `{id, title}`, or null when
 * the payload is a shape this does not know. Null must never be read as "the
 * workspace has none": that would provision a second copy of a database the
 * user already has, so the caller fails instead.
 */
export function readNotionDatabases(
  data: unknown,
): Array<{ id: string; title: string }> | null {
  const parsed = notionDatabaseListSchema.safeParse(unwrapToolData(data));
  if (!parsed.success) return null;

  const entries = Array.isArray(parsed.data)
    ? parsed.data
    : "databases" in parsed.data
      ? parsed.data.databases
      : "results" in parsed.data
        ? parsed.data.results
        : parsed.data.items;

  return entries.map((entry) => {
    const title =
      typeof entry.title === "string"
        ? entry.title
        : Array.isArray(entry.title)
          ? entry.title
              .map((item) => item.plain_text ?? item.text?.content ?? "")
              .join("")
          : (entry.name ?? "");
    return { id: entry.id, title: title.trim() };
  });
}

/** The page or database id a Notion tool answered with. */
export function readNotionId(data: unknown): string | null {
  const parsed = notionPageDataSchema.safeParse(unwrapToolData(data));
  if (!parsed.success) return null;
  return "id" in parsed.data ? parsed.data.id : parsed.data.response_data.id;
}

/**
 * Notion over Composio tool execution.
 *
 * Rows go through `NOTION_INSERT_ROW_DATABASE` / `NOTION_UPDATE_ROW_DATABASE`
 * with the flat property list, never through `NOTION_CREATE_NOTION_PAGE`:
 * that tool takes a title and markdown only, so a row written with it arrives
 * with every typed column empty — which is exactly the bug this transport
 * used to have.
 */
export function createComposioNotionTransport(args: {
  client: ComposioClient;
  connectedAccountId?: string | null;
  /** Lane databases from connector config, resolved by the service layer. */
  databaseIds?: Partial<Record<ConnectorEntityKind, string>> | null;
}): NotionRowTransport {
  const connectedAccountId = args.connectedAccountId ?? null;

  async function appendContent(pageId: string, content: string) {
    await args.client.executeTool(NOTION_ADD_CONTENT_TOOL, {
      arguments: notionAddContentArguments({ pageId, content }),
      connectedAccountId,
    });
  }

  return {
    mode: "composio",

    async openLane(input) {
      const databaseId =
        input.databaseId?.trim() || args.databaseIds?.[input.kind]?.trim();
      if (!databaseId) {
        throw badRequest(
          `Notion over Composio has no database for the ${input.kind} lane yet. A sync resolves one through ensureComposioNotionDatabases() and stores its id on the connector; set config.parentPageId to a page shared with the Composio integration so the lane can be provisioned, or set config.databaseIds.${input.kind} to an existing database id.`,
        );
      }
      return {
        kind: input.kind,
        databaseId,
        url: notionUrlFor(databaseId),
      };
    },

    async findRowsByKey(lane, keys) {
      const found = new Map<string, string>();
      const unique = [...new Set(keys)];
      if (unique.length === 0) return found;

      for (
        let offset = 0;
        offset < unique.length;
        offset += NOTION_FILTER_CONDITION_LIMIT
      ) {
        const chunk = unique.slice(
          offset,
          offset + NOTION_FILTER_CONDITION_LIMIT,
        );
        let queried: ComposioToolResult;
        try {
          queried = await args.client.executeTool(NOTION_QUERY_DATABASE_TOOL, {
            arguments: notionQueryByKeyArguments({
              databaseId: lane.databaseId,
              keyProperty: NOTION_KEY_PROPERTY,
              keys: chunk,
            }),
            connectedAccountId,
          });
        } catch (error) {
          throw composioToolError({
            tool: NOTION_QUERY_DATABASE_TOOL,
            builder: "notionQueryByKeyArguments",
            doing: `looking up ${chunk.length} ${lane.kind} row(s) by ${NOTION_KEY_PROPERTY}`,
            cause: error,
          });
        }

        const parsed = notionQueryDataSchema.safeParse(
          unwrapToolData(queried.data),
        );
        if (!parsed.success) {
          throw upstreamError(
            `Composio ${NOTION_QUERY_DATABASE_TOOL} returned rows in an unreadable shape, so an existing ${lane.kind} row cannot be told from a new one — writing anyway would duplicate it.`,
            { logId: queried.logId, tool: NOTION_QUERY_DATABASE_TOOL },
          );
        }
        const rows = Array.isArray(parsed.data)
          ? parsed.data
          : "results" in parsed.data
            ? parsed.data.results
            : parsed.data.response_data.results;

        for (const row of rows) {
          const key = readNotionKeyCell(row.properties, NOTION_KEY_PROPERTY);
          if (key !== "" && !found.has(key)) found.set(key, row.id);
        }
      }

      return found;
    },

    async write(input) {
      const properties = input.row ? toComposioProperties(input.row) : [];
      const body = input.content?.trim();

      // A row with typed columns: insert or update the database row, which is
      // the only path that carries properties.
      if (properties.length > 0) {
        const tool = input.pageId
          ? NOTION_UPDATE_ROW_TOOL
          : NOTION_INSERT_ROW_TOOL;
        let written: ComposioToolResult;
        try {
          written = await args.client.executeTool(tool, {
            arguments: input.pageId
              ? notionUpdateRowArguments({
                  pageId: input.pageId,
                  properties,
                })
              : notionInsertRowArguments({
                  databaseId: input.parentId,
                  properties,
                }),
            connectedAccountId,
          });
        } catch (error) {
          throw composioToolError({
            tool,
            builder: input.pageId
              ? "notionUpdateRowArguments"
              : "notionInsertRowArguments",
            doing: `writing the row ${input.title}`,
            cause: error,
          });
        }

        // An update already knows its page id; an insert has to be told one,
        // or the ledger would have nothing to address next time.
        const parsed = notionPageDataSchema.safeParse(
          unwrapToolData(written.data),
        );
        const page = parsed.success
          ? "id" in parsed.data
            ? parsed.data
            : parsed.data.response_data
          : null;
        const pageId = input.pageId ?? page?.id ?? null;
        if (!pageId) {
          throw upstreamError(
            `Composio ${tool} returned no page id, so the row cannot be recorded and the next sync would insert it again.`,
            { logId: written.logId, tool },
          );
        }

        if (body) await appendContent(pageId, body);
        return {
          id: pageId,
          url: page?.url ?? notionUrlFor(pageId),
          outcome: input.pageId ? "updated" : "created",
        };
      }

      // No typed columns: a plain page. Updating one only appends body text,
      // because there are no properties to rewrite.
      if (input.pageId) {
        if (body) await appendContent(input.pageId, body);
        return {
          id: input.pageId,
          url: notionUrlFor(input.pageId),
          outcome: "updated",
        };
      }

      let created: ComposioToolResult;
      try {
        created = await args.client.executeTool(NOTION_CREATE_PAGE_TOOL, {
          arguments: notionCreatePageArguments({
            parentId: input.parentId,
            title: input.title,
            markdown: body ?? null,
          }),
          connectedAccountId,
        });
      } catch (error) {
        throw composioToolError({
          tool: NOTION_CREATE_PAGE_TOOL,
          builder: "notionCreatePageArguments",
          doing: `creating the page ${input.title}`,
          cause: error,
        });
      }

      const parsed = notionPageDataSchema.safeParse(
        unwrapToolData(created.data),
      );
      if (!parsed.success) {
        throw upstreamError(
          `Composio ${NOTION_CREATE_PAGE_TOOL} returned no page id, so the write cannot be confirmed.`,
          { logId: created.logId, tool: NOTION_CREATE_PAGE_TOOL },
        );
      }
      const page =
        "id" in parsed.data ? parsed.data : parsed.data.response_data;

      return {
        id: page.id,
        url: page.url ?? notionUrlFor(page.id),
        outcome: "created",
      };
    },
  };
}

/**
 * The single selection point for the Notion row transport: same predicate and
 * same precedence as Gmail and Sheets, direct injected rather than imported.
 */
export function resolveNotionRowTransport(args: {
  connector: Connector;
  fetchImpl: typeof fetch;
  hasDirectCredentials: boolean;
  direct: NotionRowTransport;
  databaseIds?: Partial<Record<ConnectorEntityKind, string>> | null;
  apiKey?: string | null;
}): NotionRowTransport {
  const mode = requireAuthMode({
    provider: "notion",
    hasDirectCredentials: args.hasDirectCredentials,
    hasComposio: hasComposioApiKey(args.apiKey),
  });
  if (mode === "direct") return args.direct;

  const state = readComposioState(args.connector);
  return createComposioNotionTransport({
    client: createComposioClient({
      fetchImpl: args.fetchImpl,
      apiKey: args.apiKey,
    }),
    connectedAccountId: state.connectedAccountId,
    databaseIds: args.databaseIds ?? null,
  });
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
        throw composioToolError({
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
        const failure = composioToolError({
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
