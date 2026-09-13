/** @vitest-environment jsdom */
import type {
  DiscoverResult,
  JobCard,
  JobSearchResult,
  LocationsResult,
} from "@domain";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SearchPage } from "@web/pages/SearchPage";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two surfaces that turn this page from a filter over 40 stale rows into a
 * job search: the place filter, and going out to the boards.
 *
 * Separate from `SearchPage.test.tsx` because these need the opposite fixture:
 * that suite resolves searches by hand to test ordering and history, while
 * everything here is about what a call carried and what the screen said about
 * the answer, so searches settle immediately and the recorded params are the
 * assertion.
 */

const PLACES: LocationsResult["locations"] = [
  { value: "Toronto, Canada", count: 15 },
  { value: "Vancouver, Canada", count: 3 },
  { value: "Remote - US", count: 8 },
];

const SOURCES = [
  { id: "freehire", label: "FreeHire", needsBoardToken: false },
  { id: "lever", label: "Lever", needsBoardToken: true },
];

/** Every non-probe search, oldest first. */
let searches: URLSearchParams[] = [];
let discoverBodies: unknown[] = [];
let corpus = 39;
let discoverReply: () => { status: number; body: unknown } = () => ({
  status: 200,
  body: { ok: true, data: EMPTY_DISCOVERY },
});

const EMPTY_DISCOVERY: DiscoverResult = {
  fetched: 0,
  inserted: 0,
  updated: 0,
  bySource: [],
};

function job(id: string): JobCard {
  return {
    id,
    source: "freehire",
    sourceJobId: `src-${id}`,
    title: "Senior Backend Engineer",
    company: "Monzo",
    location: "Toronto, Canada",
    isRemote: true,
    url: "https://example.test/jobs/1",
    applyUrl: null,
    descriptionText: "Build payment rails.",
    contactEmail: null,
    contactEmailSource: null,
    salaryText: null,
    postedAt: "2026-09-11T09:00:00.000Z",
    status: "discovered",
    score: 82,
    scoreReason: null,
    brief: null,
    tailoredHeadline: null,
    tailoredSummary: null,
    tailoredSkills: null,
    resumePath: null,
    discoveredAt: "2026-09-12T09:00:00.000Z",
    appliedAt: null,
    updatedAt: "2026-09-12T09:00:00.000Z",
    experienceMinYears: 5,
    experienceMaxYears: 8,
    salaryAnnual: null,
    locationCountry: "CA",
    locationRegion: "north_america",
    tags: [],
  };
}

function searchResult(total: number): JobSearchResult {
  return {
    jobs: total > 0 ? [job("j1")] : [],
    total,
    limit: 25,
    offset: 0,
    facets: {
      sources: [{ value: "freehire", count: total }],
      statuses: [
        { value: "discovered", count: total },
        { value: "screened", count: 0 },
        { value: "ready", count: 0 },
        { value: "applied", count: 0 },
        { value: "closed", count: 0 },
      ],
      remote: { remote: total, onsite: 0, unknown: 0 },
      experience: [],
      countries: [],
      regions: [],
      tags: [],
    },
  };
}

function installFetch() {
  const impl = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const [path, search = ""] = url.split("?");
      const params = new URLSearchParams(search);
      const json = (status: number, body: unknown) =>
        ({ status, json: async () => body }) as unknown as Response;

      if (path === "/api/locations") {
        return json(200, { ok: true, data: { locations: PLACES } });
      }
      if (path === "/api/sources") {
        return json(200, { ok: true, data: { sources: SOURCES } });
      }
      if (path === "/api/discover") {
        discoverBodies.push(JSON.parse(String(init?.body ?? "{}")));
        const reply = discoverReply();
        return json(reply.status, reply.body);
      }
      if (path === "/api/jobs/search") {
        // The unfiltered corpus probe is the only call that carries nothing but
        // `limit=1`; everything else is a real search worth recording.
        const probe =
          params.get("limit") === "1" && [...params.keys()].length === 1;
        if (probe) return json(200, { ok: true, data: searchResult(corpus) });
        searches.push(params);
        return json(200, {
          ok: true,
          data: searchResult(corpus === 0 ? 0 : 1),
        });
      }
      throw new Error(`No stub route for ${url}`);
    },
  );

  vi.stubGlobal("fetch", impl);
}

function UrlProbe() {
  const location = useLocation();
  return <output data-testid="url">{location.search}</output>;
}

async function mount(initialUrl = "/") {
  const view = render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <SearchPage />
      <UrlProbe />
    </MemoryRouter>,
  );
  // Let the first search, the corpus probe and the places lookup settle.
  await act(async () => {});
  return view;
}

const params = () =>
  new URLSearchParams(screen.getByTestId("url").textContent ?? "");
const lastSearch = () => searches[searches.length - 1] as URLSearchParams;

beforeEach(() => {
  searches = [];
  discoverBodies = [];
  corpus = 39;
  discoverReply = () => ({
    status: 200,
    body: { ok: true, data: EMPTY_DISCOVERY },
  });
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Picks a place through the typeahead the way a pointer would. */
async function pickPlace(typed: string, option: string) {
  const input = screen.getByLabelText("Place", {
    selector: "#filter-locations",
  });
  await act(async () => {
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: typed } });
  });
  const list = screen.getByRole("listbox", { name: /matching places/i });
  await act(async () => {
    fireEvent.click(
      within(list).getByRole("option", { name: new RegExp(option) }),
    );
  });
}

describe("place filter", () => {
  it("carries both chosen places into the URL and the request, and drops one without the other", async () => {
    await mount();

    await pickPlace("tor", "Toronto, Canada");
    await pickPlace("van", "Vancouver, Canada");

    // Both places survive in the address bar, each whole: a place holds its
    // own comma, so the list cannot be flattened into one CSV value.
    expect(params().getAll("locations")).toEqual([
      "Toronto, Canada",
      "Vancouver, Canada",
    ]);
    expect(lastSearch().getAll("locations")).toEqual([
      "Toronto, Canada",
      "Vancouver, Canada",
    ]);

    // One removable chip per place.
    expect(
      screen.getByTestId("chip-locations:Toronto, Canada"),
    ).toHaveTextContent("in Toronto, Canada");
    expect(
      screen.getByTestId("chip-locations:Vancouver, Canada"),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("chip-locations:Toronto, Canada"));
    });

    expect(params().getAll("locations")).toEqual(["Vancouver, Canada"]);
    expect(lastSearch().getAll("locations")).toEqual(["Vancouver, Canada"]);
    expect(
      screen.queryByTestId("chip-locations:Toronto, Canada"),
    ).not.toBeInTheDocument();
  });

  it("removes a place from the rail's own chip too", async () => {
    await mount();
    await pickPlace("rem", "Remote - US");

    await act(async () => {
      fireEvent.click(screen.getByTestId("place-chip-Remote - US"));
    });

    expect(params().has("locations")).toBe(false);
    expect(lastSearch().has("locations")).toBe(false);
  });

  it("keeps a place and the remote toggle as independent dimensions", async () => {
    await mount();
    await pickPlace("tor", "Toronto, Canada");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Remote"));
    });

    // A remote role posted out of Toronto answers both, so choosing one must
    // not clear the other.
    expect(lastSearch().getAll("locations")).toEqual(["Toronto, Canada"]);
    expect(lastSearch().get("remote")).toBe("true");
  });

  it("accepts a place the corpus has never seen", async () => {
    await mount();
    const input = screen.getByLabelText("Place", {
      selector: "#filter-locations",
    });
    await act(async () => {
      fireEvent.change(input, { target: { value: "Reykjavik" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });

    // The server matches locations as a substring, so a typed place with no
    // suggestion behind it is a legitimate search, not an invalid value.
    expect(lastSearch().getAll("locations")).toEqual(["Reykjavik"]);
  });
});

describe("board search", () => {
  it("reports the source that answered next to the one that failed", async () => {
    discoverReply = () => ({
      status: 200,
      body: {
        ok: true,
        data: {
          fetched: 12,
          inserted: 9,
          updated: 3,
          bySource: [
            { source: "freehire", fetched: 12 },
            { source: "lever", fetched: 0, error: "lever returned 503" },
          ],
        } satisfies DiscoverResult,
      },
    });

    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /board search/i }));
    });

    const query = screen.getByLabelText("Role or keywords");
    await act(async () => {
      fireEvent.change(query, { target: { value: "staff backend" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Search boards" }));
    });

    const report = await screen.findByRole("list", {
      name: /result by source/i,
    });
    const rows = within(report).getAllByRole("listitem");

    // Both outcomes, named. A partial fan-out reported as one failure would
    // hide nine new postings; reported as one success it would hide a board
    // that is down.
    expect(rows[0]).toHaveTextContent("freehire");
    expect(rows[0]).toHaveTextContent("12 postings");
    expect(rows[1]).toHaveTextContent("lever");
    expect(rows[1]).toHaveTextContent("lever returned 503");

    expect(screen.getByText(/1 of 2 sources answered/i)).toBeInTheDocument();
    expect(discoverBodies).toEqual([{ query: "staff backend" }]);
  });

  it("separates a source skipped for want of a token from one that failed", async () => {
    discoverReply = () => ({
      status: 200,
      body: {
        ok: true,
        data: {
          fetched: 4,
          inserted: 4,
          updated: 0,
          bySource: [
            {
              source: "freehire",
              fetched: 4,
              notes: ['location "Ontario" filtered locally'],
            },
            {
              source: "lever",
              fetched: 0,
              skipped: true,
              error: "lever needs a company board token",
            },
          ],
        } satisfies DiscoverResult,
      },
    });

    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /board search/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Search boards" }));
    });

    const report = await screen.findByRole("list", {
      name: /result by source/i,
    });
    const rows = within(report).getAllByRole("listitem");

    expect(rows[1]).toHaveTextContent("skipped");
    expect(rows[1]).toHaveTextContent("lever needs a company board token");
    // A skip is not a failure, so the summary must not claim a board is down.
    expect(screen.queryByText(/sources answered/i)).not.toBeInTheDocument();
    // The note about what became of the place filter is the honest answer to
    // "did my location actually apply".
    expect(
      screen.getByText(/location "Ontario" filtered locally/),
    ).toBeInTheDocument();
  });

  it("sends the place and the work arrangement the user chose", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /board search/i }));
    });

    await act(async () => {
      fireEvent.change(
        screen.getByLabelText("Place", {
          selector: "#discover-location",
        }),
        { target: { value: "Toronto, Canada" } },
      );
      fireEvent.click(
        screen.getByLabelText("Remote", { selector: "#discover-remote-yes" }),
      );
      fireEvent.click(screen.getByLabelText(/FreeHire/));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Search boards" }));
    });

    expect(discoverBodies).toEqual([
      { location: "Toronto, Canada", remote: true, sources: ["freehire"] },
    ]);
  });

  it("shows the server's own message when the whole discovery fails", async () => {
    discoverReply = () => ({
      status: 502,
      body: {
        ok: false,
        error: {
          code: "UPSTREAM",
          message: "Every board refused the request.",
        },
      },
    });

    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /board search/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Search boards" }));
    });

    expect(
      await screen.findByText("Every board refused the request."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
  });

  it("points an empty database at the boards and hands the caret over", async () => {
    corpus = 0;
    await mount();

    // The empty list offers the action that actually fixes it rather than
    // asking the user to drop a filter they never set.
    const cta = await screen.findByRole("button", {
      name: "Search the boards",
    });
    await act(async () => {
      fireEvent.click(cta);
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Role or keywords")).toHaveFocus();
    });
  });

  it("re-runs the search and the place lookup after a discovery lands", async () => {
    discoverReply = () => ({
      status: 200,
      body: {
        ok: true,
        data: {
          fetched: 5,
          inserted: 5,
          updated: 0,
          bySource: [{ source: "freehire", fetched: 5 }],
        } satisfies DiscoverResult,
      },
    });

    await mount();
    const before = searches.length;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /board search/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Search boards" }));
    });

    // Rows were written, so the list on screen is stale until it is refetched.
    await waitFor(() => {
      expect(searches.length).toBeGreaterThan(before);
    });
  });
});
