/**
 * Notion database schemas and row rendering for the four command-center lanes.
 *
 * One database per lane, with `Key` as the database's `title` property: that is
 * the idempotency anchor the adapter queries before deciding create vs update,
 * so it must stay the title (Notion can only filter a title property by the
 * `title` filter type, and it is the only always-present property).
 *
 * There is ONE definition of each lane's columns — the tables below — and
 * everything else is derived from it:
 *
 *   - `NOTION_DATABASES`          the schema sent when provisioning a database
 *   - `toNotionProperties`        Notion's nested payload, for the direct REST
 *                                 transport
 *   - `toComposioProperties`      Composio's flat `{name,type,value}` list,
 *                                 for tool execution
 *
 * That is deliberate. Composio does not accept Notion's nested property
 * payload, so the flat form is a second rendering of the same columns — and a
 * column renamed in one rendering but not the other silently drops a cell's
 * worth of the user's data, which is the whole class of bug this arrangement
 * exists to make impossible.
 */

import { createHash } from "node:crypto";
import type {
  ApplicationRow,
  CommandCenterRow,
  CommandCenterRowBase,
  ConnectorEntityKind,
  FollowUpRow,
  InterviewRow,
  OpportunityRow,
} from "@domain";

/** Notion rejects a rich-text value longer than this. */
export const NOTION_RICH_TEXT_LIMIT = 2000;
/** Notion rejects a select option name longer than this. */
export const NOTION_SELECT_NAME_LIMIT = 100;

/** The `Key` title property, by name, so filters and renders cannot drift. */
export const NOTION_KEY_PROPERTY = "Key";

/**
 * The property types these lanes use. Notion has more; adding one here means
 * teaching all three renderings below about it, which is the point.
 *
 * `select` and not `status`: the lane databases are provisioned with `select`
 * columns, and Composio's own guidance is that a dropdown is `select` even
 * when the column is named "Status" — `status` is reserved for Notion's
 * built-in workflow property, which these databases do not have.
 */
export type NotionPropertyType =
  | "title"
  | "rich_text"
  | "number"
  | "select"
  | "date"
  | "checkbox"
  | "url";

export type NotionColumnSpec = {
  name: string;
  type: NotionPropertyType;
};

/** A column plus how to read it off a row of that lane. */
type NotionColumn<TRow> = NotionColumnSpec & {
  read: (row: TRow) => string | number | boolean | null | undefined;
};

/**
 * One column's value, normalized and transport-neutral. `null` means "no
 * value"; each renderer decides what that means on the wire.
 */
export type NotionPropertyValue = NotionColumnSpec & {
  value: string | number | boolean | null;
};

/** Composio's wire form: a flat list, every value a string. */
export type ComposioNotionProperty = {
  name: string;
  type: NotionPropertyType;
  value: string;
};

export type NotionRichTextPayload = {
  type: "text";
  text: { content: string };
};

/** Shared identity columns, in the order every lane leads with. */
const IDENTITY_COLUMNS: ReadonlyArray<NotionColumn<CommandCenterRowBase>> = [
  { name: NOTION_KEY_PROPERTY, type: "title", read: (row) => row.key },
  { name: "Job ID", type: "rich_text", read: (row) => row.jobId },
  { name: "Company", type: "rich_text", read: (row) => row.company },
  { name: "Role", type: "rich_text", read: (row) => row.role },
];

const OPPORTUNITY_COLUMNS: ReadonlyArray<NotionColumn<OpportunityRow>> = [
  ...IDENTITY_COLUMNS,
  { name: "Location", type: "rich_text", read: (row) => row.location },
  { name: "Source", type: "select", read: (row) => row.source },
  { name: "Job URL", type: "url", read: (row) => row.jobUrl },
  { name: "Salary", type: "rich_text", read: (row) => row.salary },
  { name: "Score", type: "number", read: (row) => row.score },
  { name: "Score Reason", type: "rich_text", read: (row) => row.scoreReason },
  { name: "Sponsor Score", type: "number", read: (row) => row.sponsorScore },
  { name: "Remote", type: "checkbox", read: (row) => row.isRemote },
  { name: "Date Posted", type: "date", read: (row) => row.datePosted },
  { name: "Discovered At", type: "date", read: (row) => row.discoveredAt },
  { name: "Status", type: "select", read: (row) => row.status },
];

const APPLICATION_COLUMNS: ReadonlyArray<NotionColumn<ApplicationRow>> = [
  ...IDENTITY_COLUMNS,
  { name: "Stage", type: "select", read: (row) => row.stage },
  { name: "Outcome", type: "select", read: (row) => row.outcome },
  { name: "Applied At", type: "date", read: (row) => row.appliedAt },
  { name: "Resume Path", type: "rich_text", read: (row) => row.resumePath },
  { name: "Resume Views", type: "number", read: (row) => row.resumeViews },
  {
    name: "Last Resume View At",
    type: "date",
    read: (row) => row.lastResumeViewAt,
  },
  { name: "Job URL", type: "url", read: (row) => row.jobUrl },
  { name: "Score", type: "number", read: (row) => row.score },
];

const INTERVIEW_COLUMNS: ReadonlyArray<NotionColumn<InterviewRow>> = [
  ...IDENTITY_COLUMNS,
  { name: "Interview ID", type: "rich_text", read: (row) => row.interviewId },
  { name: "Scheduled At", type: "date", read: (row) => row.scheduledAt },
  { name: "Duration Mins", type: "number", read: (row) => row.durationMins },
  { name: "Interview Type", type: "select", read: (row) => row.interviewType },
  { name: "Outcome", type: "select", read: (row) => row.outcome },
];

const FOLLOW_UP_COLUMNS: ReadonlyArray<NotionColumn<FollowUpRow>> = [
  ...IDENTITY_COLUMNS,
  { name: "Task ID", type: "rich_text", read: (row) => row.taskId },
  { name: "Title", type: "rich_text", read: (row) => row.title },
  { name: "Due Date", type: "date", read: (row) => row.dueDate },
  { name: "Completed", type: "checkbox", read: (row) => row.isCompleted },
  { name: "Reason", type: "rich_text", read: (row) => row.reason },
];

const LANE_TITLES: Record<ConnectorEntityKind, string> = {
  opportunity: "Opportunities",
  application: "Applications",
  interview: "Interviews",
  follow_up: "Follow-ups",
};

/** Column specs per lane, for schema generation and for tests to enumerate. */
export const NOTION_COLUMNS: Record<
  ConnectorEntityKind,
  ReadonlyArray<NotionColumnSpec>
> = {
  opportunity: OPPORTUNITY_COLUMNS,
  application: APPLICATION_COLUMNS,
  interview: INTERVIEW_COLUMNS,
  follow_up: FOLLOW_UP_COLUMNS,
};

/** The schema fragment Notion wants when a property is created. */
function schemaFor(type: NotionPropertyType): Record<string, unknown> {
  switch (type) {
    case "title":
      return { title: {} };
    case "rich_text":
      return { rich_text: {} };
    case "number":
      return { number: { format: "number" } };
    case "select":
      return { select: {} };
    case "date":
      return { date: {} };
    case "checkbox":
      return { checkbox: {} };
    case "url":
      return { url: {} };
  }
}

function databaseSpec(kind: ConnectorEntityKind): {
  title: string;
  properties: Record<string, unknown>;
} {
  return {
    title: LANE_TITLES[kind],
    properties: Object.fromEntries(
      NOTION_COLUMNS[kind].map((column) => [
        column.name,
        schemaFor(column.type),
      ]),
    ),
  };
}

/**
 * Lane databases as the direct REST transport provisions them. Derived, so a
 * column added to a table above appears here without a second edit.
 */
export const NOTION_DATABASES: Record<
  ConnectorEntityKind,
  { title: string; properties: Record<string, unknown> }
> = {
  opportunity: databaseSpec("opportunity"),
  application: databaseSpec("application"),
  interview: databaseSpec("interview"),
  follow_up: databaseSpec("follow_up"),
};

/**
 * Lane schema in Composio's `NOTION_CREATE_DATABASE` form: a flat list of
 * `{name, type}`, with exactly one `title` column, as that tool requires.
 */
export function composioDatabaseProperties(
  kind: ConnectorEntityKind,
): ComposioNotionSchemaProperty[] {
  return NOTION_COLUMNS[kind].map((column) => ({
    name: column.name,
    type: column.type,
  }));
}

export type ComposioNotionSchemaProperty = {
  name: string;
  type: NotionPropertyType;
};

/**
 * A date normalized for Notion: a bare calendar date stays as written,
 * anything else becomes ISO-8601. `null` when there is no usable date, which
 * both renderers turn into "send nothing" rather than a malformed value.
 */
function isoDate(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

/**
 * Normalize one cell by its column type. Every limit Notion enforces is
 * applied here, once, so the two renderings cannot disagree about what a cell
 * contains — only about how to spell it.
 */
function normalize(
  type: NotionPropertyType,
  raw: string | number | boolean | null | undefined,
): string | number | boolean | null {
  switch (type) {
    case "title":
    case "rich_text":
      return raw === null || raw === undefined
        ? ""
        : String(raw).slice(0, NOTION_RICH_TEXT_LIMIT);
    case "select": {
      // Notion rejects a comma inside a select option name, and Composio uses
      // commas to separate multi_select values, so both transports strip them.
      const name = String(raw ?? "")
        .replace(/,/g, " ")
        .trim()
        .slice(0, NOTION_SELECT_NAME_LIMIT);
      return name === "" ? null : name;
    }
    case "date":
      return isoDate(raw);
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    case "checkbox":
      return raw === true;
    case "url": {
      const url = String(raw ?? "").trim();
      return url === "" ? null : url;
    }
  }
}

function readColumns<TRow>(
  row: TRow,
  columns: ReadonlyArray<NotionColumn<TRow>>,
): NotionPropertyValue[] {
  return columns.map((column) => ({
    name: column.name,
    type: column.type,
    value: normalize(column.type, column.read(row)),
  }));
}

/**
 * One row as neutral column values, in schema order. This is the single
 * rendering point: both transports start here.
 */
export function notionColumnValues(
  row: CommandCenterRow,
): NotionPropertyValue[] {
  switch (row.kind) {
    case "opportunity":
      return readColumns(row, OPPORTUNITY_COLUMNS);
    case "application":
      return readColumns(row, APPLICATION_COLUMNS);
    case "interview":
      return readColumns(row, INTERVIEW_COLUMNS);
    case "follow_up":
      return readColumns(row, FOLLOW_UP_COLUMNS);
  }
}

function richText(
  value: string | number | boolean | null,
): NotionRichTextPayload[] {
  const content = value === null ? "" : String(value);
  if (content === "") return [];
  return [{ type: "text", text: { content } }];
}

/** Notion's nested payload for one column, or `undefined` to omit it. */
function toNativeProperty(entry: NotionPropertyValue): unknown {
  switch (entry.type) {
    case "title":
      return { title: richText(entry.value) };
    case "rich_text":
      return { rich_text: richText(entry.value) };
    case "number":
      return { number: typeof entry.value === "number" ? entry.value : null };
    case "select":
      return {
        select: entry.value === null ? null : { name: String(entry.value) },
      };
    case "date":
      // A date has no "empty" payload Notion accepts, so an absent date omits
      // the property instead of sending a null it would reject.
      return entry.value === null
        ? undefined
        : { date: { start: String(entry.value) } };
    case "checkbox":
      return { checkbox: entry.value === true };
    case "url":
      return { url: entry.value === null ? null : String(entry.value) };
  }
}

/** Render one row as a Notion `properties` payload for create or update. */
export function toNotionProperties(
  row: CommandCenterRow,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const entry of notionColumnValues(row)) {
    const payload = toNativeProperty(entry);
    if (payload !== undefined) properties[entry.name] = payload;
  }
  return properties;
}

/**
 * Composio's string value for one column, or `null` to leave the column out.
 *
 * Text columns always go, including as an empty string, because that is how a
 * cleared cell is expressed. `select`, `date`, `url` and `number` are omitted
 * when empty: their value is a string, and neither Composio nor Notion
 * documents a string that means "clear this". That makes the Composio
 * transport unable to blank one of those cells once set, which the direct
 * transport can — an accepted difference, recorded here rather than papered
 * over with a value that would be rejected or, worse, stored literally.
 */
function toComposioValue(entry: NotionPropertyValue): string | null {
  switch (entry.type) {
    case "title":
    case "rich_text":
      return entry.value === null ? "" : String(entry.value);
    case "checkbox":
      // Composio parses the literal strings "True" and "False".
      return entry.value === true ? "True" : "False";
    case "number":
    case "select":
    case "date":
    case "url":
      return entry.value === null ? null : String(entry.value);
  }
}

/**
 * Render one row as Composio's flat property list. Names and types come from
 * the same column tables the native payload uses, and Composio matches both
 * case-sensitively against the database schema — which those same tables
 * provisioned.
 */
export function toComposioProperties(
  row: CommandCenterRow,
): ComposioNotionProperty[] {
  const properties: ComposioNotionProperty[] = [];
  for (const entry of notionColumnValues(row)) {
    const value = toComposioValue(entry);
    if (value === null) continue;
    properties.push({ name: entry.name, type: entry.type, value });
  }
  return properties;
}

/**
 * Content hash for the idempotency ledger: sha256 over the row's key-sorted
 * JSON, hex. Field order must not change the digest, and every row adapter
 * must produce the same digest for the same row — the service recomputes it,
 * and a mismatch would make every push look changed forever.
 */
export function hashRow(row: CommandCenterRow): string {
  // Code-unit key compare, never locale collation: the Sheets adapter and the
  // service ledger hash the same way, and locale ordering could reorder keys.
  const sorted = Object.fromEntries(
    Object.entries(row).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}
