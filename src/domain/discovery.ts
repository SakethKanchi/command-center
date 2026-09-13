/**
 * Discovery: going out and asking the boards, as opposed to filtering the rows
 * already stored.
 *
 * The report is deliberately per-source and deliberately partial. One board
 * being down, renamed, rate-limited or unusable without a company token is the
 * normal case, and a discovery that returns one board's postings plus three
 * stated reasons is useful where a single collapsed failure is not.
 */

export type DiscoverRequest = {
  /** Keywords to ask the boards for. */
  query?: string;
  /**
   * Free-text place — `"Toronto"`, `"Canada"`, `"Toronto, Canada"`,
   * `"Remote - US"`. Translated per source into whatever that board actually
   * accepts, and applied locally when the board cannot express it.
   */
  location?: string;
  /** Work mode, when the candidate has an opinion. */
  remote?: boolean;
  /** Source ids from `GET /api/sources`. Defaults to every registered source. */
  sources?: string[];
  /**
   * Company board token per source id, for the ATS sources that publish one
   * company at a time — `{ greenhouse: "stripe" }`. A source that needs one and
   * has none is skipped with a reason rather than asked and failed.
   */
  boards?: Record<string, string>;
  limit?: number;
};

export type DiscoverSourceReport = {
  /** Source id, as `GET /api/sources` reports it. */
  source: string;
  fetched: number;
  /** Why this source contributed nothing. Set for a skip as well as a failure. */
  error?: string;
  /** True when no request was made at all, so the reason is not a fault. */
  skipped?: boolean;
  /**
   * What became of the filters — above all whether the place was applied by the
   * board or by us afterwards. A discovery that silently drops a location the
   * board ignored is the one outcome nobody can debug.
   */
  notes?: string[];
};

export type DiscoverResult = {
  /** Distinct postings across every source, after collapsing shared urls. */
  fetched: number;
  inserted: number;
  updated: number;
  bySource: DiscoverSourceReport[];
};

/** Distinct stated locations in the corpus, for the location typeahead. */
export type LocationsResult = {
  locations: Array<{ value: string; count: number }>;
};
