/**
 * Composio toolkit and tool slugs, in one place.
 *
 * These strings are Composio's identifiers, not ours: they are what
 * `POST /tools/execute/{slug}` addresses. They cannot be verified from source
 * — confirming them needs `GET /tools?toolkit_slug=<slug>` against a live key
 * — so they live here as named constants with exactly one definition each, and
 * the client surfaces Composio's own error verbatim when a slug is wrong. A
 * typo therefore reads "no tool found with slug X" instead of a generic
 * upstream failure.
 */

import type { ConnectorProvider } from "@domain";
import { badRequest } from "@server/infra/errors";
import { SHEETS_VALUE_INPUT_OPTION } from "../sheets/api";

/** Composio tool slug: sends a message as the linked Gmail account. */
export const GMAIL_SEND_EMAIL_TOOL = "GMAIL_SEND_EMAIL";

/**
 * Notion tool slugs, from the toolkit reference at
 * https://docs.composio.dev/toolkits/notion (toolkit version 20260819_00).
 *
 * The row tools are the ones that carry typed columns: `NOTION_CREATE_NOTION_PAGE`
 * takes only a title and markdown, so a database row written through it lands
 * with every property empty. Rows go through INSERT/UPDATE_ROW_DATABASE.
 */
export const NOTION_CREATE_PAGE_TOOL = "NOTION_CREATE_NOTION_PAGE";
/** Creates a lane database under a PAGE parent; a database parent errors. */
export const NOTION_CREATE_DATABASE_TOOL = "NOTION_CREATE_DATABASE";
/** Inserts one row (a page) into a database, with typed properties. */
export const NOTION_INSERT_ROW_TOOL = "NOTION_INSERT_ROW_DATABASE";
/** Updates one row by its PAGE uuid — `row_id`, never a database id. */
export const NOTION_UPDATE_ROW_TOOL = "NOTION_UPDATE_ROW_DATABASE";
/** Finds a row by its `Key` title, so a changed row updates in place. */
export const NOTION_QUERY_DATABASE_TOOL = "NOTION_QUERY_DATABASE_WITH_FILTER";
/** Lists the workspace's databases, for adopting one by title. */
export const NOTION_FETCH_DATA_TOOL = "NOTION_FETCH_DATA";
/**
 * Appends body blocks. The single-block `NOTION_ADD_PAGE_CONTENT` is
 * deprecated in favour of this one ("use add_multiple_page_content for better
 * performance"), and it also auto-splits text past Notion's 2000-character
 * block limit, which the single-block tool left to the caller.
 */
export const NOTION_ADD_CONTENT_TOOL = "NOTION_ADD_MULTIPLE_PAGE_CONTENT";

/**
 * Google Sheets tool slugs, taken from the toolkit reference at
 * https://docs.composio.dev/toolkits/googlesheets (toolkit version
 * 20260902_00). The deprecated `GOOGLESHEETS_BATCH_UPDATE`,
 * `GOOGLESHEETS_SHEET_FROM_JSON` and `GOOGLESHEETS_LIST_TABLES` are
 * deliberately absent: they answer with a deprecation notice rather than
 * doing the work.
 */
export const SHEETS_CREATE_SPREADSHEET_TOOL =
  "GOOGLESHEETS_CREATE_GOOGLE_SHEET1";
/** Lists the tabs of a spreadsheet, so a missing one can be created. */
export const SHEETS_GET_SHEET_NAMES_TOOL = "GOOGLESHEETS_GET_SHEET_NAMES";
/** Adds one tab. The only non-deprecated way to create a tab over Composio. */
export const SHEETS_ADD_SHEET_TOOL = "GOOGLESHEETS_ADD_SHEET";
/** Writes one A1 range. `GOOGLESHEETS_UPDATE_VALUES_BATCH` is the many-range
 * counterpart; this connector writes one tab per call so a failing lane
 * cannot take the other three down with it. */
export const SHEETS_VALUES_UPDATE_TOOL = "GOOGLESHEETS_VALUES_UPDATE";

export const GMAIL_TOOLKIT_SLUG = "gmail";
export const NOTION_TOOLKIT_SLUG = "notion";
export const GOOGLESHEETS_TOOLKIT_SLUG = "googlesheets";

export type ComposioToolkit = {
  toolkitSlug: string;
  tools: Record<string, string>;
};

/**
 * Every provider is reachable through Composio, and none of them needs a raw
 * OAuth token to be: each transport calls `POST /tools/execute/{slug}`, and
 * Composio applies the grant it holds. Google Sheets is the case worth
 * spelling out, because it looks like it should need a token — the direct
 * adapter does hold one — but the Composio path never sees one: it writes
 * rows with `GOOGLESHEETS_VALUES_UPDATE` instead of calling the Sheets API
 * itself, exactly as Notion writes pages with `NOTION_CREATE_NOTION_PAGE`.
 *
 * The Sheets toolkit has no non-deprecated tool for reading values, so the
 * Composio transport cannot diff column A the way the direct one does; it
 * replaces a tab's contents wholesale instead, gated on the content-hash
 * ledger so an unchanged tab costs zero calls. See
 * `createComposioSheetsTransport` in `transport.ts`.
 */
export const COMPOSIO_TOOLKITS = {
  gmail_send: {
    toolkitSlug: GMAIL_TOOLKIT_SLUG,
    tools: { sendEmail: GMAIL_SEND_EMAIL_TOOL },
  },
  notion: {
    toolkitSlug: NOTION_TOOLKIT_SLUG,
    tools: {
      createPage: NOTION_CREATE_PAGE_TOOL,
      createDatabase: NOTION_CREATE_DATABASE_TOOL,
      insertRow: NOTION_INSERT_ROW_TOOL,
      updateRow: NOTION_UPDATE_ROW_TOOL,
      queryDatabase: NOTION_QUERY_DATABASE_TOOL,
      fetchData: NOTION_FETCH_DATA_TOOL,
      addContent: NOTION_ADD_CONTENT_TOOL,
    },
  },
  google_sheets: {
    toolkitSlug: GOOGLESHEETS_TOOLKIT_SLUG,
    tools: {
      createSpreadsheet: SHEETS_CREATE_SPREADSHEET_TOOL,
      getSheetNames: SHEETS_GET_SHEET_NAMES_TOOL,
      addSheet: SHEETS_ADD_SHEET_TOOL,
      updateValues: SHEETS_VALUES_UPDATE_TOOL,
    },
  },
} satisfies Partial<Record<ConnectorProvider, ComposioToolkit>>;

export type ComposioProvider = keyof typeof COMPOSIO_TOOLKITS;

export function isComposioProvider(
  provider: ConnectorProvider,
): provider is ComposioProvider {
  return provider in COMPOSIO_TOOLKITS;
}

export function composioToolkitFor(
  provider: ConnectorProvider,
): ComposioToolkit {
  if (!isComposioProvider(provider)) {
    throw badRequest(
      `${provider} has no Composio toolkit registered in COMPOSIO_TOOLKITS, so it can only be connected directly: npm run connect`,
    );
  }
  return COMPOSIO_TOOLKITS[provider];
}

// ---------------------------------------------------------------------------
// Argument builders
//
// Composio's tool argument names are as unverifiable from source as the slugs,
// so they are built here — one function per tool — rather than spread across
// call sites. When Composio rejects an argument, its message names the field,
// and there is exactly one place to correct it.
// ---------------------------------------------------------------------------

export type ComposioEmailArgs = {
  to: string;
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
};

export function gmailSendArguments(
  input: ComposioEmailArgs,
): Record<string, unknown> {
  return {
    recipient_email: input.to,
    subject: input.subject,
    body: input.body,
    // Plain text only, matching the direct transport: recruiters' ATS strip HTML.
    is_html: false,
    ...(input.cc && input.cc.length > 0 ? { cc: input.cc } : {}),
    ...(input.bcc && input.bcc.length > 0 ? { bcc: input.bcc } : {}),
  };
}

export function notionCreatePageArguments(input: {
  parentId: string;
  title: string;
}): Record<string, unknown> {
  return {
    parent_id: input.parentId,
    title: input.title,
  };
}

export function notionAddContentArguments(input: {
  pageId: string;
  content: string;
}): Record<string, unknown> {
  return {
    parent_block_id: input.pageId,
    content_block: {
      block_property: "paragraph",
      content_block: input.content,
    },
  };
}

// --- Google Sheets ---------------------------------------------------------
//
// Names taken from the toolkit reference at
// https://docs.composio.dev/toolkits/googlesheets (toolkit version
// 20260902_00). Documented, not live-verified: a rejected field is corrected
// here and nowhere else.

export function sheetsCreateSpreadsheetArguments(input: {
  title: string;
}): Record<string, unknown> {
  return { title: input.title };
}

export function sheetsGetSheetNamesArguments(input: {
  spreadsheetId: string;
}): Record<string, unknown> {
  return { spreadsheet_id: input.spreadsheetId };
}

export function sheetsAddSheetArguments(input: {
  spreadsheetId: string;
  title: string;
}): Record<string, unknown> {
  return {
    spreadsheet_id: input.spreadsheetId,
    title: input.title,
    // Composio defaults this to true, which would answer a name collision
    // with an `Opportunities_2` tab — a second, invisible lane the connector
    // would then keep writing to. A collision must fail and be read.
    force_unique: false,
  };
}

export function sheetsValuesUpdateArguments(input: {
  spreadsheetId: string;
  /** Sheet-qualified A1 range, e.g. `Opportunities!A1:O12`. */
  range: string;
  values: string[][];
}): Record<string, unknown> {
  return {
    spreadsheet_id: input.spreadsheetId,
    range: input.range,
    values: input.values,
    major_dimension: "ROWS",
    // The same option the direct transport puts on the Sheets URL, from the
    // same constant: one row must not render two ways depending on which
    // transport wrote it. RAW keeps "0123" a string and "=SUM(A1)" inert.
    value_input_option: SHEETS_VALUE_INPUT_OPTION,
    // A growing lane passes the default 1000-row grid eventually; without
    // this the write fails there instead of expanding the sheet.
    auto_expand_sheet: true,
  };
}
