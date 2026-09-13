import type { JobSearchQuery } from "@domain";
import { parseSearchQuery, searchQueryToParams } from "@web/lib/jobSearch";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Binds the whole filter set to the query string. The URL is the state — not a
 * mirror of it — so a refresh, a back button and a link pasted into another
 * tab all land on the same result set, and there is no second copy to keep in
 * sync.
 *
 * The free-text box is the one exception: it needs a character-by-character
 * value to stay a usable input, so its text lives in component state and is
 * committed to the URL once it settles.
 */

const DEBOUNCE_MS = 250;

export type UrlSearchState = {
  /** Parsed straight from the address bar; this is what gets fetched. */
  query: JobSearchQuery;
  /** Live value of the text box, which runs ahead of `query.q`. */
  text: string;
  /** Types a character. Commits to the URL once typing settles. */
  setText: (value: string) => void;
  /**
   * Commits a value immediately, skipping the debounce: Enter, blur and the
   * clear button. The value is explicit because the caller knows it before
   * `text` has re-rendered.
   */
  commitNow: (value: string) => void;
  /** Merges filter changes and sends the user back to page one. */
  patch: (next: Partial<JobSearchQuery>) => void;
  /** Drops every filter, the sort and the page in one history entry. */
  clearAll: () => void;
};

export function useUrlState(): UrlSearchState {
  const [params, setParams] = useSearchParams();
  const search = params.toString();

  const query = useMemo(
    () => parseSearchQuery(new URLSearchParams(search)),
    [search],
  );
  const [text, setTextValue] = useState(() => query.q ?? "");

  /*
   * Reading `query` inside the debounce callback would capture whatever it was
   * when the keystroke happened, so a filter changed mid-typing would be
   * clobbered by the settling text. A ref always answers with the current URL.
   */
  const latest = useRef(query);
  latest.current = query;

  /** Query strings this hook wrote itself, so external changes stand out. */
  const written = useRef(search);
  /**
   * Whether the current history entry was created by the text box. The first
   * settled query of a typing session pushes an entry and every keystroke
   * after that replaces it, which is what keeps the back button from having to
   * walk one character at a time.
   */
  const textOwnsEntry = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (search === written.current) return;
    // Arrived from outside: back/forward, a pasted link, or a fresh mount.
    // Re-seed the box and let the next typing session own its own entry.
    written.current = search;
    textOwnsEntry.current = false;
    setTextValue(new URLSearchParams(search).get("q") ?? "");
  }, [search]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const commit = useCallback(
    (next: JobSearchQuery, mode: "push" | "replace") => {
      const nextParams = searchQueryToParams(next);
      written.current = nextParams.toString();
      setParams(nextParams, { replace: mode === "replace" });
    },
    [setParams],
  );

  const commitText = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      const next = trimmed.length > 0 ? trimmed : undefined;
      if ((latest.current.q ?? undefined) === next) return;

      const replace = textOwnsEntry.current;
      textOwnsEntry.current = true;
      commit(
        { ...latest.current, q: next, offset: 0 },
        replace ? "replace" : "push",
      );
    },
    [commit],
  );

  const setText = useCallback(
    (value: string) => {
      setTextValue(value);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        commitText(value);
      }, DEBOUNCE_MS);
    },
    [commitText],
  );

  const commitNow = useCallback(
    (value: string) => {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      setTextValue(value);
      // Safe with nothing pending: an unchanged value commits nothing.
      commitText(value);
    },
    [commitText],
  );

  const patch = useCallback(
    (next: Partial<JobSearchQuery>) => {
      const merged: JobSearchQuery = { ...latest.current, ...next };
      // Page 4 of the previous result set says nothing about the new one, so
      // any change other than paging itself returns to the first page.
      if (next.offset === undefined) merged.offset = 0;
      textOwnsEntry.current = false;
      commit(merged, "push");
    },
    [commit],
  );

  const clearAll = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setTextValue("");
    textOwnsEntry.current = false;
    commit({}, "push");
  }, [commit]);

  return { query, text, setText, commitNow, patch, clearAll };
}
