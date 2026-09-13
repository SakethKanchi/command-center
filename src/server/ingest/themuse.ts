import type { NewJob } from "@domain";
import { matchesLocation } from "@server/search/location";
import {
  cleanText,
  detectRemote,
  type FetchJobsInput,
  fetchSourceJson,
  type HostAllowlist,
  htmlToText,
  joinLocations,
  keywordTokens,
  matchesKeyword,
  type SourceAdapter,
  toIsoOrNull,
} from "./types";

/**
 * The Muse's public jobs feed — keyless, and the only aggregator here that
 * publishes office and hybrid work alongside remote. Every other source in
 * this set is a remote-only board, so without this one a discovery for
 * "New York" can only ever answer with work-from-anywhere postings.
 *
 * The price of that coverage is that the feed is a firehose with almost no
 * query surface: 400k postings, twenty to a page, no free-text parameter at
 * all. The keyword is therefore ours to apply, which is what the page walk
 * below is for.
 */
const THEMUSE_HOSTS: HostAllowlist = {
  "www.themuse.com": true,
};

const LABEL = "themuse";
const SEARCH_URL = "https://www.themuse.com/api/public/jobs";

/**
 * The exact string their taxonomy uses for remote work. It is a location
 * value rather than a work-mode flag, so it is both what we send to ask for
 * remote postings and what comes back in `locations[]` on one.
 */
const REMOTE_LOCATION = "Flexible / Remote";

/**
 * Pages are a fixed twenty rows and there is no count parameter to raise, so
 * the only lever on volume is how many pages we walk. Five is the cap: it
 * keeps a keyword pass under a hundred rows and five requests, and a candidate
 * whose query matches nothing in the first hundred postings is better served
 * by a different query than by a sixth page.
 */
const MAX_PAGES = 5;

/**
 * The fields this adapter reads. The wire shape also carries `categories`,
 * `levels`, `tags`, `short_name` and a numeric company id; none of them reach
 * a `NewJob`, and there is no pay field anywhere in the payload, which is why
 * `salaryText` is unconditionally null.
 */
type MuseJob = {
  id?: number | string;
  name?: string;
  contents?: string;
  publication_date?: string;
  locations?: Array<{ name?: string } | null>;
  refs?: { landing_page?: string };
  company?: { name?: string };
};

type MusePayload = {
  page?: number;
  page_count?: number;
  results?: MuseJob[];
};

/**
 * Place text that states a work mode rather than a geography. Matched whole,
 * because "remote" as the entire place box means remote work, while "Remote,
 * OR" is a town in Oregon's problem and stays a geography.
 */
const REMOTE_ONLY_PLACE =
  /^(?:fully[\s-]?)?remote$|^anywhere$|^work from home$|^wfh$|^distributed$/i;

/**
 * A place their `location` parameter can actually resolve: a city followed by
 * a state or country, which is the only form their taxonomy publishes
 * ("New York, NY", "London, United Kingdom"). The shape matters because an
 * unresolvable value does not error and does not widen — it silently collapses
 * to the remote-only bucket, so sending a bare "Austin" would answer a
 * candidate's city with six thousand work-from-anywhere postings.
 */
const CANONICAL_PLACE = /^[^,]{2,},\s*[^,]{2,}$/;

export type ThemuseLocationPlan = {
  /** Values for the repeatable `location` parameter, in send order. */
  locations: string[];
  /** The caller's place text, when it was the thing we sent. */
  sentPlace: string | null;
};

/**
 * Decide what of the caller's geography this board can be asked for.
 *
 * An explicit remote flag outranks the place box: their remote postings state
 * `Flexible / Remote` and nothing else, so asking for remote work in a named
 * city upstream would be asking for two things the data never says at once.
 */
export function planThemuseLocation(input: {
  location?: string;
  remote?: boolean;
}): ThemuseLocationPlan {
  const wanted = input.location?.trim() ?? "";

  if (input.remote === true || REMOTE_ONLY_PLACE.test(wanted)) {
    return { locations: [REMOTE_LOCATION], sentPlace: null };
  }
  if (CANONICAL_PLACE.test(wanted)) {
    return { locations: [wanted], sentPlace: wanted };
  }
  return { locations: [], sentPlace: null };
}

/**
 * Their category vocabulary, measured rather than taken from the docs: an
 * unknown category is not an error, it returns zero rows, so every value here
 * was checked against the live endpoint. `Engineering`, `IT`, `DevOps`,
 * `Security`, `Finance`, `Operations` and `Legal` all read like categories and
 * all answer with nothing, which is why they are absent.
 *
 * This is the only way to narrow a keyword on this board. Without it the
 * keyword pass reads a hundred rows of a four-hundred-thousand-posting
 * firehose and matches nothing, which is exactly what it did: a live
 * "backend engineer" discovery returned zero from the Muse and five from
 * everywhere else.
 */
const CATEGORY_BY_KEYWORD: Readonly<Record<string, string>> = {
  engineer: "Software Engineering",
  engineering: "Software Engineering",
  developer: "Software Engineering",
  software: "Software Engineering",
  backend: "Software Engineering",
  frontend: "Software Engineering",
  fullstack: "Software Engineering",
  platform: "Software Engineering",
  devops: "Software Engineering",
  sre: "Software Engineering",
  infrastructure: "Software Engineering",
  kubernetes: "Software Engineering",
  python: "Software Engineering",
  typescript: "Software Engineering",
  golang: "Software Engineering",
  rust: "Software Engineering",
  java: "Software Engineering",
  data: "Data and Analytics",
  analytics: "Data and Analytics",
  analyst: "Data and Analytics",
  scientist: "Data and Analytics",
  ml: "Data and Analytics",
  product: "Product Management",
  design: "Design and UX",
  designer: "Design and UX",
  ux: "Design and UX",
  ui: "Design and UX",
  sales: "Sales",
  recruiter: "Human Resources and Recruitment",
  recruiting: "Human Resources and Recruitment",
  support: "Customer Service",
  writer: "Writing and Editing",
  teacher: "Education",
};

/**
 * The category a keyword belongs to, or null when none of its words name one.
 *
 * First match wins and only one category travels: two OR-ed categories widen
 * the set the local keyword pass then has to narrow again, which spends the
 * page budget to end up where it started.
 */
export function planThemuseCategory(query: string): string | null {
  for (const token of keywordTokens(query)) {
    const category = CATEGORY_BY_KEYWORD[token];
    if (category) return category;
  }
  return null;
}

/**
 * `page` is required and zero-based: omitting it is a 400, `page=-1` is
 * "too low", and `page=page_count` is "too high", so the last valid page is
 * `page_count - 1`.
 */
export function themuseSearchUrl(input: {
  page: number;
  locations?: readonly string[];
  category?: string | null;
}): string {
  const params = new URLSearchParams({
    page: String(Math.max(0, Math.trunc(input.page))),
  });
  // Repeated keys rather than one comma-joined value: the parameter is OR-ed
  // per occurrence, and a comma is already the separator inside a single
  // place name.
  for (const location of input.locations ?? []) {
    params.append("location", location);
  }
  if (input.category) params.set("category", input.category);
  return `${SEARCH_URL}?${params.toString()}`;
}

/** One wire row to a posting, or null when it is unusable. */
function mapJob(job: MuseJob): NewJob | null {
  // `refs.landing_page` is the only absolute URL in the payload — everything
  // else is a slug — so a row without it cannot be opened or applied to, and
  // is dropped rather than stored as a link that can only ever fail.
  const jobUrl = cleanText(job.refs?.landing_page);
  const title = cleanText(job.name);
  if (!jobUrl || !title) return null;

  const location = joinLocations(
    (job.locations ?? []).map((entry) => entry?.name),
  );
  return {
    source: "themuse",
    sourceJobId:
      job.id === undefined || job.id === null ? null : String(job.id),
    title,
    company: cleanText(job.company?.name) ?? "Unknown",
    location,
    // There is no work-mode field; the joined location carries the answer,
    // since a remote posting names `Flexible / Remote` as a place.
    isRemote: detectRemote({ location }),
    url: jobUrl,
    applyUrl: null,
    descriptionText: htmlToText(job.contents),
    salaryText: null,
    postedAt: toIsoOrNull(job.publication_date),
  };
}

export const themuseAdapter: SourceAdapter = {
  id: "themuse",
  label: "The Muse",
  needsBoardToken: false,

  async fetchJobs(input: FetchJobsInput): Promise<NewJob[]> {
    const notes = input.notes;
    const query = input.query?.trim() ?? "";
    const wanted = input.location?.trim() ?? "";
    const plan = planThemuseLocation({
      location: wanted,
      remote: input.remote,
    });
    // A place is ours to check whenever one was asked for: upstream is
    // inclusive rather than strict — a `location=New York, NY` page comes back
    // with its remote postings mixed in — and an unresolvable value is
    // answered with the remote bucket instead of an error.
    const filterPlace = wanted !== "" && !REMOTE_ONLY_PLACE.test(wanted);
    // The keyword cannot travel, but the category it belongs to can, which is
    // the difference between matching a hundred rows of the whole board and a
    // hundred rows of the right discipline.
    const category = query === "" ? null : planThemuseCategory(query);

    const kept: NewJob[] = [];
    let scanned = 0;
    let droppedPlace = 0;
    let droppedOnsite = 0;
    let droppedKeyword = 0;
    // Until the first response says otherwise, assume the page walk is
    // allowed to run to its own cap.
    let pageCount = MAX_PAGES;

    for (let page = 0; page < MAX_PAGES && page < pageCount; page += 1) {
      const payload = (await fetchSourceJson({
        url: themuseSearchUrl({ page, locations: plan.locations, category }),
        label: LABEL,
        allowedHosts: THEMUSE_HOSTS,
        fetchImpl: input.fetchImpl,
      })) as MusePayload | null;

      if (typeof payload?.page_count === "number" && payload.page_count > 0) {
        pageCount = payload.page_count;
      }
      const results = Array.isArray(payload?.results) ? payload.results : [];
      // An empty page means the board has nothing further to hand over, and
      // the next request would only be another twenty rows of nothing.
      if (results.length === 0) break;

      for (const row of results) {
        const job = mapJob(row);
        if (!job) continue;
        scanned += 1;

        // A remote posting is a fair answer to any city — it is what the board
        // itself returned for one — unless the candidate said they do not want
        // remote work, in which case the place has to hold on its own.
        if (
          filterPlace &&
          !matchesLocation(job.location, wanted) &&
          !(input.remote !== false && job.isRemote === true)
        ) {
          droppedPlace += 1;
          continue;
        }
        if (input.remote === false && job.isRemote === true) {
          droppedOnsite += 1;
          continue;
        }
        if (query !== "" && !matchesKeyword(job, query)) {
          droppedKeyword += 1;
          continue;
        }

        kept.push(job);
        if (kept.length >= input.limit) break;
      }

      if (kept.length >= input.limit) break;
    }

    if (query !== "") {
      const narrowed = category
        ? `narrowed to category=${category}`
        : "no category of theirs matches those words";
      notes?.push(
        `the Muse has no keyword parameter; ${narrowed} and matched "${query}" locally over ${scanned} rows, dropping ${droppedKeyword}`,
      );
    }
    if (filterPlace) {
      const sent = plan.sentPlace
        ? `location "${wanted}" applied upstream as location=${plan.sentPlace}`
        : `the Muse resolves only "City, State/Country" places, so "${wanted}" never went upstream`;
      notes?.push(
        `${sent}; filtered ${droppedPlace} of ${scanned} rows locally for place`,
      );
    }
    if (input.remote === true) {
      notes?.push(
        wanted === ""
          ? `remote applied upstream as location=${REMOTE_LOCATION}`
          : `remote applied upstream as location=${REMOTE_LOCATION}, which is the whole of what its remote postings state, so "${wanted}" was not applied`,
      );
    }
    if (input.remote === false && droppedOnsite > 0) {
      notes?.push(
        `the Muse has no on-site filter; dropped ${droppedOnsite} remote rows locally`,
      );
    }

    return kept;
  },
};
