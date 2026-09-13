import type { DiscoverRequest, DiscoverResult, FacetCount } from "@domain";
import { request } from "@web/lib/api";

/**
 * The client half of "go ask the boards", plus the two lookups the controls
 * around it need: which sources exist, and which places the corpus already
 * knows about.
 *
 * Discovery is the only call in the app that changes the corpus, so it is
 * deliberately a separate verb from search. Filtering rows you already have
 * and fetching rows you do not are different actions with different failure
 * modes, and collapsing them would make a partial board failure look like an
 * empty result set.
 */

/**
 * One entry of the server's own adapter registry, so the source picker cannot
 * drift from what `/api/discover` will actually run. `needsBoardToken` is the
 * set a keyword-first discovery has to skip — it is shown before the request
 * goes out rather than explained afterwards.
 */
export type DiscoverSource = {
  id: string;
  label: string;
  needsBoardToken: boolean;
};

export function fetchDiscoverSources(
  signal?: AbortSignal,
): Promise<{ sources: DiscoverSource[] }> {
  return request<{ sources: DiscoverSource[] }>(
    "/api/sources",
    signal ? { signal } : undefined,
  );
}

/**
 * Places already in the corpus, most common first, for the location
 * typeahead. Free text stays valid — the search filter is a substring match
 * and discovery forwards whatever is typed — so these are suggestions with
 * evidence attached, never an allowed-values list.
 */
export function fetchLocations(
  limit = 200,
  signal?: AbortSignal,
): Promise<{ locations: FacetCount[] }> {
  return request<{ locations: FacetCount[] }>(
    `/api/locations?limit=${limit}`,
    signal ? { signal } : undefined,
  );
}

export function discover(
  input: DiscoverRequest,
  signal?: AbortSignal,
): Promise<DiscoverResult> {
  return request<DiscoverResult>("/api/discover", {
    method: "POST",
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
}

/**
 * Ranks suggestions for what has been typed so far: prefix matches first,
 * then anywhere in the string, each group keeping the server's count order.
 * A prefix match is what the user is reaching for — typing "van" should offer
 * Vancouver before "Vanier, Ottawa".
 */
export function suggestLocations(
  known: readonly FacetCount[],
  text: string,
  exclude: readonly string[],
  limit = 8,
): FacetCount[] {
  const needle = text.trim().toLowerCase();
  const taken = new Set(exclude.map((value) => value.toLowerCase()));
  const prefix: FacetCount[] = [];
  const anywhere: FacetCount[] = [];

  for (const candidate of known) {
    const value = candidate.value.toLowerCase();
    if (taken.has(value)) continue;
    if (needle === "") {
      prefix.push(candidate);
    } else if (value.startsWith(needle)) {
      prefix.push(candidate);
    } else if (value.includes(needle)) {
      anywhere.push(candidate);
    }
    if (prefix.length >= limit) break;
  }

  return [...prefix, ...anywhere].slice(0, limit);
}
