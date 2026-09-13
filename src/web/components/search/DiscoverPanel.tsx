import type { DiscoverResult, DiscoverSourceReport, FacetCount } from "@domain";
import {
  describeError,
  ErrorBanner,
  formatCount,
  Skeleton,
} from "@web/components/ui";
import type { DiscoverSource } from "@web/lib/discover";
import { discover, fetchDiscoverSources } from "@web/lib/discover";
import { pluralize } from "@web/lib/format";
import {
  AlertTriangle,
  Check,
  Loader2,
  Radar,
  SkipForward,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

/**
 * Ask the boards for a role, rather than re-filtering the rows already here.
 *
 * This is the difference between a search box and a job search, so it is a
 * first-class action with its own result readout instead of a refresh icon.
 * Discovery fans out over several sources and any of them can fail on its own,
 * which is why the readout is per source: "3 of 4 boards answered" is the
 * truth, and collapsing it into one success or one failure is a lie in both
 * directions.
 */

type Phase = "idle" | "running" | "done" | "failed";

function SourceRow({ report }: { report: DiscoverSourceReport }) {
  const skipped = report.skipped === true;
  const failed = !skipped && typeof report.error === "string";

  return (
    <li className="lane-row flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
      <span className="u-mono flex min-w-0 shrink-0 items-center gap-1.5 text-ink">
        {failed ? (
          <AlertTriangle className="size-3.5 shrink-0 text-alarm" aria-hidden />
        ) : skipped ? (
          <SkipForward
            className="size-3.5 shrink-0 text-ink-faint"
            aria-hidden
          />
        ) : (
          <Check className="size-3.5 shrink-0 text-pass" aria-hidden />
        )}
        {report.source}
      </span>

      {/* A skipped source fetched nothing and saying "0" would read as a
          board that answered empty, which is a different fact. */}
      {skipped ? (
        <span className="u-mono text-[11.5px] text-ink-faint">skipped</span>
      ) : failed ? (
        <span className="u-mono text-[11.5px] text-alarm">failed</span>
      ) : (
        <span className="u-mono text-ink-dim tabular-nums">
          {formatCount(report.fetched)}{" "}
          <span className="text-ink-faint">
            {pluralize(report.fetched, "posting")}
          </span>
        </span>
      )}

      {report.error ? (
        <span
          className={`w-full text-[12px] leading-snug ${
            failed ? "text-alarm" : "text-ink-faint"
          }`}
        >
          {report.error}
        </span>
      ) : null}

      {(report.notes ?? []).map((note) => (
        <span
          key={note}
          className="w-full text-[12px] leading-snug text-ink-faint"
        >
          {note}
        </span>
      ))}
    </li>
  );
}

/** Mirrors the report list's geometry, so nothing jumps when it lands. */
function ReportSkeleton({ rows }: { rows: number }) {
  return (
    <ul aria-hidden>
      {Array.from({ length: rows }, (_, index) => index).map((index) => (
        <li
          key={index}
          className="lane-row flex items-center gap-3 px-3 py-2.5"
        >
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-24" />
        </li>
      ))}
    </ul>
  );
}

export function DiscoverPanel({
  places,
  /** Emphasised and self-explaining when there is nothing to filter. */
  primary,
  focusKey,
  onDiscovered,
}: {
  places: FacetCount[] | null;
  primary: boolean;
  /**
   * Bumped when something elsewhere on the page sent the user here — the
   * empty-list call to action. A counter rather than a boolean because the
   * same request can be made twice and still has to move focus twice.
   */
  focusKey: number;
  /** A run that changed the corpus; the caller re-runs its search. */
  onDiscovered: () => void;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState("");
  const [remote, setRemote] = useState<"any" | "yes" | "no">("any");
  const [sources, setSources] = useState<DiscoverSource[] | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<DiscoverResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** One run at a time: a second fan-out would race the first into the table. */
  const running = useRef(false);
  const queryInput = useRef<HTMLInputElement | null>(null);

  const loadSources = useCallback(async () => {
    try {
      const answer = await fetchDiscoverSources();
      setSources(answer.sources);
      setSourcesError(null);
    } catch (cause) {
      setSourcesError(describeError(cause));
    }
  }, []);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  // Focus is only ever taken on request. An empty corpus makes this panel the
  // primary action, but a page that grabs the caret on load is a page that
  // fights anyone who arrived to read it.
  useEffect(() => {
    if (focusKey > 0) queryInput.current?.focus();
  }, [focusKey]);

  const run = async () => {
    if (running.current) return;
    running.current = true;
    setPhase("running");
    setError(null);
    try {
      const answer = await discover({
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(location.trim() ? { location: location.trim() } : {}),
        ...(remote === "any" ? {} : { remote: remote === "yes" }),
        ...(chosen.length > 0 ? { sources: chosen } : {}),
      });
      setResult(answer);
      setPhase("done");
      onDiscovered();
    } catch (cause) {
      setError(describeError(cause));
      setPhase("failed");
    } finally {
      running.current = false;
    }
  };

  const busy = phase === "running";
  const rows = result?.bySource ?? [];
  const failures = rows.filter(
    (row) => row.skipped !== true && typeof row.error === "string",
  ).length;
  const answered = rows.length - failures;

  return (
    <section
      aria-labelledby="discover-heading"
      className={`panel overflow-hidden ${primary ? "border-signal/50" : ""}`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-ridge px-4 py-2.5">
        <h2
          id="discover-heading"
          className="u-meta flex items-center gap-1.5 text-ink-dim"
        >
          <Radar className="size-3.5 text-signal" aria-hidden />
          Search the boards
        </h2>
        <p className="text-[12.5px] text-ink-faint">
          {primary
            ? "Nothing is in the database yet — this is where postings come from."
            : "Fetches new postings from the sources, then reloads the list."}
        </p>
      </header>

      <form
        className="grid gap-3 px-4 py-3.5 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <div className="flex flex-col gap-1">
          <label
            className="u-mono text-[11px] text-ink-faint"
            htmlFor="discover-query"
          >
            Role or keywords
          </label>
          <input
            id="discover-query"
            ref={queryInput}
            type="search"
            value={query}
            placeholder="staff backend engineer"
            autoComplete="off"
            className="h-9 rounded-sm border border-ridge-hi bg-panel px-2.5 text-[14px] text-ink placeholder:text-ink-faint focus:border-signal focus:outline-none"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label
            className="u-mono text-[11px] text-ink-faint"
            htmlFor="discover-location"
          >
            Place
          </label>
          {/*
           * A datalist, not the rail's combobox: this is one value, and the
           * suggestions are a convenience over free text the aggregator
           * accepts as a city name or a country code. Typing something it
           * cannot map is not an error — the server says so in `notes`.
           */}
          <input
            id="discover-location"
            type="text"
            value={location}
            list={listId}
            placeholder="Toronto, Canada"
            autoComplete="address-level2"
            className="h-9 rounded-sm border border-ridge-hi bg-panel px-2.5 text-[14px] text-ink placeholder:text-ink-faint focus:border-signal focus:outline-none"
            onChange={(event) => setLocation(event.target.value)}
          />
          <datalist id={listId}>
            {(places ?? []).slice(0, 40).map((place) => (
              <option key={place.value} value={place.value} />
            ))}
          </datalist>
        </div>

        <button
          type="submit"
          // Stays enabled with every field empty: a keyword-less discovery is
          // a legitimate "show me anything new".
          className="btn btn-primary h-9"
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="spin size-3.5" aria-hidden />
          ) : (
            <Radar className="size-3.5" aria-hidden />
          )}
          {busy ? "Searching…" : "Search boards"}
        </button>

        <fieldset className="sm:col-span-3">
          <legend className="u-mono text-[11px] text-ink-faint">
            Work arrangement
          </legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {(
              [
                { value: "any", label: "Any" },
                { value: "yes", label: "Remote" },
                { value: "no", label: "On-site" },
              ] as const
            ).map((option) => (
              <div key={option.value} className="flex items-center gap-1.5">
                <input
                  id={`discover-remote-${option.value}`}
                  name="discover-remote"
                  type="radio"
                  checked={remote === option.value}
                  className="size-3.5 accent-signal"
                  onChange={() => setRemote(option.value)}
                />
                <label
                  htmlFor={`discover-remote-${option.value}`}
                  className="cursor-pointer text-[13px] text-ink-dim"
                >
                  {option.label}
                </label>
              </div>
            ))}
          </div>
        </fieldset>

        <fieldset className="sm:col-span-3">
          <legend className="u-mono text-[11px] text-ink-faint">Sources</legend>
          {sourcesError ? (
            <p className="mt-1 text-[12.5px] text-ink-faint">
              Source list unavailable — every source will be tried.{" "}
              <button
                type="button"
                className="u-mono text-signal underline decoration-ridge-hi underline-offset-2"
                onClick={() => void loadSources()}
              >
                Retry
              </button>
            </p>
          ) : sources === null ? (
            <p className="mt-1 flex items-center gap-2 text-[12.5px] text-ink-faint">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-20" />
              <span className="sr-only">Loading sources…</span>
            </p>
          ) : (
            <>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1.5">
                {sources.map((source) => (
                  <div
                    key={source.id}
                    className="flex min-h-[24px] items-center gap-1.5"
                  >
                    <input
                      id={`discover-source-${source.id}`}
                      type="checkbox"
                      checked={chosen.includes(source.id)}
                      className="size-3.5 accent-signal"
                      onChange={() =>
                        setChosen((was) =>
                          was.includes(source.id)
                            ? was.filter((entry) => entry !== source.id)
                            : [...was, source.id],
                        )
                      }
                    />
                    <label
                      htmlFor={`discover-source-${source.id}`}
                      className="cursor-pointer text-[13px] text-ink-dim"
                    >
                      {source.label}
                      {source.needsBoardToken ? (
                        <span className="u-mono ml-1.5 text-[11px] text-ink-faint">
                          needs board token
                        </span>
                      ) : null}
                    </label>
                  </div>
                ))}
              </div>
              <p className="mt-1.5 text-[11.5px] text-ink-faint">
                {chosen.length === 0
                  ? "None picked — every source is tried."
                  : `${chosen.length} of ${sources.length} picked.`}{" "}
                Sources marked “needs board token” are skipped by a keyword
                search.
              </p>
            </>
          )}
        </fieldset>
      </form>

      {busy ? (
        <div className="border-t border-ridge" aria-busy="true">
          <p className="u-meta px-3 pt-2.5 pb-1 text-ink-faint">
            Asking the boards…
          </p>
          <ReportSkeleton rows={sources?.length ?? 3} />
        </div>
      ) : null}

      {phase === "failed" && error ? (
        <div className="border-t border-ridge p-3">
          <ErrorBanner message={error} onRetry={() => void run()} />
        </div>
      ) : null}

      {phase === "done" && result ? (
        <div className="border-t border-ridge">
          {/*
           * `aria-live` on the summary only. Announcing every source row would
           * read four lines of counts at a screen-reader user; the summary
           * carries whether it worked and the rows are there to be read.
           */}
          <p
            className="u-mono px-3 pt-2.5 pb-1 text-[12.5px] text-ink-dim"
            aria-live="polite"
          >
            <span className="text-ink tabular-nums">
              {formatCount(result.inserted)}
            </span>{" "}
            new ·{" "}
            <span className="text-ink tabular-nums">
              {formatCount(result.updated)}
            </span>{" "}
            updated · {formatCount(result.fetched)} fetched
            {failures > 0 ? (
              <>
                {" · "}
                <span className="text-alarm">
                  {answered} of {rows.length} {pluralize(rows.length, "source")}{" "}
                  answered
                </span>
              </>
            ) : null}
          </p>
          {rows.length === 0 ? (
            <p className="px-3 pb-3 text-[13px] text-ink-dim">
              No source reported back.
            </p>
          ) : (
            <ul aria-label="Result by source">
              {rows.map((report) => (
                <SourceRow key={report.source} report={report} />
              ))}
            </ul>
          )}
          {result.inserted === 0 && failures === 0 ? (
            <p className="px-3 pt-1 pb-3 text-[12.5px] text-ink-faint">
              Nothing new — every posting the boards returned was already here.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
