import type { NewJob } from "@domain";
import {
  boardToken,
  cleanText,
  detectRemote,
  type FetchJobsInput,
  fetchSourceJson,
  type HostAllowlist,
  htmlToText,
  humanizeBoardToken,
  type SourceAdapter,
  toIsoOrNull,
} from "./types";

/**
 * Greenhouse job boards via the public `boards-api` endpoint.
 *
 * `content=true` is not optional for us: without it the list response carries
 * titles and nothing else, and every posting would reach the scoring pass with
 * an empty body — a score with no evidence behind it. With it, one request
 * returns the whole board including each full description.
 */
const GREENHOUSE_HOSTS: HostAllowlist = {
  "boards-api.greenhouse.io": true,
  "boards.greenhouse.io": true,
  "job-boards.greenhouse.io": true,
  "job-boards.eu.greenhouse.io": true,
};

const LABEL = "greenhouse";

type GreenhouseJob = {
  id?: number | string;
  title?: string;
  absolute_url?: string;
  company_name?: string;
  location?: { name?: string };
  content?: string;
  first_published?: string;
  updated_at?: string;
};

export function greenhouseJobsUrl(board: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${boardToken(board, LABEL)}/jobs?content=true`;
}

export const greenhouseAdapter: SourceAdapter = {
  id: "greenhouse",
  label: "Greenhouse",
  needsBoardToken: true,

  async fetchJobs(input: FetchJobsInput): Promise<NewJob[]> {
    const url = greenhouseJobsUrl(input.board ?? "");
    const payload = (await fetchSourceJson({
      url,
      label: LABEL,
      allowedHosts: GREENHOUSE_HOSTS,
      fetchImpl: input.fetchImpl,
    })) as { jobs?: GreenhouseJob[] } | null;

    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    const fallbackCompany = humanizeBoardToken(input.board ?? "");
    const mapped: NewJob[] = [];

    for (const job of jobs) {
      const jobUrl = cleanText(job.absolute_url);
      const title = cleanText(job.title);
      // A posting with no link is unusable downstream — the agent cannot apply
      // to it and the UI cannot open it — so it is dropped rather than stored
      // as a row that can only ever fail.
      if (!jobUrl || !title) continue;

      const location = cleanText(job.location?.name);
      mapped.push({
        source: "greenhouse",
        sourceJobId:
          job.id === undefined || job.id === null ? null : String(job.id),
        title,
        company: cleanText(job.company_name) ?? fallbackCompany,
        location,
        isRemote: detectRemote({ location }),
        url: jobUrl,
        applyUrl: null,
        descriptionText: htmlToText(job.content),
        salaryText: null,
        postedAt: toIsoOrNull(job.first_published ?? job.updated_at),
      });
      if (mapped.length >= input.limit) break;
    }

    return mapped;
  },
};
