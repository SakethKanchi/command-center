import type {
  FacetCount,
  JobCard,
  JobSearchQuery,
  JobSearchResult,
  JobSort,
} from "@domain";
import { ActiveChips } from "@web/components/search/ActiveChips";
import { DiscoverPanel } from "@web/components/search/DiscoverPanel";
import { FilterRail } from "@web/components/search/FilterRail";
import { activeChips, narrowestFilter } from "@web/components/search/filters";
import { JobDrawer } from "@web/components/search/JobDrawer";
import { ResultList } from "@web/components/search/ResultList";
import { SearchBar } from "@web/components/search/SearchBar";
import { ApiError, api } from "@web/lib/api";
import { fetchLocations } from "@web/lib/discover";
import { pluralize } from "@web/lib/format";
import { DEFAULT_SORT, SearchAborted, searchJobs } from "@web/lib/jobSearch";
import { useUrlState } from "@web/lib/useUrlState";
import { Radar, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Job search: one text box, a filter rail, a dense result list and a drawer.
 *
 * The whole filter set lives in the URL rather than in component state, so the
 * screen has exactly one source of truth and a result set is a thing you can
 * link to. Everything here is a consequence of that: the fetch effect keys off
 * the parsed URL, and back/forward is just another URL change.
 */

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong talking to the Command Center server.";
}

export function SearchPage() {
  const { query, text, setText, commitNow, patch, clearAll } = useUrlState();

  const [result, setResult] = useState<JobSearchResult | null>(null);
  const [corpusTotal, setCorpusTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<JobCard | null>(null);
  const [applyingJobId, setApplyingJobId] = useState<string | null>(null);
  const [contactSaving, setContactSaving] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  /** Bumped to hand the caret to the discover panel; see its `focusKey`. */
  const [discoverFocus, setDiscoverFocus] = useState(0);
  const [places, setPlaces] = useState<FacetCount[] | null>(null);
  const [placesLoading, setPlacesLoading] = useState(true);
  const [placesError, setPlacesError] = useState<string | null>(null);

  /** The row that opened the drawer, so Escape can hand focus straight back. */
  const opener = useRef<HTMLElement | null>(null);
  const applyLock = useRef(false);
  const searchRun = useRef<AbortController | null>(null);
  const placesRun = useRef<AbortController | null>(null);
  const corpusRun = useRef<AbortController | null>(null);

  const runSearch = useCallback((next: JobSearchQuery) => {
    searchRun.current?.abort();
    const controller = new AbortController();
    searchRun.current = controller;
    setLoading(true);

    void (async () => {
      try {
        const value = await searchJobs(next, controller.signal);
        setResult(value);
        setError(null);
      } catch (cause) {
        // A superseded query is not a failure: the newer one owns the screen.
        if (cause instanceof SearchAborted) return;
        setError(describe(cause));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
  }, []);

  /*
   * The corpus size is what makes "12 match" mean anything, and it is the only
   * way to tell an over-narrowed search from a database nobody has ingested
   * into yet. It changes only on ingest, so one unfiltered probe is enough.
   */
  const runCorpusCount = useCallback(() => {
    corpusRun.current?.abort();
    const controller = new AbortController();
    corpusRun.current = controller;

    void (async () => {
      try {
        const probe = await searchJobs({ limit: 1 }, controller.signal);
        setCorpusTotal(probe.total);
      } catch {
        // Purely a count line; the search itself already reports failures.
      }
    })();
  }, []);

  /*
   * Known places for the location typeahead. Loaded once here rather than by
   * each control, because both the filter rail and the discover panel offer
   * them and two components owning the same lookup means two requests and two
   * chances to disagree. A discovery run can introduce new places, so this
   * reloads alongside the corpus count.
   */
  const runPlaces = useCallback(() => {
    placesRun.current?.abort();
    const controller = new AbortController();
    placesRun.current = controller;
    setPlacesLoading(true);

    void (async () => {
      try {
        const answer = await fetchLocations(200, controller.signal);
        setPlaces(answer.locations);
        setPlacesError(null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setPlacesError(describe(cause));
      } finally {
        if (!controller.signal.aborted) setPlacesLoading(false);
      }
    })();
  }, []);

  // `query` is memoised against the URL's query string, so this re-runs when
  // the search actually changes rather than on every render.
  useEffect(() => {
    runSearch(query);
    return () => searchRun.current?.abort();
  }, [query, runSearch]);

  useEffect(() => {
    runCorpusCount();
    return () => corpusRun.current?.abort();
  }, [runCorpusCount]);

  useEffect(() => {
    runPlaces();
    return () => placesRun.current?.abort();
  }, [runPlaces]);

  const reload = useCallback(() => {
    setError(null);
    runSearch(query);
    runCorpusCount();
    runPlaces();
  }, [query, runSearch, runCorpusCount, runPlaces]);

  /*
   * A discovery run wrote new rows, so everything derived from the corpus is
   * stale at once: the result list, the total that distinguishes an empty
   * database from an over-filtered search, and the set of known places.
   */
  const handleDiscovered = useCallback(() => {
    runSearch(query);
    runCorpusCount();
    runPlaces();
  }, [query, runSearch, runCorpusCount, runPlaces]);

  const revealDiscover = useCallback(() => {
    setDiscoverOpen(true);
    setDiscoverFocus((was) => was + 1);
  }, []);

  const chips = activeChips(query);
  const matched = result?.total ?? 0;

  const closeDrawer = useCallback(() => {
    setOpen(null);
    opener.current?.focus();
    opener.current = null;
  }, []);

  const handleOpen = useCallback((job: JobCard, trigger: HTMLElement) => {
    opener.current = trigger;
    setOpen(job);
  }, []);

  const handleApply = useCallback(
    async (job: JobCard) => {
      if (applyLock.current) return;
      applyLock.current = true;
      setApplyingJobId(job.id);
      setError(null);
      setNotice(null);
      try {
        await api.apply({ jobId: job.id, mode: "dry_run" });
        setNotice(
          `Application run started for ${job.title} at ${job.company}.`,
        );
        // The run moves the posting's status, so the list and the count line
        // are now stale.
        runSearch(query);
        runCorpusCount();
      } catch (cause) {
        setError(describe(cause));
      } finally {
        applyLock.current = false;
        setApplyingJobId(null);
      }
    },
    [query, runSearch, runCorpusCount],
  );

  /*
   * Saving a recipient changes what the row can claim, so the drawer and the
   * list both re-read it: the badge in the list is the same fact the drawer's
   * field just wrote.
   */
  const handleSaveContact = useCallback(
    async (job: JobCard, email: string | null) => {
      setContactSaving(true);
      setError(null);
      setNotice(null);
      try {
        const { job: saved } = await api.setJobContact(job.id, email);
        setOpen((was) => (was?.id === saved.id ? saved : was));
        setNotice(
          saved.contactEmail
            ? `Outreach for ${saved.company} will go to ${saved.contactEmail}.`
            : `No recipient for ${saved.company}; runs will skip outreach.`,
        );
        runSearch(query);
      } catch (cause) {
        setError(describe(cause));
      } finally {
        setContactSaving(false);
      }
    },
    [query, runSearch],
  );

  return (
    <div className="flex flex-col gap-4">
      {/*
       * Every other page titles itself with a visible h1. This one's title is
       * the search box, so the heading is visually redundant but structurally
       * required: without it the first page a visitor lands on has no h1 and
       * the document outline starts at the filter groups.
       */}
      <h1 className="sr-only">Search job postings</h1>
      <SearchBar
        text={text}
        onText={setText}
        onCommit={commitNow}
        sort={query.sort ?? DEFAULT_SORT}
        onSort={(sort: JobSort) => patch({ sort })}
        busy={loading}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="u-mono text-[12.5px] text-ink-dim" aria-live="polite">
          {corpusTotal === null ? (
            "counting…"
          ) : (
            <>
              <span className="text-ink">{corpusTotal}</span>{" "}
              {pluralize(corpusTotal, "role")}
              {chips.length > 0 ? (
                <>
                  {" · "}
                  <span className="text-signal">{matched}</span> match
                </>
              ) : null}
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
          {/*
           * An empty corpus turns this from a secondary action into the only
           * one that helps, so it is open and emphasised rather than hidden
           * behind a disclosure the user has to guess at.
           */}
          <button
            type="button"
            className={`btn ${corpusTotal === 0 ? "btn-primary" : ""}`}
            aria-expanded={discoverOpen || corpusTotal === 0}
            aria-controls="discover-panel"
            onClick={() => setDiscoverOpen((was) => !was)}
          >
            <Radar className="size-3.5" aria-hidden />
            Board search
          </button>
          <button
            type="button"
            className="btn lg:hidden"
            aria-expanded={railOpen}
            aria-controls="filter-rail"
            onClick={() => setRailOpen((was) => !was)}
          >
            <SlidersHorizontal className="size-3.5" aria-hidden />
            Filters
            {chips.length > 0 ? ` (${chips.length})` : ""}
          </button>
        </div>
      </div>

      <div id="discover-panel">
        {discoverOpen || corpusTotal === 0 ? (
          <DiscoverPanel
            places={places}
            primary={corpusTotal === 0}
            focusKey={discoverFocus}
            onDiscovered={handleDiscovered}
          />
        ) : null}
      </div>

      <ActiveChips chips={chips} onRemove={patch} onClearAll={clearAll} />

      {notice ? (
        <output className="block rounded-md border border-signal/40 bg-signal/10 px-4 py-2.5 text-[13px] text-ink">
          {notice}
        </output>
      ) : null}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <aside
          id="filter-rail"
          className={`${railOpen ? "block" : "hidden"} shrink-0 lg:block lg:w-[260px]`}
        >
          <FilterRail
            query={query}
            facets={result?.facets ?? null}
            places={places}
            placesLoading={placesLoading}
            placesError={placesError}
            onReloadPlaces={runPlaces}
            onPatch={patch}
          />
        </aside>

        <div className="min-w-0 flex-1">
          <ResultList
            result={result}
            loading={loading}
            error={error}
            corpusTotal={corpusTotal}
            narrowest={narrowestFilter(query, result?.facets ?? null)}
            applyingJobId={applyingJobId}
            applyInFlight={applyingJobId !== null}
            onRetry={reload}
            onRemoveFilter={patch}
            onClearAll={clearAll}
            onOffset={(offset) => patch({ offset })}
            onOpen={handleOpen}
            onApply={handleApply}
            onDiscover={revealDiscover}
          />
        </div>
      </div>

      {open ? (
        <JobDrawer
          job={open}
          applying={applyingJobId === open.id}
          applyDisabled={applyingJobId !== null}
          contactSaving={contactSaving}
          onClose={closeDrawer}
          onApply={handleApply}
          onSaveContact={handleSaveContact}
        />
      ) : null}
    </div>
  );
}

export default SearchPage;
