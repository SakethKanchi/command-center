import type { NewJob } from "@domain";
import { badRequest } from "@server/infra/errors";
import {
  countryCode,
  locationSegments,
  matchesLocation,
} from "@server/search/location";
import {
  cleanText,
  detectRemote,
  type FetchJobsInput,
  fetchSourceJson,
  type HostAllowlist,
  htmlToText,
  joinLocations,
  type SourceAdapter,
  toIsoOrNull,
} from "./types";

/**
 * freehire.me — a cross-board aggregator, and the only source here that works
 * without knowing which company to look at.
 *
 * The agent endpoint hydrates each hit's full description server-side, so a
 * single keyword search returns everything the scoring pass needs. That makes
 * it the source a cold demo can actually run against: no API key, no board
 * token, no per-posting fetch.
 */
const FREEHIRE_HOSTS: HostAllowlist = {
  "freehire.me": true,
  "www.freehire.me": true,
};

const LABEL = "freehire";
const DEFAULT_BASE_URL = "https://freehire.me";
const SEARCH_PATH = "/api/v1/agent/jobs/search";

/**
 * The fields this adapter reads. The wire shape carries considerably more
 * (skills, enrichment summary, a staleness verdict); `countries` and `regions`
 * arrive as lowercase ISO-3166 / region codes, and `location` is frequently
 * empty with the geography only in the facet arrays.
 */
type FreehireJob = {
  public_slug?: string;
  external_id?: string;
  source?: string;
  url?: string;
  title?: string;
  company?: string;
  location?: string;
  description?: string;
  work_mode?: string;
  regions?: string[];
  countries?: string[];
  cities?: string[];
  posted_at?: string | null;
  created_at?: string | null;
  enrichment?: {
    salary_min?: number;
    salary_max?: number;
    salary_currency?: string;
    salary_period?: string;
    employment_type?: string;
  };
};

/**
 * The geography vocabulary this endpoint actually accepts, measured against
 * the live service rather than assumed.
 *
 * `cities`, `countries` and `regions` are three views of ONE OR-ed dimension:
 * `cities=toronto` alone returns 5,061 postings, `countries=de` alone returns
 * ~11,700, and both together return 16,766 — a union, not an intersection. So
 * only the most specific tier may be sent; adding the country the candidate
 * also typed would widen `"Toronto, Canada"` to all of Canada.
 *
 * `work_mode` is a separate dimension and does intersect:
 * `cities=toronto&work_mode=remote` returns 401.
 *
 * Every one of these silently returns zero rows for a value outside its
 * vocabulary — `countries=canada` is 0 where `countries=ca` is 15,132, and
 * `work_mode=on_site` is 0 where `work_mode=onsite` is 37,014. A silent zero
 * is indistinguishable from "no such job", which is why a filtered request
 * that comes back empty is re-asked without the filter rather than reported as
 * no results.
 *
 * The city index is more capable than it looks and is trusted accordingly:
 * `cities=greater+toronto+area` returns 12 and
 * `cities=sainte-anne-de-bellevue` returns 1, so no shape guard sits in front
 * of it. Withholding a place because it did not look like a city name would
 * suppress a filter the board can actually serve.
 */
const WORK_MODES: Readonly<Record<string, string>> = {
  remote: "remote",
  hybrid: "hybrid",
  onsite: "onsite",
  "on site": "onsite",
  "in office": "onsite",
};

export type FreehireLocationPlan = {
  cities: string[];
  countries: string[];
  workMode: string | null;
};

/**
 * Translate a free-text place into the parameters this board honours.
 *
 * Cities beat countries because the dimension is OR-ed: `"Toronto, Canada"`
 * asks upstream for Toronto, and the `Canada` half is already implied by every
 * row Toronto returns.
 */
export function planFreehireLocation(input: {
  location?: string;
  remote?: boolean;
}): FreehireLocationPlan {
  const cities: string[] = [];
  const countries: string[] = [];
  let workMode: string | null =
    input.remote === undefined ? null : input.remote ? "remote" : "onsite";

  for (const segment of locationSegments(input.location ?? "")) {
    const mode = WORK_MODES[segment];
    if (mode) {
      // An explicit `remote` flag is the candidate's toggle and outranks a word
      // typed into the place box.
      workMode ??= mode;
      continue;
    }
    const code = countryCode(segment);
    if (code) {
      countries.push(code.toLowerCase());
      continue;
    }
    cities.push(segment);
  }

  // Only the most specific tier of the OR-ed geography dimension travels.
  return { cities, countries: cities.length > 0 ? [] : countries, workMode };
}

/**
 * Base URL, overridable for a self-hosted instance.
 *
 * The override is still held to the host allowlist downstream — an env var is
 * exactly the kind of half-trusted input that turns a self-hosting knob into
 * an SSRF primitive.
 */
export function freehireSearchUrl(input: {
  query?: string;
  limit: number;
  plan?: FreehireLocationPlan;
}): string {
  const base = process.env.FREEHIRE_API_URL?.trim() || DEFAULT_BASE_URL;
  const params = new URLSearchParams({
    limit: String(Math.max(1, Math.min(input.limit, 100))),
    offset: "0",
    // Keyword search; the semantic index is opt-in and slower.
    semantic_ratio: "0",
    include_description: "true",
    description_format: "text",
  });
  const query = input.query?.trim();
  if (query) params.set("q", query);

  const plan = input.plan;
  if (plan) {
    // Repeated keys rather than one comma-joined value: both are accepted, and
    // a repeated key cannot be broken by a place whose name contains a comma.
    for (const city of plan.cities) params.append("cities", city);
    for (const code of plan.countries) params.append("countries", code);
    if (plan.workMode) params.set("work_mode", plan.workMode);
  }

  try {
    return new URL(`${SEARCH_PATH}?${params.toString()}`, base).href;
  } catch {
    throw badRequest(`${LABEL}: FREEHIRE_API_URL is not a valid URL`, { base });
  }
}

/** The geography keys this adapter can send, for reading `meta.ignored_params`. */
const GEOGRAPHY_PARAMS = ["cities", "countries", "work_mode"] as const;

const SALARY_PERIOD_SUFFIX: Readonly<Record<string, string>> = {
  year: "/yr",
  month: "/mo",
  week: "/wk",
  day: "/day",
  hour: "/hr",
};

function formatSalary(enrichment: FreehireJob["enrichment"]): string | null {
  const min = enrichment?.salary_min;
  const max = enrichment?.salary_max;
  if (typeof min !== "number" && typeof max !== "number") return null;
  const currency = enrichment?.salary_currency
    ? `${enrichment.salary_currency} `
    : "";
  // Without the period a 29,505–57,225 range is ambiguous between a salary
  // and an hourly rate, and the scoring pass reads this string verbatim.
  const suffix = enrichment?.salary_period
    ? (SALARY_PERIOD_SUFFIX[enrichment.salary_period] ?? "")
    : "";
  const amount =
    typeof min === "number" && typeof max === "number"
      ? `${min.toLocaleString("en-US")}–${max.toLocaleString("en-US")}`
      : `${(min ?? max)?.toLocaleString("en-US")}`;
  return `${currency}${amount}${suffix}`;
}

type FreehirePayload = {
  data?: FreehireJob[];
  meta?: { ignored_params?: Array<{ param?: string }>; total?: number };
};

/** Map one search payload to rows, stopping at the caller's limit. */
function mapJobs(payload: FreehirePayload | null, limit: number): NewJob[] {
  const jobs = Array.isArray(payload?.data) ? payload.data : [];
  const mapped: NewJob[] = [];

  for (const job of jobs) {
    const jobUrl = cleanText(job.url);
    const title = cleanText(job.title);
    if (!jobUrl || !title) continue;

    // `location` is the posting's own line; the facet arrays are a normalized
    // read of the same place. When the posting states a location, use it
    // alone — appending the facets renders "Calgary, Canada · Calgary · CA",
    // three names for one city. The facets are the fallback, not an addition.
    const stated = cleanText(job.location);
    const location =
      stated ??
      joinLocations([
        ...(job.cities ?? []),
        ...(job.countries ?? []).map((code) =>
          code.length <= 3 ? code.toUpperCase() : code,
        ),
      ]);
    mapped.push({
      source: "freehire",
      sourceJobId: cleanText(job.public_slug) ?? cleanText(job.external_id),
      title,
      company: cleanText(job.company) ?? "Unknown",
      location,
      isRemote: detectRemote({
        workplaceType: job.work_mode,
        location: joinLocations([location, ...(job.regions ?? [])]),
      }),
      url: jobUrl,
      applyUrl: null,
      descriptionText: htmlToText(job.description),
      salaryText: formatSalary(job.enrichment),
      postedAt: toIsoOrNull(job.posted_at ?? job.created_at),
    });
    if (mapped.length >= limit) break;
  }

  return mapped;
}

/** Which of the geography keys we sent came back named as ignored. */
function ignoredGeography(payload: FreehirePayload | null): string[] {
  const ignored = payload?.meta?.ignored_params;
  if (!Array.isArray(ignored)) return [];
  const named: string[] = [];
  for (const entry of ignored) {
    const param = entry?.param;
    if (param && GEOGRAPHY_PARAMS.includes(param as "cities")) {
      named.push(param);
    }
  }
  return named;
}

export const freehireAdapter: SourceAdapter = {
  id: "freehire",
  label: "freehire.me",
  needsBoardToken: false,

  async fetchJobs(input: FetchJobsInput): Promise<NewJob[]> {
    const notes = input.notes;
    const wanted = input.location?.trim();
    const plan = planFreehireLocation({
      location: wanted,
      remote: input.remote,
    });
    const sent = [
      ...plan.cities.map((city) => `cities=${city}`),
      ...plan.countries.map((code) => `countries=${code}`),
    ];

    const request = async (withGeography: boolean) =>
      (await fetchSourceJson({
        url: freehireSearchUrl({
          query: input.query,
          limit: input.limit,
          plan: withGeography ? plan : { ...plan, cities: [], countries: [] },
        }),
        label: LABEL,
        allowedHosts: FREEHIRE_HOSTS,
        fetchImpl: input.fetchImpl,
      })) as FreehirePayload | null;

    let payload = await request(sent.length > 0);
    let mapped = mapJobs(payload, input.limit);

    if (!wanted) return mapped;

    // Two signals, both the board's own: it names what it ignored, and a
    // filtered request that returns nothing means the value was outside its
    // vocabulary. Anything else and the filter really was applied upstream.
    const ignored = ignoredGeography(payload);
    let reason: string;
    if (sent.length === 0) {
      // Place text that resolved only to a work mode. `work_mode=remote` did go
      // out, but no geography did, so the place itself is ours to apply.
      reason = "freehire has no place parameter for that text";
    } else if (ignored.length > 0) {
      reason = `freehire ignored ${ignored.join(", ")}`;
    } else if (mapped.length === 0) {
      // Re-ask unfiltered so the keyword search still produces rows to filter,
      // rather than reporting a silent zero as "no such job".
      reason = `freehire returned no rows for ${sent.join("&")}`;
      payload = await request(false);
      mapped = mapJobs(payload, input.limit);
    } else {
      notes?.push(`location "${wanted}" applied upstream as ${sent.join("&")}`);
      return mapped;
    }

    const before = mapped.length;
    mapped = mapped.filter((job) => matchesLocation(job.location, wanted));
    notes?.push(
      `${reason}; filtered ${before} rows locally to ${mapped.length} for "${wanted}"`,
    );
    return mapped;
  },
};
