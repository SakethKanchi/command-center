/**
 * The physical shape of the Google Sheets command center: four tabs, one per
 * command-center lane, with column A always holding the row's natural key.
 *
 * Column tables are the single source of truth for both the header row and the
 * rendered cells, so the two can never drift out of alignment.
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

/** `[field, human-readable header]`, in the row type's declaration order. */
type ColumnTable<TRow> = ReadonlyArray<readonly [keyof TRow, string]>;

/**
 * Column A is the idempotency anchor: `push` reads it to decide update vs
 * append, so it leads every tab.
 */
const BASE_COLUMNS: ColumnTable<CommandCenterRowBase> = [
  ["key", "Key"],
  ["jobId", "Job ID"],
  ["company", "Company"],
  ["role", "Role"],
];

// The `kind` discriminant is deliberately not a column: the tab it lands in
// already encodes it, and a constant column is dead weight in a spreadsheet.
const OPPORTUNITY_COLUMNS: ColumnTable<OpportunityRow> = [
  ...BASE_COLUMNS,
  ["location", "Location"],
  ["source", "Source"],
  ["jobUrl", "Job URL"],
  ["salary", "Salary"],
  ["score", "Score"],
  ["scoreReason", "Score reason"],
  ["sponsorScore", "Sponsor score"],
  ["isRemote", "Remote"],
  ["datePosted", "Date posted"],
  ["discoveredAt", "Discovered at"],
  ["status", "Status"],
];

const APPLICATION_COLUMNS: ColumnTable<ApplicationRow> = [
  ...BASE_COLUMNS,
  ["stage", "Stage"],
  ["outcome", "Outcome"],
  ["appliedAt", "Applied at"],
  ["resumePath", "Resume path"],
  ["resumeViews", "Resume views"],
  ["lastResumeViewAt", "Last resume view at"],
  ["jobUrl", "Job URL"],
  ["score", "Score"],
];

const INTERVIEW_COLUMNS: ColumnTable<InterviewRow> = [
  ...BASE_COLUMNS,
  ["interviewId", "Interview ID"],
  ["scheduledAt", "Scheduled at"],
  ["durationMins", "Duration (mins)"],
  ["interviewType", "Interview type"],
  ["outcome", "Outcome"],
];

const FOLLOW_UP_COLUMNS: ColumnTable<FollowUpRow> = [
  ...BASE_COLUMNS,
  ["taskId", "Task ID"],
  ["title", "Title"],
  ["dueDate", "Due date"],
  ["isCompleted", "Completed"],
  ["reason", "Reason"],
];

export type SheetTab = {
  title: string;
  headers: string[];
};

/**
 * Title for a spreadsheet this app creates, matching the one
 * `scripts/connect.mjs` gives the spreadsheet it creates on the direct path.
 * Only the Composio path creates one from inside the server: connecting
 * directly makes the spreadsheet before the connector row exists.
 */
export const COMMAND_CENTER_SPREADSHEET_TITLE = "Job Search Command Center";

export const SHEET_TABS: Record<ConnectorEntityKind, SheetTab> = {
  opportunity: {
    title: "Opportunities",
    headers: OPPORTUNITY_COLUMNS.map(([, header]) => header),
  },
  application: {
    title: "Applications",
    headers: APPLICATION_COLUMNS.map(([, header]) => header),
  },
  interview: {
    title: "Interviews",
    headers: INTERVIEW_COLUMNS.map(([, header]) => header),
  },
  follow_up: {
    title: "Follow-ups",
    headers: FOLLOW_UP_COLUMNS.map(([, header]) => header),
  },
};

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  return String(value);
}

function renderColumns<TRow>(row: TRow, columns: ColumnTable<TRow>): string[] {
  return columns.map(([field]) => cell(row[field]));
}

/** Cells for one row, aligned to `SHEET_TABS[row.kind].headers`. */
export function renderRow(row: CommandCenterRow): string[] {
  switch (row.kind) {
    case "opportunity":
      return renderColumns(row, OPPORTUNITY_COLUMNS);
    case "application":
      return renderColumns(row, APPLICATION_COLUMNS);
    case "interview":
      return renderColumns(row, INTERVIEW_COLUMNS);
    case "follow_up":
      return renderColumns(row, FOLLOW_UP_COLUMNS);
  }
}

/**
 * Canonical content hash shared by every connector: sha256 over a key-sorted
 * JSON serialization, hex digest. Field order must not change the digest, and
 * both row adapters plus the service-side ledger must agree byte for byte — a
 * mismatch would make every push look changed forever. Keys are compared by
 * UTF-16 code unit, never `localeCompare`, whose ordering depends on the ICU
 * data present on the machine.
 */
export function hashRow(row: CommandCenterRow): string {
  const sorted = Object.fromEntries(
    Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/** 1-based column index to A1 letters: 1 -> "A", 27 -> "AA". */
export function columnLetter(index: number): string {
  let remaining = index;
  let letters = "";
  while (remaining > 0) {
    const rest = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letters;
}

/** A1 range covering one full row of a tab, e.g. `Opportunities!A7:O7`. */
export function rowRange(
  title: string,
  columnCount: number,
  rowNumber: number,
): string {
  return `${title}!A${rowNumber}:${columnLetter(columnCount)}${rowNumber}`;
}

/**
 * First row number in an A1 range such as `Applications!A7:L9` (Sheets returns
 * the written block in `updates.updatedRange`, which is how appended rows get
 * their real row numbers). Returns null when the range is absent or unparsable.
 */
export function parseRangeStartRow(range: string | undefined): number | null {
  if (!range) return null;
  const match = /![A-Z]+\$?(\d+)/.exec(range);
  if (!match) return null;
  const rowNumber = Number(match[1]);
  return Number.isInteger(rowNumber) && rowNumber > 0 ? rowNumber : null;
}
