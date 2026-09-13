/**
 * The job search query.
 *
 * Free text runs as a `LIKE` scan over `search_blob`, a lowercased
 * `title | company | location | description` column written at ingest time.
 * FTS5 is deliberately not used: it is a compile-time option, and the SQLite
 * inside `node:sqlite` cannot be relied on to have it. At this corpus size the
 * scan is milliseconds, and one derived column cannot fall out of sync with its
 * own table the way a shadow index can.
 *
 * The SQL lives beside the search logic rather than in the repository because
 * facet counts are the same predicate set minus one dimension at a time. That
 * is query composition, not a fixed statement, and splitting the composer from
 * the predicates it composes would leave both halves unreadable.
 */

import type {
  JobSearchFacets,
  JobSearchQuery,
  JobSearchResult,
  JobSort,
  JobStatus,
  JobTag,
  JobTagKind,
} from "@domain";
import { JOB_REGIONS, JOB_STATUSES, JOB_TAG_KINDS, parseJobTag } from "@domain";
import type { Db } from "@server/db";
import { badRequest } from "@server/infra/errors";
import type { RepoBundle } from "@server/repos";
import { mapJobCard, selectJobTags } from "@server/repos/jobs";
import { countLocations, resolveLocationValues } from "./location";
import { TAG_ORDER } from "./tags";

type Bindable = string | number | null;
type Clause = { sql: string; params: Bindable[] };

/** Filters a facet can be asked to ignore when counting its own dimension. */
type Dimension =
  | "sources"
  | "statuses"
  | "remote"
  | "years"
  | "locations"
  | "tags"
  | "countries"
  | "regions";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * How many distinct places the locations facet reports. Enough to fill a
 * typeahead, few enough that a global corpus does not ship its whole gazetteer
 * on every search.
 */
const MAX_LOCATION_FACETS = 24;

/**
 * How many skills the tag facet reports. The closed kinds — level, employment,
 * eligibility — are always reported in full, because a zero there tells the
 * candidate the filter exists; the skill vocabulary is long enough that the
 * tail is noise in a rail.
 */
const MAX_SKILL_FACETS = 30;

/**
 * Stand-in for "no upper bound" in overlap arithmetic. The parser caps a
 * posting at 40 years, so nothing real can reach this.
 */
const OPEN_ENDED_YEARS = 1000;

/** Ranges the experience facet reports. They overlap postings, not partition them. */
const EXPERIENCE_BUCKETS: Array<{
  label: string;
  minYears: number;
  maxYears: number | null;
}> = [
  { label: "0-2 yrs", minYears: 0, maxYears: 2 },
  { label: "3-5 yrs", minYears: 3, maxYears: 5 },
  { label: "6-9 yrs", minYears: 6, maxYears: 9 },
  { label: "10+ yrs", minYears: 10, maxYears: null },
];

/**
 * `LIKE` gives `%` and `_` meaning, so a candidate searching for "100%" or
 * "back_end" would otherwise match the entire corpus. The escape character
 * itself has to be escaped first, or `\%` typed by a user becomes a literal
 * backslash followed by a live wildcard.
 */
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

const LIKE = "LIKE ? ESCAPE '\\'";

/**
 * Split free text into match units.
 *
 * A quoted `"exact phrase"` stays whole, bare words are AND-ed, and a leading
 * `-` turns a unit into an exclusion: `react -contract` is React postings that
 * never say "contract". Exclusion earns its place on a board corpus, where the
 * fastest way to a usable list is usually subtracting one agency's vocabulary
 * rather than adding another keyword.
 */
function parseSearchTerms(q: string | undefined): {
  include: string[];
  exclude: string[];
} {
  const include: string[] = [];
  const exclude: string[] = [];
  if (!q) return { include, exclude };

  const tokens = /(-)?"([^"]*)"|(-)?(\S+)/g;
  for (let hit = tokens.exec(q); hit; hit = tokens.exec(q)) {
    const negated = (hit[1] ?? hit[3]) === "-";
    const term = (hit[2] ?? hit[4] ?? "").trim().toLowerCase();
    // A bare `-` is a typo mid-edit, not an exclusion of everything.
    if (!term) continue;
    (negated ? exclude : include).push(term);
  }
  return { include, exclude };
}

type Filters = {
  /** Always applied. */
  shared: Clause[];
  /** Applied except when counting that dimension's own facet. */
  byDimension: Partial<Record<Dimension, Clause>>;
};

/**
 * OR within a kind, AND across kinds.
 *
 * Two skills widen the set — a candidate who knows Python and Go wants either
 * — while a skill plus a level narrows it, which is the only reading of a
 * multi-kind selection that matches what the rail looks like. One `EXISTS` per
 * kind expresses exactly that, and each one rides the `(tag, job_id)` index.
 *
 * Every tag is known by the time this runs: `validate` rejects an unknown one
 * by name rather than letting it become an empty result the candidate would
 * read as "no such job exists".
 */
function tagClause(tags: JobTag[] | undefined): Clause | null {
  if (!tags || tags.length === 0) return null;

  const byKind: Partial<Record<JobTagKind, JobTag[]>> = {};
  for (const tag of tags) {
    const kind = tag.slice(0, tag.indexOf(":")) as JobTagKind;
    const selected = byKind[kind];
    if (selected) selected.push(tag);
    else byKind[kind] = [tag];
  }

  const clauses: Clause[] = [];
  for (const kind of JOB_TAG_KINDS) {
    const selected = byKind[kind];
    if (!selected) continue;
    clauses.push({
      sql: `EXISTS (SELECT 1 FROM job_tags WHERE job_tags.job_id = jobs.id
                      AND job_tags.tag IN (${selected.map(() => "?").join(", ")}))`,
      params: selected,
    });
  }

  return {
    sql: clauses.map((clause) => `(${clause.sql})`).join(" AND "),
    params: clauses.flatMap((clause) => clause.params),
  };
}

function buildFilters(
  db: Db,
  query: JobSearchQuery,
  terms: { include: string[]; exclude: string[] },
): Filters {
  const shared: Clause[] = [];
  const byDimension: Partial<Record<Dimension, Clause>> = {};

  for (const term of terms.include) {
    shared.push({ sql: `search_blob ${LIKE}`, params: [likeContains(term)] });
  }
  for (const term of terms.exclude) {
    shared.push({
      sql: `search_blob NOT ${LIKE}`,
      params: [likeContains(term)],
    });
  }

  if (query.locations && query.locations.length > 0) {
    // Matched against the location column, not the blob: a posting whose
    // description name-drops Berlin is not a Berlin job. A remote posting with
    // no stated location is reached through the remote filter instead.
    //
    // The comparison itself runs in JS over the distinct location strings
    // (`Québec` vs `Quebec`, `Canada` vs `CA` — neither is expressible in
    // SQLite's LIKE), and SQL is handed the exact values that matched. The
    // corpus has a few hundred distinct places, comfortably inside SQLite's
    // bound-parameter limit.
    const values = resolveLocationValues(db, query.locations);
    byDimension.locations =
      values.length > 0
        ? {
            sql: `location IN (${values.map(() => "?").join(", ")})`,
            params: values,
          }
        : // Nothing in the corpus is in that place. An empty IN list is not
          // valid SQL, so the impossible predicate says it instead.
          { sql: "0", params: [] };
  }

  // Both read a column derived at write time, so neither pays the place-text
  // parse per query. A posting whose text named no country is in neither: it
  // is unknown, not everywhere.
  if (query.countries && query.countries.length > 0) {
    const codes = query.countries.map((code) => code.toUpperCase());
    byDimension.countries = {
      sql: `location_country IN (${codes.map(() => "?").join(", ")})`,
      params: codes,
    };
  }

  if (query.regions && query.regions.length > 0) {
    byDimension.regions = {
      sql: `location_region IN (${query.regions.map(() => "?").join(", ")})`,
      params: [...query.regions],
    };
  }

  // An unscored row is "not yet judged", not "judged zero". A floor of 0 and a
  // ceiling of 100 are therefore no-ops rather than filters that would quietly
  // hide everything the agent has not looked at yet.
  if (query.minScore !== undefined && query.minScore > 0) {
    shared.push({ sql: "score >= ?", params: [query.minScore] });
  }
  if (query.maxScore !== undefined && query.maxScore < 100) {
    shared.push({ sql: "score <= ?", params: [query.maxScore] });
  }

  if (query.postedWithinDays !== undefined) {
    // Many boards never publish a posting date, so discovery is the fallback.
    // ISO-8601 UTC sorts lexicographically, which is why a string compare is a
    // date compare here.
    const cutoff = new Date(
      Date.now() - query.postedWithinDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    shared.push({
      sql: "COALESCE(posted_at, discovered_at) >= ?",
      params: [cutoff],
    });
  }

  if (query.hasSalary !== undefined) {
    shared.push({
      sql: query.hasSalary
        ? "salary_text IS NOT NULL AND trim(salary_text) != ''"
        : "(salary_text IS NULL OR trim(salary_text) = '')",
      params: [],
    });
  }

  if (query.minSalary !== undefined) {
    // A posting whose pay did not parse is dropped, not kept: claiming it
    // clears a floor nobody stated would be a guess, and the candidate who set
    // a floor is shopping on pay. `hasSalary` remains the way to ask the
    // weaker question.
    shared.push({
      sql: "salary_annual IS NOT NULL AND salary_annual >= ?",
      params: [query.minSalary],
    });
  }

  if (query.sources && query.sources.length > 0) {
    byDimension.sources = {
      sql: `source IN (${query.sources.map(() => "?").join(", ")})`,
      params: [...query.sources],
    };
  }

  if (query.statuses && query.statuses.length > 0) {
    byDimension.statuses = {
      sql: `status IN (${query.statuses.map(() => "?").join(", ")})`,
      params: [...query.statuses],
    };
  }

  if (query.remote !== undefined) {
    byDimension.remote = {
      sql: query.remote ? "is_remote = 1" : "is_remote = 0",
      params: [],
    };
  }

  const years = experienceOverlap(query.minYears, query.maxYears);
  if (years) byDimension.years = years;

  const tags = tagClause(query.tags);
  if (tags) byDimension.tags = tags;

  return { shared, byDimension };
}

/**
 * Overlap, not containment: a posting asking for 3-6 years answers a 5-10 year
 * search, because the candidate clears its floor.
 *
 * Postings whose range could not be parsed are excluded whenever a years filter
 * is set. Including them would claim they fit when nothing is known, and
 * dropping them silently from an unfiltered list would hide most of the board —
 * so they are visible until the moment the candidate asks about years.
 */
function experienceOverlap(
  minYears: number | undefined,
  maxYears: number | undefined,
): Clause | null {
  if (minYears === undefined && maxYears === undefined) return null;
  return {
    sql: `(experience_min_years IS NOT NULL OR experience_max_years IS NOT NULL)
          AND COALESCE(experience_min_years, 0) <= ?
          AND COALESCE(experience_max_years, ${OPEN_ENDED_YEARS}) >= ?`,
    params: [maxYears ?? OPEN_ENDED_YEARS, minYears ?? 0],
  };
}

function where(filters: Filters, exclude?: Dimension): Clause {
  const clauses = [...filters.shared];
  for (const [dimension, clause] of Object.entries(filters.byDimension)) {
    if (dimension !== exclude && clause) clauses.push(clause);
  }
  if (clauses.length === 0) return { sql: "", params: [] };
  return {
    sql: ` WHERE ${clauses.map((clause) => `(${clause.sql})`).join(" AND ")}`,
    params: clauses.flatMap((clause) => clause.params),
  };
}

const NEWEST = "discovered_at DESC, rowid DESC";

/**
 * Relevance leans on where a term landed. Every returned row already contains
 * every term somewhere in the blob, so the blob itself carries no signal — a
 * hit in the title or the company name is what separates the results.
 */
function orderBy(
  sort: JobSort,
  terms: string[],
  q: string | undefined,
): Clause {
  if (sort === "score") {
    // `score IS NULL` sorts judged rows first. An unscored posting is not a
    // zero-scoring one, and must not be ranked as though it were.
    return { sql: `score IS NULL, score DESC, ${NEWEST}`, params: [] };
  }
  if (sort === "salary") {
    // Same rule as the score: pay that was never stated is not pay of zero, so
    // the unparsed rows go last rather than to the bottom of a numeric scale.
    return {
      sql: `salary_annual IS NULL, salary_annual DESC, ${NEWEST}`,
      params: [],
    };
  }
  if (sort === "relevance" && terms.length > 0) {
    const parts = terms.map(
      () =>
        "CASE WHEN instr(lower(title), ?) > 0 THEN 3 ELSE 0 END + " +
        "CASE WHEN instr(lower(company), ?) > 0 THEN 2 ELSE 0 END + " +
        "CASE WHEN instr(lower(COALESCE(location, '')), ?) > 0 THEN 1 ELSE 0 END",
    );
    const params: Bindable[] = terms.flatMap((term) => [term, term, term]);

    // A title that carries the whole query outranks one that merely contains
    // the same words scattered apart.
    const phrase = (q ?? "").trim().toLowerCase();
    if (phrase) {
      parts.push("CASE WHEN instr(lower(title), ?) > 0 THEN 4 ELSE 0 END");
      params.push(phrase);
    }
    return { sql: `(${parts.join(" + ")}) DESC, ${NEWEST}`, params };
  }
  // `relevance` with nothing to be relevant to is just the newest board sweep.
  return { sql: NEWEST, params: [] };
}

function countFacet(
  db: Db,
  column: "source" | "status" | "location_country" | "location_region",
  clause: Clause,
): Array<{ value: string; count: number }> {
  const rows = db
    .prepare(
      `SELECT ${column} AS value, COUNT(*) AS count FROM jobs${clause.sql}
       GROUP BY ${column} ORDER BY count DESC, value ASC`,
    )
    .all(...clause.params) as unknown as Array<{
    value: string | null;
    count: number;
  }>;
  // The geography columns are sparse, and "did not say" is not a bucket a
  // candidate can filter on: a NULL row would render as a nameless option that
  // selects nothing.
  return rows.flatMap((row) =>
    row.value === null ? [] : [{ value: row.value, count: Number(row.count) }],
  );
}

/**
 * Tag counts for the matching set.
 *
 * The whole tags dimension is dropped from the predicate, like every other
 * facet drops its own: the numbers then answer "what would I get if I picked
 * that instead" rather than collapsing onto the current selection, which for a
 * multi-select rail is the only useful reading.
 *
 * Ordered by the vocabulary, not by count, so the rows under the candidate's
 * cursor do not reshuffle between two keystrokes. Skills are capped by count
 * first and then reordered, so the cap keeps the popular tail.
 */
function countTagFacets(db: Db, clause: Clause): JobSearchFacets["tags"] {
  const rows = db
    .prepare(
      `SELECT job_tags.tag AS tag, COUNT(*) AS count
         FROM job_tags JOIN jobs ON jobs.id = job_tags.job_id${clause.sql}
        GROUP BY job_tags.tag`,
    )
    .all(...clause.params) as unknown as Array<{
    tag: string;
    count: number;
  }>;

  // A tag a vocabulary change has since dropped is not offered: the query
  // layer would reject it, so a rail row for it could only ever 400.
  const counted: JobSearchFacets["tags"] = [];
  for (const row of rows) {
    const parsed = parseJobTag(row.tag);
    if (!parsed) continue;
    counted.push({
      kind: parsed.kind,
      value: parsed.value,
      tag: parsed.tag,
      count: Number(row.count),
    });
  }

  const skills = counted
    .filter((entry) => entry.kind === "skill")
    .toSorted((a, b) => b.count - a.count)
    .slice(0, MAX_SKILL_FACETS);
  const closed = counted.filter((entry) => entry.kind !== "skill");

  return [...closed, ...skills].toSorted(
    (a, b) => (TAG_ORDER[a.tag] ?? 0) - (TAG_ORDER[b.tag] ?? 0),
  );
}

/**
 * Regions in vocabulary order rather than by count. Five closed values, so
 * ordering them by frequency would reshuffle the same five rows every time the
 * candidate touched another filter.
 */
function orderRegions(
  counted: Array<{ value: string; count: number }>,
): JobSearchFacets["regions"] {
  return JOB_REGIONS.flatMap((region) => {
    const row = counted.find((entry) => entry.value === region);
    return row ? [{ value: region, count: row.count }] : [];
  });
}

function buildFacets(db: Db, filters: Filters): JobSearchFacets {
  const byStatus = countFacet(db, "status", where(filters, "statuses"));
  const statusCounts = Object.fromEntries(
    byStatus.map((row) => [row.value, row.count]),
  ) as Partial<Record<JobStatus, number>>;

  const remoteClause = where(filters, "remote");
  const remote = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN is_remote = 1 THEN 1 ELSE 0 END), 0) AS remote,
         COALESCE(SUM(CASE WHEN is_remote = 0 THEN 1 ELSE 0 END), 0) AS onsite,
         COALESCE(SUM(CASE WHEN is_remote IS NULL THEN 1 ELSE 0 END), 0) AS unknown
       FROM jobs${remoteClause.sql}`,
    )
    .get(...remoteClause.params) as unknown as {
    remote: number;
    onsite: number;
    unknown: number;
  };

  // Bucket bounds are constants from this module, so they are inlined rather
  // than bound — it keeps the SELECT-list parameters from interleaving with the
  // WHERE clause's.
  const yearsClause = where(filters, "years");
  const bucketSums = EXPERIENCE_BUCKETS.map(
    (bucket, index) =>
      `COALESCE(SUM(CASE WHEN (experience_min_years IS NOT NULL OR experience_max_years IS NOT NULL)
         AND COALESCE(experience_min_years, 0) <= ${bucket.maxYears ?? OPEN_ENDED_YEARS}
         AND COALESCE(experience_max_years, ${OPEN_ENDED_YEARS}) >= ${bucket.minYears}
       THEN 1 ELSE 0 END), 0) AS bucket_${index}`,
  );
  const buckets = db
    .prepare(`SELECT ${bucketSums.join(", ")} FROM jobs${yearsClause.sql}`)
    .get(...yearsClause.params) as unknown as Record<string, number>;

  const locationClause = where(filters, "locations");

  return {
    sources: countFacet(db, "source", where(filters, "sources")),
    // The status set is closed, so every status is reported — a zero tells the
    // candidate the filter exists and is currently empty.
    statuses: JOB_STATUSES.map((status) => ({
      value: status,
      count: statusCounts[status] ?? 0,
    })),
    remote: {
      remote: Number(remote.remote),
      onsite: Number(remote.onsite),
      unknown: Number(remote.unknown),
    },
    // Counts can sum past `total`: a 3-6 year posting genuinely belongs to two
    // buckets, and splitting it would misreport both.
    experience: EXPERIENCE_BUCKETS.map((bucket, index) => ({
      ...bucket,
      count: Number(buckets[`bucket_${index}`] ?? 0),
    })),
    // Capped: a corpus with two thousand distinct place strings would ship a
    // facet no control can render and no candidate can read.
    locations: countLocations(
      db,
      locationClause.sql,
      locationClause.params,
      MAX_LOCATION_FACETS,
    ),
    // The rollups the raw place list cannot give: one "Canada 31" row instead
    // of eight Ontario suburbs. Uncapped — there are 249 countries and five
    // regions, and the corpus never states more than a handful of either.
    countries: countFacet(db, "location_country", where(filters, "countries")),
    regions: orderRegions(
      countFacet(db, "location_region", where(filters, "regions")),
    ),
    tags: countTagFacets(db, where(filters, "tags")),
  };
}

function validate(query: JobSearchQuery): void {
  // A non-finite bound reaches SQLite as a bind error nobody can read. Callers
  // that skip the HTTP layer get the same named rejection the router gives.
  for (const field of ["limit", "offset"] as const) {
    const value = query[field];
    if (value !== undefined && !Number.isFinite(value)) {
      throw badRequest(`${field} must be a number.`, { field });
    }
  }
  if (query.offset !== undefined && query.offset < 0) {
    throw badRequest("offset must be zero or greater.", { field: "offset" });
  }
  if (
    query.minYears !== undefined &&
    query.maxYears !== undefined &&
    query.minYears > query.maxYears
  ) {
    throw badRequest("minYears must not exceed maxYears.", {
      field: "minYears",
    });
  }
  if (
    query.minScore !== undefined &&
    query.maxScore !== undefined &&
    query.minScore > query.maxScore
  ) {
    throw badRequest("minScore must not exceed maxScore.", {
      field: "minScore",
    });
  }
  if (
    query.minSalary !== undefined &&
    (!Number.isFinite(query.minSalary) || query.minSalary <= 0)
  ) {
    throw badRequest("minSalary must be greater than zero.", {
      field: "minSalary",
    });
  }
  // Named, not swallowed: a tag nobody defined would otherwise come back as an
  // empty list the candidate reads as "no such job exists".
  for (const tag of query.tags ?? []) {
    if (parseJobTag(tag) === null) {
      throw badRequest(`Unknown tag "${tag}".`, { field: "tags" });
    }
  }
}

export function searchJobs(
  repos: RepoBundle,
  query: JobSearchQuery,
): JobSearchResult {
  validate(query);

  const db = repos.db;
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT)),
  );
  const offset = Math.trunc(query.offset ?? 0);
  const sort: JobSort = query.sort ?? "newest";

  const terms = parseSearchTerms(query.q);
  const filters = buildFilters(db, query, terms);
  const matched = where(filters);

  const counted = db
    .prepare(`SELECT COUNT(*) AS total FROM jobs${matched.sql}`)
    .get(...matched.params) as unknown as { total: number };
  const total = Number(counted.total);

  // Every sort is now an ORDER BY, pay included: `salary_annual` is derived at
  // write time, so ranking by pay no longer means pulling the whole matching
  // set into JS to parse "$180k - $220k" on every request.
  const order = orderBy(sort, terms.include, query.q);
  // `SELECT *` over `jobs`: the row shape is the table's, which is what
  // `mapJobCard` reads, and only the id is touched here.
  const rows = db
    .prepare(
      `SELECT * FROM jobs${matched.sql} ORDER BY ${order.sql} LIMIT ? OFFSET ?`,
    )
    .all(
      ...matched.params,
      ...order.params,
      limit,
      offset,
    ) as unknown as Array<{
    id: string;
  }>;

  // One tag query for the page rather than one per row.
  const tagsByJob = selectJobTags(
    db,
    rows.map((row) => row.id),
  );
  const jobs = rows.map((row) => mapJobCard(row, tagsByJob[row.id] ?? []));

  return { jobs, total, limit, offset, facets: buildFacets(db, filters) };
}
