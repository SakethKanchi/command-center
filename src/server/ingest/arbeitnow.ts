import type { NewJob } from "@domain";
import { matchesLocation } from "@server/search/location";
import {
  cleanText,
  detectRemote,
  type FetchJobsInput,
  fetchSourceJson,
  type HostAllowlist,
  htmlToText,
  matchesKeyword,
  type SourceAdapter,
  toIsoOrNull,
} from "./types";

/**
 * Arbeitnow — a keyless German-language aggregator, and the only source here
 * with real continental-Europe coverage. Every other keyless board in this
 * registry is US- or remote-first, so a search for work in Berlin or Munich
 * returns nothing at all without this one.
 *
 * The endpoint is a firehose and nothing else: no query parameter, no place
 * parameter, no page size. `?page=` is the entire API surface, which is why
 * this adapter carries a local filter and a bounded page walk that the
 * parameterised boards do not need.
 */
const ARBEITNOW_HOSTS: HostAllowlist = {
  "www.arbeitnow.com": true,
};

const LABEL = "arbeitnow";
const BASE_URL = "https://www.arbeitnow.com/api/job-board-api";

/**
 * How far the walk may go when a local filter has not yet produced enough
 * rows. One page is 250 postings and roughly 2 MB of raw HTML on the wire, so
 * the ceiling is a cost bound rather than a politeness one: three pages is
 * already ~6 MB of transfer and 750 bodies through the tag stripper, and the
 * feed is ordered newest-first, so a query the first 750 postings cannot
 * answer is not going to be answered by page four either.
 */
const MAX_PAGES = 3;

/**
 * The fields this adapter reads. The wire shape carries `tags` and
 * `job_types` as well, both free-text vocabularies the board does not
 * normalise — they are deliberately unmapped rather than folded into the
 * description, where they would dilute the keyword haystack with agency
 * marketing words.
 */
type ArbeitnowJob = {
  slug?: string;
  company_name?: string;
  title?: string;
  description?: string;
  remote?: boolean;
  url?: string;
  location?: string;
  /** UNIX seconds, around 1.78e9 at time of writing. */
  created_at?: number;
};

type ArbeitnowPayload = { data?: ArbeitnowJob[] };

/**
 * The only request this board accepts.
 *
 * The page number is clamped to the walk's own ceiling: nothing in this
 * adapter has a reason to ask beyond it, and an unclamped number reaching the
 * query string is a way to pull arbitrary megabytes on someone else's behalf.
 * There is no count parameter to clamp — `meta.per_page` is fixed at 250
 * upstream — so `input.limit` is honoured while mapping instead.
 */
export function arbeitnowSearchUrl(input: { page?: number }): string {
  const requested = input.page;
  const page =
    typeof requested === "number" && Number.isFinite(requested)
      ? Math.trunc(requested)
      : 1;
  return `${BASE_URL}?page=${Math.max(1, Math.min(page, MAX_PAGES))}`;
}

/**
 * Map one page, keeping only the rows the caller's filters admit, and stop
 * the moment the accumulator reaches the limit.
 *
 * Returns how many raw postings the page carried, which is how the walk tells
 * "this page had nothing I wanted" apart from "the feed has run out" — the
 * second is a reason to stop, the first is not.
 */
function mapPage(
  payload: ArbeitnowPayload | null,
  keep: (job: NewJob) => boolean,
  limit: number,
  into: NewJob[],
): number {
  const jobs = Array.isArray(payload?.data) ? payload.data : [];

  for (const job of jobs) {
    if (into.length >= limit) break;
    const jobUrl = cleanText(job.url);
    const title = cleanText(job.title);
    // Same rule as every other adapter here: a posting with no link or no
    // title cannot be opened, applied to or scored, so it is dropped rather
    // than stored as a row that can only ever fail.
    if (!jobUrl || !title) continue;

    const location = cleanText(job.location);
    const mapped: NewJob = {
      source: "arbeitnow",
      sourceJobId: cleanText(job.slug),
      title,
      company: cleanText(job.company_name) ?? "Unknown",
      location,
      // The board states the work mode itself, and `detectRemote` gives that
      // boolean precedence over the location text. That ordering matters here:
      // this feed writes places like "Homeoffice" and "Karlsruhe" for remote
      // roles, neither of which the English remote-hint pattern recognises.
      isRemote: detectRemote({ isRemote: job.remote, location }),
      url: jobUrl,
      applyUrl: null,
      // Bodies are raw HTML straight out of the employer's editor and run past
      // 60k characters on the worst offenders. No truncation happens here:
      // `htmlToText` already applies `DESCRIPTION_MAX_CHARS` as its last step,
      // exactly as it does for Greenhouse and freehire.
      descriptionText: htmlToText(job.description),
      // The feed has no pay field at all — not empty, absent — so there is
      // nothing to format and nothing to guess from.
      salaryText: null,
      // Epoch seconds; `toIsoOrNull` splits seconds from milliseconds at 1e11
      // and multiplies up, so a raw 1789330195 lands in 2026 rather than 1970.
      postedAt: toIsoOrNull(job.created_at),
    };

    if (keep(mapped)) into.push(mapped);
  }

  return jobs.length;
}

export const arbeitnowAdapter: SourceAdapter = {
  id: "arbeitnow",
  label: "Arbeitnow",
  needsBoardToken: false,

  async fetchJobs(input: FetchJobsInput): Promise<NewJob[]> {
    const notes = input.notes;
    const query = input.query?.trim();
    const wanted = input.location?.trim();
    const wantsRemote = typeof input.remote === "boolean";

    const keep = (job: NewJob): boolean => {
      if (query && !matchesKeyword(job, query)) return false;
      if (wanted && !matchesLocation(job.location, wanted)) return false;
      // The board's own flag, as carried through to `isRemote`. A posting that
      // never stated a mode is null, and null is not an answer to either
      // request, so it is excluded from both.
      if (wantsRemote && job.isRemote !== input.remote) return false;
      return true;
    };

    const filtered = query !== undefined || wanted !== undefined || wantsRemote;
    const mapped: NewJob[] = [];
    let scanned = 0;
    let pages = 0;

    // Page one is unconditional; the walk past it only earns its megabytes
    // when a filter is thinning the results below what the caller asked for.
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const payload = (await fetchSourceJson({
        url: arbeitnowSearchUrl({ page }),
        label: LABEL,
        allowedHosts: ARBEITNOW_HOSTS,
        fetchImpl: input.fetchImpl,
      })) as ArbeitnowPayload | null;

      const seen = mapPage(payload, keep, input.limit, mapped);
      scanned += seen;
      pages += 1;
      // An empty page is the end of the feed, not a thin one: paginating past
      // it burns a request per page to be told the same thing again.
      if (seen === 0) break;
      if (!filtered || mapped.length >= input.limit) break;
    }

    if (!filtered) return mapped;

    // One note, naming every filter this adapter had to carry itself and what
    // survived, because "three rows" means something different when the board
    // searched and when we did.
    const applied: string[] = [];
    if (query) applied.push(`keyword "${query}"`);
    if (wanted) applied.push(`location "${wanted}"`);
    if (wantsRemote)
      applied.push(input.remote ? "remote only" : "on-site only");
    notes?.push(
      `arbeitnow has no keyword, place or work-mode parameter; ${applied.join(
        ", ",
      )} filtered locally over ${pages} page${pages === 1 ? "" : "s"}, ` +
        `${scanned} rows to ${mapped.length}`,
    );
    return mapped;
  },
};
