/**
 * Macro regions.
 *
 * A place string on a job board is a city and sometimes a country, which makes
 * a raw location facet a list of cities: forty postings across the Greater
 * Toronto Area produce eight rows that all mean "Canada". The rollup exists so
 * the rail can answer the two questions a candidate actually starts with —
 * which continent, which country — before narrowing to a city.
 *
 * Five coarse buckets rather than a proper geoscheme: a region filter answers
 * "is this job on my continent", and a finer split would promise a precision
 * the posting text cannot support.
 */

export const JOB_REGIONS = [
  "north_america",
  "latam",
  "emea",
  "apac",
  "oceania",
] as const;
export type JobRegion = (typeof JOB_REGIONS)[number];

/**
 * Short enough for a 260px rail. "Europe, Middle East & Africa" is the honest
 * expansion, but it wraps past the count and the abbreviation is what every
 * job board uses anyway.
 */
export const JOB_REGION_LABELS: Record<JobRegion, string> = {
  north_america: "North America",
  latam: "Latin America",
  emea: "EMEA",
  apac: "Asia-Pacific",
  oceania: "Oceania",
};

/**
 * Country names for display, from the ICU data Node already ships. The server
 * stores and filters on the alpha-2 code, because that is the only spelling
 * every board agrees on; a name is presentation and is resolved at the edge.
 *
 * Falls back to the code itself: an unknown region is better shown as `XK`
 * than hidden.
 */
export function countryLabel(code: string): string {
  const names = new Intl.DisplayNames(["en"], {
    type: "region",
    fallback: "none",
  });
  return names.of(code.toUpperCase()) ?? code.toUpperCase();
}
