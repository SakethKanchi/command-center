import type { NewJob } from "@domain";
import {
  countryCode,
  locationSegments,
  matchesLocation,
} from "@server/search/location";
import {
  cleanText,
  type FetchJobsInput,
  fetchSourceJson,
  type HostAllowlist,
  htmlToText,
  joinLocations,
  type SourceAdapter,
  toIsoOrNull,
} from "./types";

/**
 * Jobicy — a keyless aggregator of remote-only postings.
 *
 * Every row carries its full description inline, so one keyword request
 * produces everything the scoring pass needs without a second fetch per
 * posting. The catch is the board's scope: it lists remote work and nothing
 * else, so the work mode is a property of the source rather than something to
 * be inferred per row.
 */
const JOBICY_HOSTS: HostAllowlist = {
  "jobicy.com": true,
};

const LABEL = "jobicy";
const SEARCH_URL = "https://jobicy.com/api/v2/remote-jobs";

/**
 * The documented ceiling on `count`. The live endpoint does honour larger
 * values — `count=200` really returns 200 rows — but an undocumented
 * generosity is not a contract, and a request that leans on it is one deploy
 * away from a 400.
 */
const MAX_COUNT = 50;

/**
 * The fields this adapter reads. The wire shape also carries `companyLogo`,
 * `jobSlug`, `jobIndustry`, `jobType` and `jobLevel`, none of which survive
 * into a `NewJob`.
 *
 * `jobGeo` is a region line rather than a place — "USA", "Anywhere",
 * "LATAM,  Canada,  USA" — and the separator really is a comma followed by two
 * spaces, which is why it is rejoined rather than passed through verbatim.
 */
type JobicyJob = {
  id?: number | string;
  url?: string;
  jobTitle?: string;
  companyName?: string;
  jobGeo?: string;
  jobExcerpt?: string;
  jobDescription?: string;
  pubDate?: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  salaryPeriod?: string | null;
};

type JobicyPayload = { jobs?: JobicyJob[] };

/**
 * The `geo` vocabulary, measured against the live endpoint rather than taken
 * from the docs, which are served behind a 403.
 *
 * This map matters more than a normal filter translation because an
 * unrecognised slug is a hard `HTTP 400`, not a silent zero: `geo=india` and
 * `geo=new york` both fail the whole request. So nothing may be sent that has
 * not been seen to return rows, and anything outside the table is filtered
 * locally instead.
 *
 * Country names route through `countryCode` so that every spelling of a place
 * the board does cover resolves for free — "UK", "United Kingdom", "GB" and
 * "Great Britain" all reduce to `GB` and then to `uk` — while the emitted
 * value stays inside the verified set. Regions have no ISO code and are keyed
 * by name.
 */
const GEO_BY_COUNTRY: Readonly<Record<string, string>> = {
  US: "usa",
  CA: "canada",
  GB: "uk",
  AU: "australia",
  DE: "germany",
  FR: "france",
  ES: "spain",
  NL: "netherlands",
  PL: "poland",
  IE: "ireland",
  BR: "brazil",
  JP: "japan",
  PH: "philippines",
  UA: "ukraine",
  SG: "singapore",
};

const GEO_BY_REGION: Readonly<Record<string, string>> = {
  europe: "europe",
  emea: "emea",
  apac: "apac",
  latam: "latam",
  "latin america": "latam",
  anywhere: "anywhere",
  worldwide: "anywhere",
  global: "anywhere",
};

/**
 * The board's own marker for a posting open to any country. A candidate who
 * typed a city the board cannot express is still eligible for these, so they
 * survive the local place filter that `matchesLocation` would otherwise
 * discard — "Anywhere" includes New York.
 */
const WORLDWIDE = /^(?:anywhere|worldwide|global)$/i;

/**
 * Resolve a free-text place to a slug the board accepts, or null.
 *
 * Segments are tried from the most specific end backwards so that
 * "Berlin, Germany" finds `germany` rather than stopping at the city, and a
 * place that resolves to nothing returns null rather than a guess — a guess
 * here costs the entire request.
 */
export function jobicyGeoSlug(location: string | undefined): string | null {
  for (const segment of locationSegments(location ?? "").reverse()) {
    const region = GEO_BY_REGION[segment];
    if (region) return region;
    const code = countryCode(segment);
    const slug = code ? GEO_BY_COUNTRY[code] : undefined;
    if (slug) return slug;
  }
  return null;
}

export function jobicySearchUrl(input: {
  query?: string;
  limit: number;
  geo?: string | null;
}): string {
  const params = new URLSearchParams({
    count: String(Math.max(1, Math.min(input.limit, MAX_COUNT))),
  });
  const query = input.query?.trim();
  // `tag` is the board's keyword parameter; it searches titles and bodies.
  if (query) params.set("tag", query);
  if (input.geo) params.set("geo", input.geo);
  return `${SEARCH_URL}?${params.toString()}`;
}

const SALARY_PERIOD_SUFFIX: Readonly<Record<string, string>> = {
  yearly: "/yr",
  monthly: "/mo",
  weekly: "/wk",
  daily: "/day",
  hourly: "/hr",
};

/**
 * A range with no period attached is ambiguous between a salary and an hourly
 * rate, and the scoring pass reads this string verbatim. The period is taken
 * from the payload rather than assumed annual: roughly one salaried row in ten
 * is `hourly`, and labelling a $24 rate as a yearly figure would be worse than
 * saying nothing.
 */
function formatSalary(job: JobicyJob): string | null {
  const min = typeof job.salaryMin === "number" ? job.salaryMin : null;
  const max = typeof job.salaryMax === "number" ? job.salaryMax : null;
  if (min === null && max === null) return null;
  const currency = job.salaryCurrency ? `${job.salaryCurrency} ` : "";
  const suffix = job.salaryPeriod
    ? (SALARY_PERIOD_SUFFIX[job.salaryPeriod.toLowerCase()] ?? "")
    : "";
  const amount =
    min !== null && max !== null && min !== max
      ? `${min.toLocaleString("en-US")}–${max.toLocaleString("en-US")}`
      : `${(min ?? max)?.toLocaleString("en-US")}`;
  return `${currency}${amount}${suffix}`;
}

/** Map one search payload to rows, stopping at the caller's limit. */
function mapJobs(payload: JobicyPayload | null, limit: number): NewJob[] {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const mapped: NewJob[] = [];

  for (const job of jobs) {
    const jobUrl = cleanText(job.url);
    const title = cleanText(job.jobTitle);
    // A posting with no link or no title cannot be applied to or displayed, so
    // it is dropped rather than stored as a row that can only ever fail.
    if (!jobUrl || !title) continue;

    // `joinLocations` both normalizes the doubled separator and drops the
    // repetition in lines like "Canada,  Canada" that the board occasionally
    // emits for a country listed twice.
    const location = joinLocations((job.jobGeo ?? "").split(","));
    const description = htmlToText(job.jobDescription);
    mapped.push({
      source: "jobicy",
      sourceJobId:
        job.id === undefined || job.id === null ? null : String(job.id),
      title,
      company: cleanText(job.companyName) ?? "Unknown",
      location,
      // Not inferred from the text: the board publishes remote work
      // exclusively, so a row whose geo reads "USA" is still remote-in-USA.
      isRemote: true,
      url: jobUrl,
      applyUrl: null,
      // The excerpt is the same prose truncated, so it is a fallback for a
      // body that arrived empty rather than an addition to it.
      descriptionText: description || htmlToText(job.jobExcerpt),
      salaryText: formatSalary(job),
      postedAt: toIsoOrNull(job.pubDate),
    });
    if (mapped.length >= limit) break;
  }

  return mapped;
}

export const jobicyAdapter: SourceAdapter = {
  id: "jobicy",
  label: "Jobicy",
  needsBoardToken: false,

  async fetchJobs(input: FetchJobsInput): Promise<NewJob[]> {
    const notes = input.notes;

    // Asking a remote-only board for on-site work has no honest answer. An
    // empty result with a reason is one; silently returning remote rows the
    // candidate ruled out is not.
    if (input.remote === false) {
      notes?.push("jobicy lists only remote work, so no rows can match");
      return [];
    }

    const wanted = input.location?.trim();
    const geo = jobicyGeoSlug(wanted);
    // A place the board cannot express is ours to match, and a local match has
    // to see more than the caller's first `limit` rows or a city query is
    // answered from whichever handful arrived first. `count` is the board's own
    // ceiling, so widening costs one request either way.
    const local = Boolean(wanted) && geo === null;
    const payload = (await fetchSourceJson({
      url: jobicySearchUrl({
        query: input.query,
        limit: local ? MAX_COUNT : input.limit,
        geo,
      }),
      label: LABEL,
      allowedHosts: JOBICY_HOSTS,
      fetchImpl: input.fetchImpl,
    })) as JobicyPayload | null;

    const mapped = mapJobs(payload, local ? MAX_COUNT : input.limit);
    if (!wanted) return mapped;
    if (geo) {
      notes?.push(`location "${wanted}" applied upstream as geo=${geo}`);
      return mapped;
    }

    // Worldwide postings survive the filter: on a remote-only board "Anywhere"
    // includes the city the candidate typed, and dropping them would answer
    // every city query with nothing.
    const before = mapped.length;
    const filtered = mapped.filter(
      (job) =>
        matchesLocation(job.location, wanted) ||
        WORLDWIDE.test(job.location ?? ""),
    );
    notes?.push(
      `jobicy has no geo slug for that place; filtered ${before} rows locally to ${filtered.length} for "${wanted}"`,
    );
    return filtered.slice(0, input.limit);
  },
};
