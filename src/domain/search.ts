/**
 * The job search contract.
 *
 * Shared verbatim by the HTTP layer and the dashboard: the query type is what a
 * URL's search params decode into, and `JobSearchResult` is what the endpoint
 * returns. Keeping both halves in one file is what stops the UI and the API
 * from drifting into two slightly different ideas of what "minYears" means.
 */

import type { Job, JobStatus } from "./jobs";
import type { JobRegion } from "./regions";
import type { JobTag, JobTagKind } from "./tags";

export const JOB_SORTS = ["relevance", "newest", "score", "salary"] as const;
export type JobSort = (typeof JOB_SORTS)[number];

export type JobSearchQuery = {
  /**
   * Free text over title, company, location, description.
   *
   * Grammar: bare words are AND-ed, `"a phrase"` stays whole, and a leading
   * `-` excludes — `react -contract` means React postings that never say
   * "contract". Exclusion is what makes one search box enough for a corpus
   * full of near-duplicate agency reposts.
   */
  q?: string;
  statuses?: JobStatus[];
  sources?: string[];
  /**
   * Places, OR-ed across entries. Each entry is ONE whole place string whose
   * own parts are AND-ed, so `"Toronto, Canada"` means Toronto AND Canada —
   * never comma-split an entry into two. Matching is diacritic- and
   * case-insensitive and treats a country name and its ISO alpha-2 code as the
   * same place.
   */
  locations?: string[];
  /**
   * Geography, rolled up. A posting states a city and, if you are lucky, a
   * country; `countries` (ISO alpha-2) and `regions` are derived from that one
   * string at write time so the coarse question can be asked without typing a
   * place name.
   *
   * OR-ed within each key and AND-ed across the three, which is what a rail
   * with three sections looks like: two countries widen, a country plus a city
   * narrows. A posting whose text names no country is not in any of them —
   * "Remote" is a work arrangement, not a place.
   */
  countries?: string[];
  regions?: JobRegion[];
  remote?: boolean;
  minScore?: number;
  maxScore?: number;
  /**
   * Experience window the candidate is shopping for, matched by OVERLAP against
   * the posting's own range — a 3-6 year posting answers a 5-10 year search.
   */
  minYears?: number;
  maxYears?: number;
  postedWithinDays?: number;
  hasSalary?: boolean;
  /**
   * Annualized pay floor, compared against the top of the posting's published
   * range. Postings whose pay does not parse are excluded while this is set,
   * for the same reason the years filter excludes unparsed ranges: claiming
   * they clear a floor nobody stated would be a guess.
   */
  minSalary?: number;
  /**
   * Namespaced tags (`skill:python`, `level:senior`), OR-ed within a kind and
   * AND-ed across kinds — so two skills widen the set and a skill plus a level
   * narrows it. Unknown values are rejected rather than ignored.
   */
  tags?: JobTag[];
  /** Defaults to `newest`. */
  sort?: JobSort;
  /** Defaults to 25, clamped to 1-100. */
  limit?: number;
  offset?: number;
};

export type FacetCount<T extends string = string> = { value: T; count: number };

export type JobSearchFacets = {
  sources: FacetCount[];
  statuses: FacetCount<JobStatus>[];
  remote: { remote: number; onsite: number; unknown: number };
  experience: Array<{
    label: string;
    minYears: number;
    maxYears: number | null;
    count: number;
  }>;
  /**
   * Stated places in the matching set, most frequent first and capped. Absent
   * when nothing in the set states a location.
   */
  locations?: FacetCount[];
  /**
   * The same geography rolled up, so the rail can offer "Canada 31" instead of
   * eight separate Ontario suburbs. Countries are ordered by count; regions
   * follow the vocabulary, being a closed set of five.
   */
  countries: FacetCount[];
  regions: FacetCount<JobRegion>[];
  /**
   * Tags present in the matching set, grouped kind by kind and ordered by the
   * vocabulary rather than by count, so a rail's rows do not reshuffle on
   * every keystroke.
   */
  tags: Array<{ kind: JobTagKind; value: string; tag: JobTag; count: number }>;
};

/**
 * A posting plus everything derived from its prose at write time: the
 * experience window, the annualized pay, and its tags.
 */
export type JobCard = Job & {
  experienceMinYears: number | null;
  experienceMaxYears: number | null;
  /** Top of the published range, annualized. Null when nothing parsed. */
  salaryAnnual: number | null;
  /** ISO alpha-2 read out of the place text, and its macro region. */
  locationCountry: string | null;
  locationRegion: JobRegion | null;
  tags: JobTag[];
};

export type JobSearchResult = {
  jobs: JobCard[];
  /** Matching rows ignoring limit/offset. */
  total: number;
  limit: number;
  offset: number;
  /**
   * Counts reflect every active filter EXCEPT the facet's own dimension, so the
   * numbers answer "what would I get if I picked that instead" rather than
   * collapsing to the current selection.
   */
  facets: JobSearchFacets;
};
