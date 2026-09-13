import type { JobCard, JobSearchQuery, JobSearchResult } from "@domain";
import type { FilterChip } from "@web/components/search/filters";
import { ResultRow } from "@web/components/search/ResultRow";
import { ErrorBanner } from "@web/components/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The four honest answers to "what happened to my search": still loading,
 * nothing matched, nothing has been ingested at all, or the request failed.
 * Collapsing any two of them into one message is how a working app comes to
 * look broken.
 */

/** Rows fade out down the list, so the fade value is also a unique key. */
const SKELETON_FADES = [1, 0.86, 0.72, 0.58, 0.44, 0.3];

/** Mirrors the real row's geometry so the list does not jump when data lands. */
function Skeleton() {
  return (
    <ul aria-hidden data-testid="result-skeleton">
      {SKELETON_FADES.map((opacity) => (
        <li
          key={opacity}
          className="lane-row flex items-center gap-4 px-4 py-3"
          style={{ opacity }}
        >
          <div className="min-w-0 flex-1">
            <div className="h-[15px] w-[46%] rounded-xs bg-ridge-hi" />
            <div className="mt-1.5 h-[12px] w-[28%] rounded-xs bg-ridge" />
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <div className="h-[20px] w-[150px] rounded-xs bg-ridge" />
            <div className="h-[10px] w-[90px] rounded-xs bg-ridge" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * An empty database is not an empty search result, and the fix is not a
 * filter change: it is fetching postings. The board search is therefore the
 * primary action here, with the seed script kept as the second path for anyone
 * who would rather run it from a terminal.
 */
function NothingIngested({ onDiscover }: { onDiscover?: () => void }) {
  return (
    <div className="px-4 py-12 text-center">
      <p className="text-ink-dim">
        No postings in the database yet. Search the boards and they land here.
      </p>
      {onDiscover ? (
        <p className="mt-4">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onDiscover}
          >
            Search the boards
          </button>
        </p>
      ) : null}
      <p className="u-mono mt-3 text-ink-faint">
        or pull a starter set from a terminal:{" "}
        <span className="text-ink-dim">npm run seed</span>
      </p>
    </div>
  );
}

function NoMatches({
  narrowest,
  onRemove,
  onClearAll,
}: {
  narrowest: FilterChip | null;
  onRemove: (clear: Partial<JobSearchQuery>) => void;
  onClearAll: () => void;
}) {
  return (
    <div className="px-4 py-12 text-center">
      <p className="text-ink-dim">Nothing matches all of those filters.</p>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        {narrowest ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onRemove(narrowest.clear)}
          >
            Drop {narrowest.label}
          </button>
        ) : null}
        <button type="button" className="btn" onClick={onClearAll}>
          Clear all filters
        </button>
      </div>
    </div>
  );
}

function Pager({
  total,
  limit,
  offset,
  onOffset,
}: {
  total: number;
  limit: number;
  offset: number;
  onOffset: (next: number) => void;
}) {
  const first = offset + 1;
  const last = Math.min(offset + limit, total);
  const hasPrev = offset > 0;
  const hasNext = last < total;

  return (
    <div className="flex items-center justify-between gap-3 border-t border-ridge px-4 py-2.5">
      <span className="u-mono text-[11.5px] text-ink-faint">
        {first}–{last} of {total}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn"
          disabled={!hasPrev}
          onClick={() => onOffset(Math.max(0, offset - limit))}
        >
          <ChevronLeft className="size-3.5" aria-hidden />
          Prev
        </button>
        <button
          type="button"
          className="btn"
          disabled={!hasNext}
          onClick={() => onOffset(offset + limit)}
        >
          Next
          <ChevronRight className="size-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}

export function ResultList({
  result,
  loading,
  error,
  corpusTotal,
  narrowest,
  applyingJobId,
  applyInFlight,
  onRetry,
  onRemoveFilter,
  onClearAll,
  onOffset,
  onOpen,
  onApply,
  onDiscover,
}: {
  result: JobSearchResult | null;
  loading: boolean;
  error: string | null;
  /** Postings in the database regardless of filters; null until known. */
  corpusTotal: number | null;
  narrowest: FilterChip | null;
  applyingJobId: string | null;
  applyInFlight: boolean;
  onRetry: () => void;
  onRemoveFilter: (clear: Partial<JobSearchQuery>) => void;
  onClearAll: () => void;
  onOffset: (next: number) => void;
  onOpen: (job: JobCard, trigger: HTMLElement) => void;
  onApply: (job: JobCard) => void;
  /** Sends the user to the board search; only offered when nothing is here. */
  onDiscover?: () => void;
}) {
  if (error !== null) {
    return (
      <div className="panel p-4">
        <ErrorBanner message={error} onRetry={onRetry} />
      </div>
    );
  }

  // Keep the previous page visible under a spinner while a refined query is in
  // flight; blanking the list on every keystroke is what makes a fast search
  // feel unstable.
  if (result === null) {
    return (
      <div className="panel overflow-hidden">
        {loading ? <Skeleton /> : null}
      </div>
    );
  }

  const { jobs, total, limit, offset } = result;

  let body: ReactNode;
  if (jobs.length > 0) {
    body = (
      <ul>
        {jobs.map((job) => (
          <ResultRow
            key={job.id}
            job={job}
            applying={applyingJobId === job.id}
            applyDisabled={applyInFlight}
            onOpen={onOpen}
            onApply={onApply}
          />
        ))}
      </ul>
    );
  } else if (corpusTotal === 0) {
    body = <NothingIngested onDiscover={onDiscover} />;
  } else {
    body = (
      <NoMatches
        narrowest={narrowest}
        onRemove={onRemoveFilter}
        onClearAll={onClearAll}
      />
    );
  }

  return (
    <div className="panel overflow-hidden" aria-busy={loading}>
      {body}
      {total > limit ? (
        <Pager
          total={total}
          limit={limit}
          offset={offset}
          onOffset={onOffset}
        />
      ) : null}
    </div>
  );
}
