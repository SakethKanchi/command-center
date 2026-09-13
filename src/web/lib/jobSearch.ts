import type {
  JobRegion,
  JobSearchQuery,
  JobSearchResult,
  JobSort,
  JobStatus,
} from "@domain";
import { isJobTag, JOB_REGIONS, JOB_SORTS, JOB_STATUSES } from "@domain";
import { request } from "@web/lib/api";

/**
 * The one codec between the browser URL and the search endpoint.
 *
 * The address bar and the API take the same parameter names on purpose: the
 * URL *is* the query, so a pasted link, a refresh and a back button all
 * reconstruct the same result set without a translation layer that could drift
 * from the server's reader.
 */

/**
 * The server's own default. Kept here only so a clean URL means page one of
 * 25; clamping to the server's maximum is the server's job, not a second copy
 * of the rule that could drift from it.
 */
export const DEFAULT_LIMIT = 25;

/**
 * Display order and wording for the contract's sorts. `Record<JobSort, …>`
 * is load-bearing: a sort added, renamed or dropped upstream breaks this
 * table instead of silently shipping an unknown value or losing a control.
 * Recency leads because that is what a daily job search actually scans.
 */
const SORT_LABELS: Record<JobSort, string> = {
  newest: "Newest",
  score: "Best fit",
  salary: "Salary",
  relevance: "Relevance",
};

export const SORT_OPTIONS: ReadonlyArray<{ value: JobSort; label: string }> = (
  Object.keys(SORT_LABELS) as JobSort[]
).map((value) => ({ value, label: SORT_LABELS[value] }));

export const DEFAULT_SORT: JobSort = "newest";

const NUMERIC_KEYS = [
  "minYears",
  "maxYears",
  "minScore",
  "maxScore",
  "postedWithinDays",
  "minSalary",
  "limit",
  "offset",
] as const;

/**
 * Reads a list param.
 *
 * `splitOnComma` is per-key and load-bearing. A status is an enum and a source
 * is a slug, so neither can contain a comma and CSV is a compact way to carry
 * them. A location routinely does contain one — the live corpus is full of
 * "Toronto, Canada" — and splitting that yields ["Toronto", "Canada"], which
 * the server ORs as substring matches. Every city then collapses to the same
 * country-wide result set, so picking Vancouver returns Toronto's postings.
 */
function readList(
  params: URLSearchParams,
  key: string,
  splitOnComma: boolean,
): string[] {
  const values: string[] = [];
  for (const raw of params.getAll(key)) {
    for (const part of splitOnComma ? raw.split(",") : [raw]) {
      const value = part.trim();
      if (value && !values.includes(value)) values.push(value);
    }
  }
  return values;
}

function readInt(params: URLSearchParams, key: string): number | undefined {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function readBool(params: URLSearchParams, key: string): boolean | undefined {
  const raw = params.get(key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

export function parseSearchQuery(params: URLSearchParams): JobSearchQuery {
  const query: JobSearchQuery = {};

  const q = params.get("q")?.trim();
  if (q) query.q = q;

  const statuses = readList(params, "statuses", true).filter(
    (value): value is JobStatus =>
      (JOB_STATUSES as readonly string[]).includes(value),
  );
  if (statuses.length > 0) query.statuses = statuses;

  const sources = readList(params, "sources", true);
  if (sources.length > 0) query.sources = sources;

  const locations = readList(params, "locations", false);
  if (locations.length > 0) query.locations = locations;

  const countries = readList(params, "countries", true)
    .filter((value) => /^[A-Za-z]{2}$/.test(value))
    .map((value) => value.toUpperCase());
  if (countries.length > 0) query.countries = countries;

  const regions = readList(params, "regions", true).filter(
    (value): value is JobRegion =>
      (JOB_REGIONS as readonly string[]).includes(value),
  );
  if (regions.length > 0) query.regions = regions;

  const remote = readBool(params, "remote");
  if (remote !== undefined) query.remote = remote;

  // A toggle, not a tri-state: nobody searches for postings that hide the
  // salary, so only the positive value round-trips through the URL.
  if (readBool(params, "hasSalary") === true) query.hasSalary = true;

  for (const key of NUMERIC_KEYS) {
    const value = readInt(params, key);
    if (value !== undefined) query[key] = value;
  }

  // A stale link carrying a retired tag must degrade to a wider search, not
  // a request the API rejects.
  const tags = readList(params, "tags", false).filter(isJobTag);
  if (tags.length > 0) query.tags = tags;

  const sort = params.get("sort");
  if (sort !== null && (JOB_SORTS as readonly string[]).includes(sort)) {
    query.sort = sort as JobSort;
  }

  return query;
}

/**
 * Fixed key order, and defaults left out. Both matter: a stable string lets
 * the URL hook recognise its own writes, and omitting `offset=0` keeps a
 * shared link free of noise.
 */
export function searchQueryToParams(query: JobSearchQuery): URLSearchParams {
  const params = new URLSearchParams();

  const q = query.q?.trim();
  if (q) params.set("q", q);
  if (query.statuses?.length) params.set("statuses", query.statuses.join(","));
  if (query.sources?.length) params.set("sources", query.sources.join(","));
  // Repeated keys, not CSV: a location contains its own commas, so joining
  // them would be indistinguishable from two separate places.
  for (const location of query.locations ?? []) {
    params.append("locations", location);
  }

  if (query.countries?.length) {
    params.set("countries", query.countries.join(","));
  }
  if (query.regions?.length) {
    params.set("regions", query.regions.join(","));
  }
  if (query.remote !== undefined) params.set("remote", String(query.remote));

  // Written whenever defined, including zero: `minYears=0` ("entry level and
  // up") is a different search from an absent `minYears` ("any experience").
  if (query.minYears !== undefined) {
    params.set("minYears", String(query.minYears));
  }
  if (query.maxYears !== undefined) {
    params.set("maxYears", String(query.maxYears));
  }
  if (query.minScore !== undefined) {
    params.set("minScore", String(query.minScore));
  }
  if (query.maxScore !== undefined) {
    params.set("maxScore", String(query.maxScore));
  }
  if (query.postedWithinDays !== undefined) {
    params.set("postedWithinDays", String(query.postedWithinDays));
  }
  if (query.hasSalary) params.set("hasSalary", "true");
  if (query.minSalary !== undefined) {
    params.set("minSalary", String(query.minSalary));
  }
  // Repeated keys, not CSV, mirroring locations above: a tag carries a colon
  // but never a comma.
  for (const tag of query.tags ?? []) {
    params.append("tags", tag);
  }
  if (query.sort && query.sort !== DEFAULT_SORT) params.set("sort", query.sort);
  if (query.limit !== undefined && query.limit !== DEFAULT_LIMIT) {
    params.set("limit", String(query.limit));
  }
  if (query.offset) params.set("offset", String(query.offset));

  return params;
}

/**
 * Raised when a response arrives for a query the user has already moved on
 * from. Callers discard it instead of surfacing it, because nothing failed.
 */
export class SearchAborted extends Error {
  constructor() {
    super("Search superseded by a newer query.");
    this.name = "SearchAborted";
  }
}

export async function searchJobs(
  query: JobSearchQuery,
  signal?: AbortSignal,
): Promise<JobSearchResult> {
  const search = searchQueryToParams(query).toString();
  const path = search ? `/api/jobs/search?${search}` : "/api/jobs/search";

  let result: JobSearchResult;
  try {
    result = await request<JobSearchResult>(
      path,
      signal ? { signal } : undefined,
    );
  } catch (cause) {
    throw signal?.aborted ? new SearchAborted() : cause;
  }

  /*
   * Aborting the transport is only best effort: a response already on the wire
   * still lands, and a slow one landing after a newer one would overwrite
   * fresh results with stale ones. Re-checking the signal *after* the await is
   * what actually makes the last query issued the one that wins.
   */
  if (signal?.aborted) throw new SearchAborted();
  return result;
}
