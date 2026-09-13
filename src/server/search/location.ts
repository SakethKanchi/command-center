/**
 * Place text, compared the way a person means it.
 *
 * Job boards write one place a dozen ways — `"Toronto, Canada"`,
 * `"Toronto, ON, CA"`, `"Remote - US"`, `"Remote_USA"`, `"Québec"` — and the
 * candidate types one of them. The filter this replaces was
 * `lower(location) LIKE '%us%'`, which answers "Houston, TX" to a search for
 * the United States and answers nothing to `Quebec` when the row says
 * `Québec`. Both are the same mistake: a place is a set of named segments, not
 * a run of characters.
 *
 * A query string is one whole place — `"Toronto, Canada"` means Toronto AND
 * Canada. Callers pass several such strings to mean OR. Nothing here re-splits
 * a caller's entry on commas; doing that upstream is what once turned
 * `locations=Toronto, Canada` into `Toronto OR Canada` and matched the corpus.
 */

import type { Db } from "@server/db";

/**
 * Segment separators. `" - "` is spaced deliberately: the bare hyphen belongs
 * to the name in `Sainte-Anne-de-Bellevue`, and splitting on it would shred
 * every French-Canadian city in the corpus.
 */
const SEPARATORS = /,|·|\||\/|;|\s+-\s+|\s+–\s+|\s+—\s+/;

/** Anything that is not a letter or digit is a word break once folded. */
const NON_WORD = /[^a-z0-9]+/g;
const COMBINING_MARKS = /\p{M}+/gu;

/**
 * Fold place text to a comparable form: lowercase, diacritic-stripped,
 * single-spaced.
 *
 * NFD splits `é` into `e` plus a combining acute, so dropping the marks leaves
 * the base letters. That is what makes `Québec` and `Quebec` the same place
 * without a per-accent substitution table.
 */
export function normalizeLocation(value: string): string {
  return value
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(NON_WORD, " ")
    .trim();
}

/**
 * The two-letter codes that are BOTH a US state or Canadian province and an
 * ISO-3166 country — the entire reason a trailing two-letter segment cannot be
 * read as a country on sight. `"Fremont, CA"` is California, not Canada.
 *
 * Enumerated by intersecting the 63 US/CA subdivision codes with the 280
 * regions ICU recognises; a subdivision code that is not also a country code
 * never reaches a country lookup, so it does not need to be listed.
 */
const AMBIGUOUS_CODES: Readonly<Record<string, true>> = {
  al: true,
  ar: true,
  as: true,
  az: true,
  ca: true,
  co: true,
  de: true,
  ga: true,
  gu: true,
  id: true,
  il: true,
  in: true,
  ky: true,
  la: true,
  ma: true,
  md: true,
  me: true,
  mn: true,
  mo: true,
  mp: true,
  ms: true,
  mt: true,
  nc: true,
  ne: true,
  nh: true,
  nl: true,
  nu: true,
  pa: true,
  pe: true,
  pr: true,
  sc: true,
  sd: true,
  sk: true,
  tn: true,
  va: true,
  vi: true,
  yt: true,
};

/**
 * Words that state how the work happens, not where. A place string in the wild
 * is very often one of these plus a country: `"Remote - US"`, `"Hybrid, NYC"`.
 */
export const WORK_MODE_WORDS: Readonly<Record<string, true>> = {
  remote: true,
  hybrid: true,
  onsite: true,
  "on site": true,
  "in office": true,
  "work from home": true,
  anywhere: true,
  distributed: true,
};

type CountryIndex = {
  /** Alpha-2 → every name it answers to, canonical name first. */
  codeToNames: Map<string, string[]>;
  nameToCode: Map<string, string>;
};

/**
 * Names ICU does not produce but people type. Deliberately short: this is for
 * abbreviations and endonyms that turn up in real postings, not a gazetteer.
 */
const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  usa: "US",
  us: "US",
  "u s": "US",
  "u s a": "US",
  america: "US",
  "united states of america": "US",
  uk: "GB",
  "u k": "GB",
  britain: "GB",
  "great britain": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  holland: "NL",
  deutschland: "DE",
  espana: "ES",
  uae: "AE",
};

/**
 * ISO-3166 names ↔ alpha-2 codes, read out of the ICU data Node already ships.
 *
 * Enumerating AA–ZZ and keeping what `DisplayNames` recognises gives every
 * assigned region with no table to maintain and no dependency. Built on first
 * use: 676 lookups are microseconds, but they are microseconds a process that
 * never filters by location should not spend.
 *
 * ICU also answers for RETIRED codes, and that is load-bearing rather than
 * cosmetic: it renders `UK`, `SU` and `FX` as United Kingdom, Russia and
 * France, so the last one to be enumerated won the name and
 * `countryCode("United Kingdom")` returned `UK`. That code then reached the
 * stored `location_country` column, where it grouped under a country nothing
 * else uses and belonged to no region. `Intl.getCanonicalLocales` is the
 * authority on which of a pair is current, so an alias is dropped outright.
 */
let countryIndex: CountryIndex | null = null;

function countries(): CountryIndex {
  if (countryIndex) return countryIndex;

  const display = new Intl.DisplayNames(["en"], { type: "region" });
  const codeToNames = new Map<string, string[]>();
  const nameToCode = new Map<string, string>();

  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      const code = String.fromCharCode(first, second);
      let label: string | undefined;
      try {
        label = display.of(code);
      } catch {
        continue;
      }
      // An unassigned code comes back as itself.
      if (!label || label === code) continue;
      if (Intl.getCanonicalLocales(`und-${code}`)[0] !== `und-${code}`)
        continue;

      const name = normalizeLocation(label);
      const names = [name];
      // `Myanmar (Burma)` has to answer to `Myanmar`. The bracketed half is a
      // disambiguator, not part of the name a posting writes.
      const bare = name.includes(" ")
        ? normalizeLocation(label.split(" (")[0] ?? "")
        : "";
      if (bare && bare !== name && !nameToCode.has(bare)) {
        names.push(bare);
        nameToCode.set(bare, code);
      }
      codeToNames.set(code, names);
      nameToCode.set(name, code);
    }
  }

  for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) {
    nameToCode.set(alias, code);
    codeToNames.get(code)?.push(alias);
  }

  countryIndex = { codeToNames, nameToCode };
  return countryIndex;
}

/** `"canada"`, `"usa"`, `"CA"` → `"CA"`, `"US"`, `"CA"`. Null when unknown. */
export function countryCode(token: string): string | null {
  const normalized = normalizeLocation(token);
  if (!normalized) return null;
  const index = countries();
  const byName = index.nameToCode.get(normalized);
  if (byName) return byName;
  if (normalized.length === 2) {
    const upper = normalized.toUpperCase();
    if (index.codeToNames.has(upper)) return upper;
  }
  return null;
}

/**
 * Split a place string into its normalized, non-empty segments.
 * `"Toronto, ON, CA"` → `["toronto", "on", "ca"]`.
 */
export function locationSegments(value: string): string[] {
  const out: string[] = [];
  for (const part of value.split(SEPARATORS)) {
    const normalized = normalizeLocation(part);
    if (normalized) out.push(normalized);
  }
  return out;
}

/**
 * Which country a row's place text is in, or null when it does not say.
 *
 * Only the trailing segment is considered — that is the country position — and
 * a two-letter code there is read as a country unless it could be a US or
 * Canadian subdivision, in which case what precedes it has to rule that
 * reading out:
 *
 * - `"Toronto, Canada"` → CA, stated by name.
 * - `"Remote - US"` → US. No state's code is `US`.
 * - `"Toronto, ON, CA"` → CA. A subdivision cannot follow a subdivision, so a
 *   two-letter predecessor makes the tail the country.
 * - `"Canada - Remote"`, `"Hybrid, CA"` → CA. A work-mode word is not a place
 *   a subdivision could belong to.
 * - `"Fremont, CA"` → null. California, and answering Canada here is exactly
 *   the false positive the old substring filter produced.
 */
export function locationCountry(segments: readonly string[]): string | null {
  const tail = segments.at(-1);
  if (!tail) return null;
  const code = countryCode(tail);
  if (!code) return null;
  if (!AMBIGUOUS_CODES[tail]) return code;
  if (segments.length === 1) return code;

  const previous = segments.at(-2);
  if (!previous) return code;
  if (previous.length === 2 || WORK_MODE_WORDS[previous]) return code;
  return null;
}

/**
 * Does `location` satisfy the place the candidate asked for?
 *
 * The query's own segments are AND-ed: `"Toronto, Canada"` means both, so a
 * Toronto in Ohio is not an answer. Each segment matches a named segment of
 * the row, or appears in it at word boundaries — which is how `"usa"` reaches
 * `"Remote_USA"`, a row with no separators at all, while `"us"` still cannot
 * reach `"Houston"`. A country named either way matches a row that states it
 * the other way.
 *
 * One relaxation, and it is the difference between working and not on real
 * data: a live discovery for `"Toronto, Canada"` returns rows stating
 * `"Toronto, Ontario"` and `"Toronto - Bay St"`, which name the city and say
 * nothing about the country. A country the candidate named is forgiven when
 * the row is silent about its own AND something more specific in the query
 * did match. Naming a city and its country must not be stricter than naming
 * the city alone. A row that states a DIFFERENT country still loses, so
 * `"Toronto, OH, US"` is not an answer to `"Toronto, Canada"`, and a query
 * that is only a country is never forgiven — `"us"` still cannot reach
 * `"Houston, TX"`.
 */
export function matchesLocation(
  location: string | null | undefined,
  query: string,
): boolean {
  const wanted = locationSegments(query);
  if (wanted.length === 0) return true;
  if (!location) return false;

  const segments = locationSegments(location);
  // The folded row is space-delimited, so padding both ends turns `includes`
  // into a whole-word test and keeps `us` out of `houston`.
  const padded = ` ${normalizeLocation(location)} `;
  const rowCountry = locationCountry(segments);
  // Resolved lazily: most queries are a bare city and never reach it.
  let countryNames: string[] | null = null;
  let matchedSpecific = false;
  let unstatedCountries = 0;

  for (const segment of wanted) {
    if (segments.includes(segment) || padded.includes(` ${segment} `)) {
      if (!countryCode(segment)) matchedSpecific = true;
      continue;
    }
    if (rowCountry) {
      if (countryCode(segment) === rowCountry) continue;
      countryNames ??= countries().codeToNames.get(rowCountry) ?? [];
      if (countryNames.includes(segment)) continue;
      // The row names a country, and it is not this one.
      return false;
    }
    if (!countryCode(segment)) return false;
    unstatedCountries += 1;
  }

  return unstatedCountries === 0 || matchedSpecific;
}

/** True when any of the OR-ed location entries is satisfied. */
export function matchesAnyLocation(
  location: string | null | undefined,
  queries: readonly string[],
): boolean {
  if (queries.length === 0) return true;
  for (const query of queries) {
    if (matchesLocation(location, query)) return true;
  }
  return false;
}

type LocationCount = { value: string; count: number };

/**
 * Merge place strings that say the same thing twice.
 *
 * The corpus holds both `"Singapore"` and `"Singapore, Singapore"`, and
 * `"Québec"` alongside `"Quebec"`. Each pair matches the other under
 * `matchesLocation`, so picking either entry returns both sets of rows —
 * offering them as two choices with the count split between them misstates
 * both. Grouped by segment sequence with repeats collapsed, which is why
 * `"Toronto, Canada"` and `"Toronto, ON, Canada"` stay apart: they differ by
 * more than a repetition.
 *
 * The surviving label is the spelling the corpus states most often, so what
 * the candidate picks is a place some posting literally says.
 */
function foldLocationCounts(
  rows: readonly LocationCount[],
  limit: number,
): LocationCount[] {
  const merged = new Map<string, LocationCount>();
  for (const row of rows) {
    // Distinct segments, order preserved. A value that folds to nothing keeps
    // its own identity rather than colliding with every other such value.
    const key =
      [...new Set(locationSegments(row.value))].join("|") || row.value;
    const group = merged.get(key);
    if (group) group.count += Number(row.count);
    else merged.set(key, { value: row.value, count: Number(row.count) });
  }
  // Re-sorted because merging can lift a group past one that outranked it.
  return [...merged.values()]
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, limit);
}

/**
 * Distinct stated locations, most frequent first.
 *
 * Raw rather than normalized on purpose: these strings go straight back into
 * the `locations` filter as a typeahead pick, so what the candidate selects has
 * to be a place the corpus literally says.
 */
export function listKnownLocations(db: Db, limit: number): LocationCount[] {
  // Unlimited in SQL: the cap has to apply after equivalent spellings merge,
  // or it truncates the list before the merge can promote anything.
  const rows = db
    .prepare(
      `SELECT location AS value, COUNT(*) AS count
         FROM jobs
        WHERE location IS NOT NULL AND trim(location) != ''
        GROUP BY location
        ORDER BY count DESC, value ASC`,
    )
    .all() as unknown as LocationCount[];
  return foldLocationCounts(rows, Math.max(1, Math.trunc(limit)));
}

/**
 * Resolve OR-ed location queries to the exact stated locations they match.
 *
 * The comparison has to run in JS — diacritic folding and country-code
 * equivalence are not expressible in SQLite's `LIKE` — but the corpus holds a
 * few hundred distinct place strings however many rows it has, so matching the
 * distinct set once and handing SQL an `IN` list keeps paging, ordering and
 * every facet a single indexed query.
 */
export function resolveLocationValues(
  db: Db,
  queries: readonly string[],
): string[] {
  const stated = db
    .prepare(
      `SELECT DISTINCT location AS value
         FROM jobs
        WHERE location IS NOT NULL AND trim(location) != ''`,
    )
    .all() as unknown as Array<{ value: string }>;

  const matched: string[] = [];
  for (const row of stated) {
    if (matchesAnyLocation(row.value, queries)) matched.push(row.value);
  }
  return matched;
}

/** Stated locations present in the filtered set, most frequent first. */
export function countLocations(
  db: Db,
  whereSql: string,
  params: Array<string | number | null>,
  limit: number,
): LocationCount[] {
  const stated = "location IS NOT NULL AND trim(location) != ''";
  const scoped = whereSql ? `${whereSql} AND ${stated}` : ` WHERE ${stated}`;
  const rows = db
    .prepare(
      `SELECT location AS value, COUNT(*) AS count FROM jobs${scoped}
       GROUP BY location ORDER BY count DESC, value ASC`,
    )
    .all(...params) as unknown as LocationCount[];
  return foldLocationCounts(rows, limit);
}
