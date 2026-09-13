import type { JobSort } from "@domain";
import { SORT_OPTIONS } from "@web/lib/jobSearch";
import { Loader2, Search, X } from "lucide-react";

/**
 * The one control the screen is built around. It is deliberately the widest
 * thing on the page: the complaint this page answers is "I cannot search", so
 * the search box is not tucked into a toolbar.
 */
export function SearchBar({
  text,
  onText,
  onCommit,
  sort,
  onSort,
  busy,
}: {
  text: string;
  onText: (value: string) => void;
  /** Skips the debounce: Enter, blur and the clear button. */
  onCommit: (value: string) => void;
  sort: JobSort;
  onSort: (value: JobSort) => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="relative min-w-0 flex-1">
        <label className="sr-only" htmlFor="job-search-input">
          Search job postings
        </label>
        {busy ? (
          <Loader2
            className="spin pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-signal"
            aria-hidden
          />
        ) : (
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint"
            aria-hidden
          />
        )}
        <input
          id="job-search-input"
          type="search"
          value={text}
          placeholder="Title, company, location, anything in the posting…"
          autoComplete="off"
          className="h-11 w-full rounded-sm border border-ridge-hi bg-panel pr-10 pl-10 text-[15px] text-ink placeholder:text-ink-faint focus:border-signal focus:outline-none"
          onChange={(event) => onText(event.target.value)}
          onBlur={(event) => onCommit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onCommit(event.currentTarget.value);
            }
          }}
        />
        {text ? (
          <button
            type="button"
            aria-label="Clear search text"
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-xs p-1.5 text-ink-faint hover:text-ink focus:text-ink focus:outline-1 focus:outline-signal"
            onClick={() => onCommit("")}
          >
            <X className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <label className="u-meta text-ink-faint" htmlFor="job-search-sort">
          Sort
        </label>
        <select
          id="job-search-sort"
          value={sort}
          className="u-mono h-11 rounded-sm border border-ridge-hi bg-panel px-2 text-ink focus:border-signal focus:outline-none"
          onChange={(event) => onSort(event.target.value as JobSort)}
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
