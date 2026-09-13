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

/** Lever boards via the public v0 postings endpoint. */
const LEVER_HOSTS: HostAllowlist = {
  "api.lever.co": true,
  "api.eu.lever.co": true,
};

const LABEL = "lever";

type LeverJob = {
  id?: string;
  text?: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  workplaceType?: string;
  descriptionPlain?: string;
  description?: string;
  additionalPlain?: string;
  additional?: string;
  lists?: Array<{ text?: string; content?: string }>;
  categories?: {
    location?: string;
    allLocations?: string[];
    commitment?: string;
  };
  salaryRange?: {
    min?: number;
    max?: number;
    currency?: string;
    interval?: string;
  };
};

/**
 * Lever splits a posting across three places: `description` (the intro),
 * `lists[]` (the requirement bullets, each with its own heading) and
 * `additional` (the closing boilerplate). Reading only the first leaves the
 * must-haves on the floor, which is precisely the text the scoring pass needs.
 *
 * Each fragment falls back on *emptiness*, not just absence: live postings
 * carry `descriptionPlain: ""` next to a populated HTML `description`, and a
 * `??` chain would hand back the empty string.
 */
function fullDescription(job: LeverJob): string {
  const fragments = [
    cleanText(job.descriptionPlain) ?? cleanText(job.description),
    ...(job.lists ?? []).flatMap((list) => [
      cleanText(list.text),
      cleanText(list.content),
    ]),
    cleanText(job.additionalPlain) ?? cleanText(job.additional),
  ];
  return htmlToText(
    fragments.filter((fragment) => fragment !== null).join("\n\n"),
  );
}

/** `eu` routes to Lever's EU data residency host, which is a different API origin. */
export function leverPostingsUrl(board: string, region?: "us" | "eu"): string {
  const host = region === "eu" ? "api.eu.lever.co" : "api.lever.co";
  return `https://${host}/v0/postings/${boardToken(board, LABEL)}?mode=json`;
}

const INTERVAL_LABELS: Readonly<Record<string, string>> = {
  "per-year-salary": "/yr",
  "per-month-salary": "/mo",
  "per-week-salary": "/wk",
  "per-day-salary": "/day",
  "per-hour-wage": "/hr",
};

function formatSalary(range: LeverJob["salaryRange"]): string | null {
  if (!range) return null;
  const min = typeof range.min === "number" && range.min > 0 ? range.min : null;
  const max = typeof range.max === "number" && range.max > 0 ? range.max : null;
  if (min === null && max === null) return null;
  const currency = range.currency ? `${range.currency} ` : "";
  const suffix = range.interval ? (INTERVAL_LABELS[range.interval] ?? "") : "";
  const amount =
    min !== null && max !== null
      ? `${min.toLocaleString("en-US")}–${max.toLocaleString("en-US")}`
      : `${(min ?? max)?.toLocaleString("en-US")}`;
  return `${currency}${amount}${suffix}`;
}

export const leverAdapter: SourceAdapter = {
  id: "lever",
  label: "Lever",
  needsBoardToken: true,

  async fetchJobs(input: FetchJobsInput): Promise<NewJob[]> {
    const payload = await fetchSourceJson({
      url: leverPostingsUrl(input.board ?? ""),
      label: LABEL,
      allowedHosts: LEVER_HOSTS,
      fetchImpl: input.fetchImpl,
    });

    // Lever returns a bare array, not an envelope.
    const jobs: LeverJob[] = Array.isArray(payload) ? payload : [];
    const company = humanizeBoardToken(input.board ?? "");
    const mapped: NewJob[] = [];

    for (const job of jobs) {
      const jobUrl = cleanText(job.hostedUrl);
      const title = cleanText(job.text);
      if (!jobUrl || !title) continue;

      // A multi-location req exposes the full set in `allLocations`; reading
      // only `categories.location` hides every city but the first.
      const location = joinLocations([
        job.categories?.location,
        ...(job.categories?.allLocations ?? []),
      ]);
      mapped.push({
        source: "lever",
        sourceJobId: cleanText(job.id),
        title,
        company,
        location,
        isRemote: detectRemote({ workplaceType: job.workplaceType, location }),
        url: jobUrl,
        applyUrl: cleanText(job.applyUrl),
        descriptionText: fullDescription(job),
        salaryText: formatSalary(job.salaryRange),
        postedAt: toIsoOrNull(job.createdAt),
      });
      if (mapped.length >= input.limit) break;
    }

    return mapped;
  },
};
