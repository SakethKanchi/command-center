/**
 * Display formatting. Every timestamp crossing the API is an ISO-8601 UTC
 * string, so these all take strings and parse defensively: a malformed or
 * missing value renders as an em dash rather than "Invalid Date".
 */

const DASH = "—";

function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: string | null | undefined): string {
  const date = parseIso(value);
  if (!date) return DASH;
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(value: string | null | undefined): string {
  const date = parseIso(value);
  if (!date) return DASH;
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "4m ago" / "in 3d". `now` is injectable so tests stay deterministic. */
export function formatRelative(
  value: string | null | undefined,
  now: number = Date.now(),
): string {
  const date = parseIso(value);
  if (!date) return DASH;
  const delta = date.getTime() - now;
  const magnitude = Math.abs(delta);

  let amount: string;
  if (magnitude < MINUTE) amount = "just now";
  else if (magnitude < HOUR) amount = `${Math.round(magnitude / MINUTE)}m`;
  else if (magnitude < DAY) amount = `${Math.round(magnitude / HOUR)}h`;
  else amount = `${Math.round(magnitude / DAY)}d`;

  if (amount === "just now") return amount;
  return delta < 0 ? `${amount} ago` : `in ${amount}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return DASH;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Elapsed wall time of a run, whether or not it has finished. */
export function formatElapsed(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
  now: number = Date.now(),
): string {
  const start = parseIso(startedAt);
  if (!start) return DASH;
  const end = parseIso(completedAt)?.getTime() ?? now;
  return formatDuration(Math.max(0, end - start.getTime()));
}

/** `recruiter_screen` -> `Recruiter screen`. */
export function humanize(value: string | null | undefined): string {
  if (!value) return DASH;
  const spaced = value.replace(/[_-]+/g, " ").trim();
  if (!spaced) return DASH;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function pluralize(count: number, singular: string, plural?: string) {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}

/**
 * Ingest adapters disagree about whether the company belongs in the title, so
 * one corpus holds both "Senior Engineer" and "Senior Engineer at RBC". Every
 * surface that shows a title prints the company right next to it, which turns
 * that suffix into duplication eating the title's scarcest resource — width.
 *
 * Only an exact trailing " at <company>" is removed: a real title like
 * "Engineer at Scale" survives, because the company there is "Scale AI".
 */
export function titleWithoutCompany(title: string, company: string): string {
  if (company.length < 2) return title;
  const suffix = ` at ${company}`;
  if (!title.toLowerCase().endsWith(suffix.toLowerCase())) return title;
  const trimmed = title.slice(0, -suffix.length).trim();
  return trimmed.length > 0 ? trimmed : title;
}

/**
 * The experience window a posting asks for. An open end is real information —
 * "5+ yrs" is not the same claim as "5–10 yrs" — so each end is rendered only
 * when the parser actually found it.
 */
export function formatYearsRange(
  min: number | null | undefined,
  max: number | null | undefined,
): string {
  const low = typeof min === "number" && Number.isFinite(min) ? min : null;
  const high = typeof max === "number" && Number.isFinite(max) ? max : null;
  if (low === null && high === null) return DASH;
  if (low !== null && high === null) return `${low}+ yrs`;
  if (low === null) return `≤${high} yrs`;
  if (low === high) return `${low} yrs`;
  return `${low}–${high} yrs`;
}

/** Keeps long descriptions from pushing a row out of the viewport. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
