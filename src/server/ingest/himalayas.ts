import type { NewJob } from "@domain";
import { matchesLocation } from "@server/search/location";
import {
  cleanText,
  type FetchJobsInput,
  fetchSourceJson,
  type HostAllowlist,
  htmlToText,
  joinLocations,
  matchesKeyword,
  type SourceAdapter,
  toIsoOrNull,
} from "./types";

/**
 * Himalayas — a keyless remote-only aggregator, reachable without a board
 * token or an account, which is what makes it usable for keyword-first
 * discovery where the ATS adapters cannot help.
 *
 * The feed is a firehose in reverse-chronological order: the whole index is
 * ~104k postings, and there is no query parameter of any kind. What it does
 * give us is the full description inline, so a matched posting needs no second
 * request before scoring.
 */
const HIMALAYAS_HOSTS: HostAllowlist = {
  "himalayas.app": true,
};

const LABEL = "himalayas";
const SEARCH_URL = "https://himalayas.app/jobs/api";

/**
 * Measured, not assumed: `limit=21`, `limit=100` and `limit=250` all come back
 * with `limit: 20` and twenty rows, so twenty is the hard page ceiling. Asking
 * for more is not an error, it is silently truncated — which means a caller
 * wanting fifty rows needs pages even with no filter applied.
 */
const PAGE_MAX = 20;

/**
 * A firehose with no server-side filter will happily let a narrow query walk
 * the entire index. Three pages is sixty postings scanned per source, which is
 * enough for a common query to land rows and cheap enough that a query
 * matching nothing still returns promptly instead of hammering their API.
 */
const MAX_PAGES = 3;

/**
 * The fields this adapter reads. The wire shape carries more — a logo CDN URL,
 * a `seniority` array, `timezoneRestrictions` as raw UTC offsets, two levels of
 * category taxonomy — none of which maps onto a `NewJob` column.
 */
type HimalayasJob = {
  title?: string;
  excerpt?: string;
  companyName?: string;
  companySlug?: string;
  minSalary?: number | null;
  maxSalary?: number | null;
  salaryPeriod?: string | null;
  currency?: string | null;
  locationRestrictions?: string[];
  description?: string;
  /** UNIX *seconds*, not milliseconds. */
  pubDate?: number | null;
  applicationLink?: string;
  guid?: string;
};

type HimalayasPayload = {
  jobs?: HimalayasJob[];
  nextCursor?: string | null;
  totalCount?: number;
};

/**
 * One page of the feed. `cursor` is the opaque `nextCursor` from the previous
 * response, echoed back verbatim.
 *
 * The response's own `comments` field states that `offset` is deprecated and
 * due for removal, and that the cursor "will never return the same job twice" —
 * an offset walk over a feed that gains postings while you read it re-serves
 * rows that slid down a page, so the cursor is both the supported and the
 * correct choice.
 */
export function himalayasSearchUrl(input: {
  limit: number;
  cursor?: string;
}): string {
  const params = new URLSearchParams({
    limit: String(Math.max(1, Math.min(input.limit, PAGE_MAX))),
  });
  if (input.cursor) params.set("cursor", input.cursor);
  return `${SEARCH_URL}?${params.toString()}`;
}

/**
 * Their vocabulary is "annual" and "hourly" where freehire says "year" and
 * "hour", so the table is theirs rather than shared. The suffix is not
 * decoration: without it a 16–16 range is ambiguous between a wage and an
 * insultingly small salary, and the scoring pass reads this string verbatim.
 */
const SALARY_PERIOD_SUFFIX: Readonly<Record<string, string>> = {
  annual: "/yr",
  yearly: "/yr",
  monthly: "/mo",
  weekly: "/wk",
  daily: "/day",
  hourly: "/hr",
};

function formatSalary(job: HimalayasJob): string | null {
  const min = typeof job.minSalary === "number" ? job.minSalary : null;
  const max = typeof job.maxSalary === "number" ? job.maxSalary : null;
  // `salaryPeriod` is populated ("annual") even on postings that state no
  // figures at all, so the numbers decide whether there is a salary to show.
  if (min === null && max === null) return null;
  const currency = job.currency ? `${job.currency} ` : "";
  const period = job.salaryPeriod?.toLowerCase();
  const suffix = period ? (SALARY_PERIOD_SUFFIX[period] ?? "") : "";
  const amount =
    min !== null && max !== null && min !== max
      ? `${min.toLocaleString("en-US")}–${max.toLocaleString("en-US")}`
      : `${(min ?? max)?.toLocaleString("en-US")}`;
  return `${currency}${amount}${suffix}`;
}

/**
 * A stable per-posting key, because the payload carries no id field at all.
 *
 * `guid` is the canonical Himalayas posting URL, and its last path segment is
 * the board's own slug — frequently with a numeric suffix the board added to
 * disambiguate. That slug is unique only within a company ("client-success-
 * manager" recurs), so it is qualified with `companySlug`. Storing the whole
 * URL instead would work but makes the id change the day they reshape a path,
 * and the point of `sourceJobId` is to survive that.
 */
function sourceJobId(job: HimalayasJob, jobUrl: string): string | null {
  let path = jobUrl;
  try {
    path = new URL(jobUrl).pathname;
  } catch {
    // A relative `guid` would have been rejected upstream as unusable; treat
    // whatever we were handed as a path rather than throwing here.
  }
  const slug = path.split("/").filter(Boolean).pop();
  if (!slug) return null;
  const company = cleanText(job.companySlug);
  return company ? `${company}/${slug}` : slug;
}

/** Map one page to rows, mapping at most `cap` of them. */
function mapJobs(payload: HimalayasPayload | null, cap: number): NewJob[] {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const mapped: NewJob[] = [];
  if (cap <= 0) return mapped;

  for (const job of jobs) {
    // `guid` and `applicationLink` are the same canonical URL on every live
    // row seen, so the fallback only matters if one of them is ever dropped.
    const jobUrl = cleanText(job.guid) ?? cleanText(job.applicationLink);
    const title = cleanText(job.title);
    // A posting with no link cannot be opened or applied to, so it is dropped
    // rather than stored as a row that can only ever fail.
    if (!jobUrl || !title) continue;

    const applyUrl = cleanText(job.applicationLink);
    mapped.push({
      source: "himalayas",
      sourceJobId: sourceJobId(job, jobUrl),
      title,
      company: cleanText(job.companyName) ?? "Unknown",
      // `locationRestrictions` is where the candidate must *reside* — the
      // countries the employer can legally hire in — not where an office is.
      // It is still the only geography the feed publishes, and it is what a
      // candidate typing a place is asking about on a remote-only board.
      location: joinLocations(job.locationRestrictions ?? []),
      // Every posting on the board is remote by definition, so this is a fact
      // about the source rather than something to sniff out of the text.
      isRemote: true,
      url: jobUrl,
      // Null when it is the same link twice, so the UI can tell "apply here"
      // from "we only know where to read it".
      applyUrl: applyUrl && applyUrl !== jobUrl ? applyUrl : null,
      // `excerpt` is the feed's own one-line summary and is the fallback for
      // the rare row whose body is empty: a scored posting with no evidence
      // behind it is worse than a scored posting with one sentence.
      descriptionText: htmlToText(job.description) || htmlToText(job.excerpt),
      salaryText: formatSalary(job),
      // UNIX seconds; `toIsoOrNull` splits seconds from milliseconds at 1e11.
      postedAt: toIsoOrNull(job.pubDate),
    });
    if (mapped.length >= cap) break;
  }

  return mapped;
}

export const himalayasAdapter: SourceAdapter = {
  id: "himalayas",
  label: "Himalayas",
  needsBoardToken: false,

  async fetchJobs(input: FetchJobsInput): Promise<NewJob[]> {
    const notes = input.notes;

    // The board publishes nothing but remote work, so a candidate who asked to
    // exclude it has no answers here. Saying so beats returning remote rows
    // under a filter that said not to.
    if (input.remote === false) {
      notes?.push("himalayas lists only remote work, so no rows can match");
      return [];
    }

    const query = input.query?.trim();
    const wanted = input.location?.trim();
    const filtering = Boolean(query) || Boolean(wanted);

    const kept: NewJob[] = [];
    // Their `comments` field promises the cursor "will never return the same
    // job twice", and the two live pages read while writing this shared no
    // postings. The promise is still theirs to break, and a duplicate posting
    // becomes a duplicate row the dedupe pass downstream has to clean up, so
    // the URL of every row already kept is remembered.
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let scanned = 0;

    while (pages < MAX_PAGES) {
      pages += 1;
      const payload = (await fetchSourceJson({
        url: himalayasSearchUrl({ limit: input.limit, cursor }),
        label: LABEL,
        allowedHosts: HIMALAYAS_HOSTS,
        fetchImpl: input.fetchImpl,
      })) as HimalayasPayload | null;

      // Unfiltered, mapping stops at exactly what the caller still wants.
      // Filtered, the whole page has to be mapped because a row's description
      // is part of the haystack the keyword match reads.
      const rows = mapJobs(
        payload,
        filtering ? PAGE_MAX : input.limit - kept.length,
      );
      scanned += rows.length;

      for (const row of rows) {
        if (query && !matchesKeyword(row, query)) continue;
        if (wanted && !matchesLocation(row.location, wanted)) continue;
        if (seen.has(row.url)) continue;
        seen.add(row.url);
        kept.push(row);
        if (kept.length >= input.limit) break;
      }

      const next = cleanText(payload?.nextCursor);
      // An absent cursor is the end of the feed and an empty page means the
      // same thing early. A cursor identical to the one just sent means the
      // feed is not advancing, which would otherwise burn the page budget
      // re-reading one page.
      if (
        kept.length >= input.limit ||
        rows.length === 0 ||
        !next ||
        next === cursor
      ) {
        break;
      }
      cursor = next;
    }

    if (filtering) {
      const applied = [
        ...(query ? [`query "${query}"`] : []),
        ...(wanted ? [`location "${wanted}"`] : []),
      ];
      notes?.push(
        `himalayas has no keyword or place parameter, so ${applied.join(" and ")} was applied locally: ${kept.length} of ${scanned} rows across ${pages} page${pages === 1 ? "" : "s"} survived`,
      );
    }

    return kept;
  },
};
