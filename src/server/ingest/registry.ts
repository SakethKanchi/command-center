import type { NewJob } from "@domain";
import { toAppError } from "@server/infra/errors";
import { logger } from "@server/infra/logger";
import type { RepoBundle } from "@server/repos";
import { arbeitnowAdapter } from "./arbeitnow";
import { ashbyAdapter } from "./ashby";
import { freehireAdapter } from "./freehire";
import { greenhouseAdapter } from "./greenhouse";
import { himalayasAdapter } from "./himalayas";
import { jobicyAdapter } from "./jobicy";
import { leverAdapter } from "./lever";
import { remotiveAdapter } from "./remotive";
import { themuseAdapter } from "./themuse";
import { type SourceAdapter, stripCompanyFromTitle } from "./types";

/**
 * Insertion order is the precedence order: two boards can carry the same
 * posting, and `ingestJobs` keeps the first version of a duplicate url. The
 * keyless aggregators come first because they are the ones a keyword-first
 * discovery can actually reach, and an ATS board is only ever consulted for
 * the one company whose token the user supplied.
 *
 * The six keyless sources are not interchangeable, which is why there are six:
 * freehire and Jobicy take a keyword upstream, Remotive is remote-only and
 * curated, Himalayas is the largest remote index, Arbeitnow is the only
 * continental-Europe feed here, and The Muse is the only one that publishes
 * office and hybrid roles at all.
 */
export const SOURCE_ADAPTERS: Record<string, SourceAdapter> = {
  [freehireAdapter.id]: freehireAdapter,
  [remotiveAdapter.id]: remotiveAdapter,
  [jobicyAdapter.id]: jobicyAdapter,
  [himalayasAdapter.id]: himalayasAdapter,
  [themuseAdapter.id]: themuseAdapter,
  [arbeitnowAdapter.id]: arbeitnowAdapter,
  [greenhouseAdapter.id]: greenhouseAdapter,
  [ashbyAdapter.id]: ashbyAdapter,
  [leverAdapter.id]: leverAdapter,
};

export function listSourceAdapters(): SourceAdapter[] {
  return Object.values(SOURCE_ADAPTERS);
}

export type IngestSource = {
  id: string;
  board?: string;
  query?: string;
  /** Free-text place, translated per source into what that board accepts. */
  location?: string;
  remote?: boolean;
};

export type IngestSourceReport = {
  id: string;
  fetched: number;
  /** Why this source contributed nothing. Set for a skip as well as a failure. */
  error?: string;
  /** True when no request went out, so the reason is not a fault. */
  skipped?: boolean;
  /** What the adapter did with the filters — see `FetchJobsInput.notes`. */
  notes?: string[];
};

export type IngestResult = {
  bySource: IngestSourceReport[];
  /** Distinct postings across every source, after collapsing shared urls. */
  fetched: number;
  inserted: number;
  updated: number;
};

const DEFAULT_LIMIT = 25;

/**
 * Five at a time.
 *
 * Sequential ingest makes the agent's first step feel broken — nine boards at
 * a couple of seconds each, and two of them paginating, is most of the run's
 * latency. Unbounded fan-out trades that for a different failure: every one of
 * these is an unauthenticated public endpoint that throttles by client, and
 * the retry storm that follows is slower than having waited.
 *
 * Five rather than the three this started at because the registry grew from
 * four sources to nine. The bound is on our own egress, not on any one host:
 * no two adapters share a hostname, so concurrent sources do not stack
 * requests against the same service.
 */
const MAX_CONCURRENT_SOURCES = 5;

/**
 * Run the requested sources, persist what they found, report what they did.
 *
 * One board being down, renamed or rate-limited is the normal case, not the
 * exception, so a failing source is recorded and the others still land. An
 * ingest that returns eight sources' jobs plus one error is useful; one that
 * throws away all nine because Lever 404'd is not.
 *
 * A source that needs a company board token and was not given one is skipped
 * outright. The request would be built from an empty token and rejected before
 * it left the process, and reporting that as a failure tells the candidate a
 * board is broken when the truth is that nobody named a company.
 */
export async function ingestJobs(input: {
  sources: IngestSource[];
  limit?: number;
  repos: RepoBundle;
  fetchImpl?: typeof fetch;
}): Promise<IngestResult> {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const fetchImpl = input.fetchImpl ?? fetch;
  const sources = input.sources;

  // Indexed rather than pushed: the report has to stay in the caller's order
  // however the workers interleave.
  const reports: IngestSourceReport[] = new Array(sources.length);
  const harvested: NewJob[][] = new Array(sources.length);

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < sources.length) {
      const index = cursor;
      cursor += 1;
      const source = sources[index];
      if (!source) continue;

      const adapter = SOURCE_ADAPTERS[source.id];
      if (!adapter) {
        reports[index] = {
          id: source.id,
          fetched: 0,
          error: `unknown source "${source.id}"`,
        };
        harvested[index] = [];
        continue;
      }

      if (adapter.needsBoardToken && !source.board?.trim()) {
        reports[index] = {
          id: source.id,
          fetched: 0,
          skipped: true,
          error: `${adapter.label} publishes one company's board, so it needs a board token; none was given`,
        };
        harvested[index] = [];
        continue;
      }

      const notes: string[] = [];
      try {
        const jobs = await adapter.fetchJobs({
          board: source.board,
          query: source.query,
          location: source.location,
          remote: source.remote,
          limit,
          fetchImpl,
          notes,
        });
        harvested[index] = jobs;
        reports[index] = { id: source.id, fetched: jobs.length };
      } catch (error) {
        const appError = toAppError(error);
        logger.warn("Ingest source failed", {
          source: source.id,
          board: source.board,
          code: appError.code,
          message: appError.message,
        });
        harvested[index] = [];
        reports[index] = { id: source.id, fetched: 0, error: appError.message };
      }
      // Notes survive a failure: an adapter that filtered locally and then
      // tripped on a second request still explains what it did.
      const report = reports[index];
      if (report && notes.length > 0) report.notes = notes;
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_SOURCES, sources.length) },
      worker,
    ),
  );

  // Two boards can carry the same posting — an aggregator and the ATS it
  // scraped it from. Collapsing here rather than in SQL keeps the upsert a
  // single statement per row and makes the first source in the caller's list
  // the one whose version wins.
  const seen = new Set<string>();
  const rows: NewJob[] = [];
  for (const jobs of harvested) {
    for (const job of jobs ?? []) {
      if (seen.has(job.url)) continue;
      seen.add(job.url);
      rows.push({
        ...job,
        title: stripCompanyFromTitle(job.title, job.company),
      });
    }
  }

  const persisted =
    rows.length > 0
      ? input.repos.jobs.upsertMany(rows)
      : { inserted: 0, updated: 0 };

  logger.info("Ingest complete", {
    sources: reports.length,
    fetched: seen.size,
    inserted: persisted.inserted,
    updated: persisted.updated,
  });

  return {
    bySource: reports,
    fetched: seen.size,
    inserted: persisted.inserted,
    updated: persisted.updated,
  };
}
