import type { JobSearchFacets, JobSearchQuery } from "@domain";
import { countryLabel, JOB_REGION_LABELS, tagLabel } from "@domain";
import { formatYearsRange, humanize } from "@web/lib/format";

/**
 * The active-filter model: what is switched on, how to say it in one phrase,
 * and the exact patch that turns it back off. Chips, the clear-all button and
 * the empty-state advice all read from this one list, so a filter can never be
 * applied to a search without being visible and removable.
 */

export type FilterDimension =
  | "q"
  | "statuses"
  | "sources"
  | "locations"
  | "remote"
  | "score"
  | "years"
  | "postedWithinDays"
  | "hasSalary"
  | "minSalary"
  | "countries"
  | "regions"
  | "tags";

export type FilterChip = {
  /** Unique per chip; a multi-select contributes one chip per value. */
  id: string;
  dimension: FilterDimension;
  label: string;
  /** Patch that removes exactly this chip and nothing else. */
  clear: Partial<JobSearchQuery>;
};

/** Highest experience the control offers; the top notch reads as "15+". */
export const YEARS_MAX = 15;

export const POSTED_WITHIN_OPTIONS: ReadonlyArray<{
  days: number;
  label: string;
}> = [
  { days: 1, label: "24h" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
];

function postedLabel(days: number): string {
  const known = POSTED_WITHIN_OPTIONS.find((option) => option.days === days);
  return known ? known.label : `${days}d`;
}

export function activeChips(query: JobSearchQuery): FilterChip[] {
  const chips: FilterChip[] = [];

  if (query.q) {
    chips.push({
      id: "q",
      dimension: "q",
      label: `“${query.q}”`,
      clear: { q: undefined },
    });
  }

  for (const value of query.statuses ?? []) {
    const rest = (query.statuses ?? []).filter((other) => other !== value);
    chips.push({
      id: `statuses:${value}`,
      dimension: "statuses",
      label: `status: ${humanize(value)}`,
      clear: { statuses: rest.length > 0 ? rest : undefined },
    });
  }

  for (const value of query.sources ?? []) {
    const rest = (query.sources ?? []).filter((other) => other !== value);
    chips.push({
      id: `sources:${value}`,
      dimension: "sources",
      label: `source: ${value}`,
      clear: { sources: rest.length > 0 ? rest : undefined },
    });
  }

  for (const value of query.locations ?? []) {
    const rest = (query.locations ?? []).filter((other) => other !== value);
    chips.push({
      id: `locations:${value}`,
      dimension: "locations",
      label: `in ${value}`,
      clear: { locations: rest.length > 0 ? rest : undefined },
    });
  }

  for (const value of query.regions ?? []) {
    const rest = (query.regions ?? []).filter((other) => other !== value);
    chips.push({
      id: `regions:${value}`,
      dimension: "regions",
      label: `in ${JOB_REGION_LABELS[value]}`,
      clear: { regions: rest.length > 0 ? rest : undefined },
    });
  }

  for (const value of query.countries ?? []) {
    const rest = (query.countries ?? []).filter((other) => other !== value);
    chips.push({
      id: `countries:${value}`,
      dimension: "countries",
      label: `in ${countryLabel(value)}`,
      clear: { countries: rest.length > 0 ? rest : undefined },
    });
  }

  if (query.remote !== undefined) {
    chips.push({
      id: "remote",
      dimension: "remote",
      label: query.remote ? "remote only" : "on-site only",
      clear: { remote: undefined },
    });
  }

  if (query.minYears !== undefined || query.maxYears !== undefined) {
    chips.push({
      id: "years",
      dimension: "years",
      label: formatYearsRange(query.minYears, query.maxYears),
      clear: { minYears: undefined, maxYears: undefined },
    });
  }

  if (query.minScore !== undefined || query.maxScore !== undefined) {
    chips.push({
      id: "score",
      dimension: "score",
      label: `fit ${query.minScore ?? 0}–${query.maxScore ?? 100}`,
      clear: { minScore: undefined, maxScore: undefined },
    });
  }

  if (query.postedWithinDays !== undefined) {
    chips.push({
      id: "postedWithinDays",
      dimension: "postedWithinDays",
      label: `posted ≤ ${postedLabel(query.postedWithinDays)}`,
      clear: { postedWithinDays: undefined },
    });
  }

  if (query.hasSalary) {
    chips.push({
      id: "hasSalary",
      dimension: "hasSalary",
      label: "salary listed",
      clear: { hasSalary: undefined },
    });
  }

  if (query.minSalary !== undefined) {
    chips.push({
      id: "minSalary",
      dimension: "minSalary",
      label: `$${query.minSalary / 1000}k+ pay`,
      clear: { minSalary: undefined },
    });
  }

  for (const tag of query.tags ?? []) {
    const rest = (query.tags ?? []).filter((other) => other !== tag);
    chips.push({
      id: `tags:${tag}`,
      dimension: "tags",
      label: tagLabel(tag),
      clear: { tags: rest.length > 0 ? rest : undefined },
    });
  }

  return chips;
}

/**
 * Dimensions with no facet to consult, most-likely-culprit first. Free text is
 * top because one typo empties any result set, and a pay floor sits just
 * under it because most postings publish pay that never parses into a
 * number; a status or source pick is at the bottom because it is usually
 * deliberate.
 */
const BLIND_CULPRIT_ORDER: readonly FilterDimension[] = [
  "q",
  "minSalary",
  "years",
  "score",
  "postedWithinDays",
  "hasSalary",
  "locations",
];

/**
 * How many rows each facet-backed selection still admits. Facet counts reflect
 * every filter except their own dimension, so a selection summing to zero is
 * provably the filter that emptied the result set rather than a guess.
 */
function facetAdmissions(
  query: JobSearchQuery,
  facets: JobSearchFacets,
): Partial<Record<FilterDimension, number>> {
  const admissions: Partial<Record<FilterDimension, number>> = {};

  if (query.statuses?.length) {
    admissions.statuses = facets.statuses.reduce(
      (total, facet) =>
        query.statuses?.includes(facet.value) ? total + facet.count : total,
      0,
    );
  }
  if (query.sources?.length) {
    admissions.sources = facets.sources.reduce(
      (total, facet) =>
        query.sources?.includes(facet.value) ? total + facet.count : total,
      0,
    );
  }
  if (query.remote !== undefined) {
    admissions.remote = query.remote
      ? facets.remote.remote
      : facets.remote.onsite;
  }
  // Both geography keys OR within themselves, so the admission is the sum of
  // the picked rows. A selected value the facet no longer reports admits
  // nothing, which is exactly what makes it nameable as the culprit.
  if (query.countries?.length) {
    admissions.countries = facets.countries.reduce(
      (total, facet) =>
        query.countries?.includes(facet.value) ? total + facet.count : total,
      0,
    );
  }
  if (query.regions?.length) {
    admissions.regions = facets.regions.reduce(
      (total, facet) =>
        query.regions?.includes(facet.value) ? total + facet.count : total,
      0,
    );
  }

  /*
   * Tags OR within a kind and AND across kinds, so the smallest selected
   * count is the honest dimension number: that tag can empty the set on its
   * own. A selected tag absent from the facets admits nothing.
   */
  if (query.tags?.length) {
    admissions.tags = Math.min(
      ...query.tags.map(
        (tag) => facets.tags.find((facet) => facet.tag === tag)?.count ?? 0,
      ),
    );
  }

  return admissions;
}

/**
 * The one filter worth offering to drop when a search comes back empty.
 * Returns null when nothing is filtered, which is the no-data-ingested case
 * rather than an over-narrowed search.
 */
export function narrowestFilter(
  query: JobSearchQuery,
  facets: JobSearchFacets | null,
): FilterChip | null {
  const chips = activeChips(query);
  if (chips.length === 0) return null;

  const byAdmission = Object.entries(
    facets ? facetAdmissions(query, facets) : {},
  ).sort(([, left], [, right]) => left - right);

  /*
   * Order of suspicion: a facet selection that admits nothing is proven
   * guilty; otherwise blame the dimensions with no facet to consult, because a
   * facet-backed filter that still admits rows cannot be the one that emptied
   * the set on its own; only then fall back to the tightest facet.
   */
  const starved = byAdmission.find(([, count]) => count === 0);
  const suspects: string[] = [
    ...(starved ? [starved[0]] : []),
    ...BLIND_CULPRIT_ORDER,
    ...byAdmission.map(([dimension]) => dimension),
  ];

  for (const dimension of suspects) {
    const chip = chips.find((candidate) => candidate.dimension === dimension);
    if (chip) return chip;
  }

  return chips[0] ?? null;
}
