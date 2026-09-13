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
  joinLocations,
  type SourceAdapter,
  toIsoOrNull,
} from "./types";

/**
 * Ashby boards via the public posting-api.
 *
 * The list response already carries `descriptionPlain` and, with
 * `includeCompensation=true`, the pay range — so a whole board costs one
 * request and no per-posting follow-up.
 */
const ASHBY_HOSTS: HostAllowlist = { "api.ashbyhq.com": true };

const LABEL = "ashby";

type AshbySecondaryLocation = {
  location?: string;
  address?: {
    postalAddress?: { addressLocality?: string; addressCountry?: string };
  };
};

type AshbyJob = {
  id?: string;
  title?: string;
  location?: string;
  secondaryLocations?: AshbySecondaryLocation[];
  workplaceType?: string;
  isRemote?: boolean;
  isListed?: boolean;
  publishedAt?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  compensation?: { compensationTierSummary?: string };
};

export function ashbyBoardUrl(board: string): string {
  const token = boardToken(board, LABEL);
  return `https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`;
}

/**
 * Ashby keeps extra hiring regions in `secondaryLocations[]` and the office
 * city in `location`, even for a fully remote role. Folding them into one
 * string is what stops an EU-eligible posting whose primary label reads
 * "Canada" from looking Canada-only to every location filter downstream.
 */
function formatLocation(job: AshbyJob): string | null {
  const parts: Array<string | null | undefined> = [job.location];
  for (const secondary of job.secondaryLocations ?? []) {
    parts.push(secondary.location);
    parts.push(secondary.address?.postalAddress?.addressLocality);
    parts.push(secondary.address?.postalAddress?.addressCountry);
  }
  return joinLocations(parts);
}

export const ashbyAdapter: SourceAdapter = {
  id: "ashby",
  label: "Ashby",
  needsBoardToken: true,

  async fetchJobs(input: FetchJobsInput): Promise<NewJob[]> {
    const payload = (await fetchSourceJson({
      url: ashbyBoardUrl(input.board ?? ""),
      label: LABEL,
      allowedHosts: ASHBY_HOSTS,
      fetchImpl: input.fetchImpl,
    })) as { jobs?: AshbyJob[] } | null;

    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    const company = humanizeBoardToken(input.board ?? "");
    const mapped: NewJob[] = [];

    for (const job of jobs) {
      // The posting-api returns unlisted drafts alongside live roles; applying
      // to one is a guaranteed dead end.
      if (job.isListed === false) continue;
      const jobUrl = cleanText(job.jobUrl);
      const title = cleanText(job.title);
      if (!jobUrl || !title) continue;

      const location = formatLocation(job);
      mapped.push({
        source: "ashby",
        sourceJobId: cleanText(job.id),
        title,
        company,
        location,
        isRemote: detectRemote({
          workplaceType: job.workplaceType,
          isRemote: job.isRemote,
          location,
        }),
        url: jobUrl,
        applyUrl: cleanText(job.applyUrl),
        // An empty `descriptionPlain` next to populated HTML is common enough
        // that `??` is the wrong operator here.
        descriptionText: htmlToText(
          cleanText(job.descriptionPlain) ?? job.descriptionHtml,
        ),
        salaryText: cleanText(job.compensation?.compensationTierSummary),
        postedAt: toIsoOrNull(job.publishedAt),
      });
      if (mapped.length >= input.limit) break;
    }

    return mapped;
  },
};
