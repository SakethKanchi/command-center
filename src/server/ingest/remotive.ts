import type { NewJob } from "@domain";
import { matchesLocation } from "@server/search/location";
import {
  cleanText,
  type FetchJobsInput,
  fetchSourceJson,
  type HostAllowlist,
  htmlToText,
  matchesKeyword,
  type SourceAdapter,
  toIsoOrNull,
} from "./types";

/**
 * Remotive — a curated remote-only board with a keyless public feed.
 *
 * One request returns the whole result set with each description inlined, so
 * like freehire it needs no board token and no per-posting fetch. The catch is
 * that its parameters are advisory rather than binding: measured live, a
 * `search=backend engineer` returns a marketing office assistant, and `limit`
 * came back with sixteen rows whatever value it was given. Everything the
 * caller asked for is therefore sent upstream AND enforced again locally, and
 * the notes say which of the two actually did the work.
 */
const REMOTIVE_HOSTS: HostAllowlist = {
  "remotive.com": true,
};

const LABEL = "remotive";
const MAX_UPSTREAM_LIMIT = 100;

/**
 * The fields this adapter reads. The wire shape also carries `category`,
 * `tags`, `job_type`, `company_logo` and a duplicate `company_logo_url`, none
 * of which survive into a `NewJob`, plus the top-level `0-legal-notice`,
 * `00-warning` and `job-count` keys that are commentary rather than data.
 */
type RemotiveJob = {
  id?: number | string;
  url?: string;
  title?: string;
  company_name?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
};

type RemotivePayload = { jobs?: RemotiveJob[] };

export function remotiveSearchUrl(input: {
  query?: string;
  limit: number;
}): string {
  const params = new URLSearchParams({
    // Clamped because the caller's limit is a UI page size, not a promise
    // about what a public feed should be asked to assemble in one response.
    limit: String(Math.max(1, Math.min(input.limit, MAX_UPSTREAM_LIMIT))),
  });
  const query = input.query?.trim();
  if (query) params.set("search", query);
  return `https://remotive.com/api/remote-jobs?${params.toString()}`;
}

/** Map one feed payload to rows, stopping at the caller's limit. */
function mapJobs(payload: RemotivePayload | null, limit: number): NewJob[] {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const mapped: NewJob[] = [];

  for (const job of jobs) {
    const jobUrl = cleanText(job.url);
    const title = cleanText(job.title);
    // No link or no title and the row can only ever fail downstream: nothing
    // to open, nothing to apply to, nothing worth a scoring pass.
    if (!jobUrl || !title) continue;

    mapped.push({
      source: "remotive",
      sourceJobId:
        job.id === undefined || job.id === null ? null : String(job.id),
      title,
      // Their company names frequently carry a trailing space
      // ("Coalition Technologies "), which would otherwise split one employer
      // into two on every dedupe and grouping pass.
      company: cleanText(job.company_name) ?? "Unknown",
      // Not where the work happens — every posting here is remote. This is the
      // residence RESTRICTION the employer will hire against, so it reads
      // "Worldwide" or "USA, Canada" rather than a city.
      location: cleanText(job.candidate_required_location),
      isRemote: true,
      url: jobUrl,
      applyUrl: null,
      descriptionText: htmlToText(job.description),
      // Free text as typed by the employer — "$31,2k- $52k", "$14/hour" — so it
      // is passed through verbatim rather than parsed into a range that would
      // be wrong about the period as often as it was right.
      salaryText: cleanText(job.salary),
      // `publication_date` carries no zone ("2026-09-11T20:16:48"), which
      // `Date.parse` would read as host-local time. `toIsoOrNull` pins a
      // zoneless date-time to UTC instead, so the same feed does not produce
      // two different dates on two machines.
      postedAt: toIsoOrNull(job.publication_date),
    });
    if (mapped.length >= limit) break;
  }

  return mapped;
}

export const remotiveAdapter: SourceAdapter = {
  id: "remotive",
  label: "Remotive",
  needsBoardToken: false,

  async fetchJobs(input: FetchJobsInput): Promise<NewJob[]> {
    const notes = input.notes;

    // A remote-only board cannot answer "on-site work only". Returning its
    // remote rows anyway would be answering a different question, and
    // returning them silently would look like the filter had been honoured.
    if (input.remote === false) {
      notes?.push("remotive lists only remote work, so it was not queried");
      return [];
    }

    const query = input.query?.trim();
    const wanted = input.location?.trim();
    // A local filter has to see the whole window, not the caller's first
    // `limit` rows: with their search inert, capping at five and then matching
    // the keyword answers a query from five arbitrary postings. So the request
    // widens to the board's ceiling whenever a filter of ours will run, and
    // the caller's limit is applied last.
    const filtering = Boolean(query) || Boolean(wanted);
    const window = filtering ? MAX_UPSTREAM_LIMIT : input.limit;

    const payload = (await fetchSourceJson({
      url: remotiveSearchUrl({ query: input.query, limit: window }),
      label: LABEL,
      allowedHosts: REMOTIVE_HOSTS,
      fetchImpl: input.fetchImpl,
    })) as RemotivePayload | null;

    let mapped = mapJobs(payload, window);

    // `search` went upstream, but their full-text match is loose enough to
    // return a marketing role for "backend engineer", so the query is applied
    // again here. Only a drop is worth a note: when nothing was dropped the
    // upstream search was good enough and the user needs no explanation.
    if (query) {
      const before = mapped.length;
      mapped = mapped.filter((job) => matchesKeyword(job, query));
      if (mapped.length < before) {
        notes?.push(
          `remotive's search is loose; filtered ${before} rows locally to ${mapped.length} for "${query}"`,
        );
      }
    }

    if (wanted) {
      const before = mapped.length;
      mapped = mapped.filter((job) => matchesLocation(job.location, wanted));
      notes?.push(
        `remotive has no place parameter; filtered ${before} rows locally to ${mapped.length} against the candidate residence restriction for "${wanted}"`,
      );
    }

    return filtering ? mapped.slice(0, input.limit) : mapped;
  },
};
