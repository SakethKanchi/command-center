/** @vitest-environment jsdom */
import type { JobCard, JobSearchResult } from "@domain";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SearchPage } from "@web/pages/SearchPage";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The search screen talks to the server through global `fetch` only, so a
 * stub is enough to drive every state. This suite uses its own stub rather
 * than the shared `installFetch` because two things matter here that the
 * dashboard never needed: the exact query string of each call, and the ability
 * to resolve calls out of the order they were made.
 */

type Pending = {
  url: string;
  params: URLSearchParams;
  resolve: (result: JobSearchResult) => void;
  reject: (error: { code: string; message: string }) => void;
};

let pending: Pending[] = [];

/** Stated places the location typeahead is offered in every test. */
const PLACES = [
  { value: "Toronto, Canada", count: 15 },
  { value: "Vancouver, Canada", count: 3 },
];

/**
 * What `/api/profile/role-suggestions` answers. Defaults to the no-resume
 * case, so the row renders nothing and every pre-existing test sees the screen
 * it was written against.
 */
let roleSuggestions: {
  suggestions: Array<{ title: string; query: string; reason: string }>;
  generatedAt: string | null;
  stale: boolean;
  profileSource: "stored" | "seed";
} = {
  suggestions: [],
  generatedAt: null,
  stale: false,
  profileSource: "seed",
};

function installFetch() {
  const impl = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const [path, search = ""] = url.split("?");
    const json = (body: unknown) =>
      ({ status: 200, json: async () => body }) as unknown as Response;

    if (path === "/api/agent/apply") {
      return json({ ok: true, data: { run: { id: "run_1" } } });
    }
    // Answered immediately and deliberately kept out of `pending`: it is a
    // lookup the page fires once, not a search, and letting it into the queue
    // silently shifted every `takeSearches()` index by one.
    if (path === "/api/locations") {
      return json({ ok: true, data: { locations: PLACES } });
    }
    if (path === "/api/profile/role-suggestions") {
      return json({ ok: true, data: roleSuggestions });
    }
    // Same reasoning for the adapter registry: the discover panel reads it
    // once on mount, which an empty corpus triggers on its own.
    if (path === "/api/sources") {
      return json({
        ok: true,
        data: {
          sources: [
            { id: "freehire", label: "FreeHire", needsBoardToken: false },
          ],
        },
      });
    }
    // Anything new must be stubbed explicitly rather than mistaken for a
    // search, so an unrouted endpoint fails loudly here instead of corrupting
    // the assertions of unrelated tests.
    if (path !== "/api/jobs/search") {
      throw new Error(`No stub route for ${url}`);
    }

    const params = new URLSearchParams(search);
    return await new Promise<Response>((settle) => {
      pending.push({
        url,
        params,
        resolve: (result) => settle(json({ ok: true, data: result })),
        reject: (error) =>
          settle({
            status: 500,
            json: async () => ({ ok: false, error }),
          } as unknown as Response),
      });
    });
  });

  vi.stubGlobal("fetch", impl);
  return impl;
}

/** The corpus probe is the only call carrying `limit=1` and nothing else. */
function isProbe(call: Pending): boolean {
  return call.params.get("limit") === "1";
}

function takeSearches(): Pending[] {
  return pending.filter((call) => !isProbe(call));
}

/** Answers the count probe so the page can leave its "counting…" state. */
async function settleProbe(total = 39) {
  const probe = pending.find(isProbe);
  if (!probe) throw new Error("no corpus probe issued");
  pending = pending.filter((call) => call !== probe);
  await act(async () => {
    probe.resolve(result({ total, jobs: [] }));
  });
}

async function settle(call: Pending, value: JobSearchResult) {
  pending = pending.filter((entry) => entry !== call);
  await act(async () => {
    call.resolve(value);
  });
}

function job(overrides: Partial<JobCard> & Pick<JobCard, "id">): JobCard {
  return {
    source: "greenhouse",
    sourceJobId: `src-${overrides.id}`,
    title: "Senior Backend Engineer",
    company: "Monzo",
    location: "London, UK",
    isRemote: true,
    url: "https://example.test/jobs/1",
    applyUrl: null,
    descriptionText: "Build payment rails.",
    contactEmail: null,
    contactEmailSource: null,
    salaryText: "£95k–£120k",
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
    salaryAnnual: 120000,
    locationCountry: "GB",
    locationRegion: "emea",
    tags: [],
    ...overrides,
  };
}

function result(overrides: Partial<JobSearchResult> = {}): JobSearchResult {
  return {
    jobs: [],
    total: 0,
    limit: 25,
    offset: 0,
    facets: {
      sources: [
        { value: "greenhouse", count: 21 },
        { value: "lever", count: 18 },
      ],
      statuses: [
        { value: "discovered", count: 30 },
        { value: "screened", count: 5 },
        { value: "ready", count: 2 },
        { value: "applied", count: 2 },
        { value: "closed", count: 0 },
      ],
      remote: { remote: 24, onsite: 11, unknown: 4 },
      experience: [
        { label: "0–2 yrs", minYears: 0, maxYears: 2, count: 6 },
        { label: "3–5 yrs", minYears: 3, maxYears: 5, count: 14 },
      ],
      countries: [],
      regions: [],
      tags: [],
    },
    ...overrides,
  };
}

/**
 * Publishes the live query string and a way to walk history, which is how the
 * "the URL is the state" claim gets checked rather than asserted.
 */
function UrlProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="url">{location.search}</output>
      <button type="button" data-testid="go-back" onClick={() => navigate(-1)}>
        back
      </button>
    </>
  );
}

function mount(initialUrl = "/") {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <SearchPage />
      <UrlProbe />
    </MemoryRouter>,
  );
}

const url = () => screen.getByTestId("url").textContent ?? "";

beforeEach(() => {
  pending = [];
  roleSuggestions = {
    suggestions: [],
    generatedAt: null,
    stale: false,
    profileSource: "seed",
  };
  vi.useFakeTimers({ shouldAdvanceTime: true });
  installFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function typeQuery(value: string) {
  const input = screen.getByLabelText("Search job postings");
  // One event per character, the way a keyboard produces them.
  for (const character of value) {
    fireEvent.change(input, {
      target: { value: (input as HTMLInputElement).value + character },
    });
  }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

describe("SearchPage", () => {
  it("issues one request for a settled query, not one per keystroke", async () => {
    mount();
    await settleProbe();
    const first = takeSearches();
    expect(first).toHaveLength(1);
    await settle(first[0] as Pending, result({ total: 39 }));

    await typeQuery("staff");

    const searches = takeSearches();
    expect(searches).toHaveLength(1);
    expect(searches[0]?.params.get("q")).toBe("staff");
    expect(url()).toContain("q=staff");
  });

  it("searches a suggested role from the stored resume in one click", async () => {
    roleSuggestions = {
      suggestions: [
        {
          title: "Compiler Engineer",
          query: "compiler engineer",
          reason: "Built A-0 at Eckert-Mauchly.",
        },
      ],
      generatedAt: "2026-09-12T09:00:00.000Z",
      stale: false,
      profileSource: "stored",
    };

    mount();
    await settleProbe();
    await settle(takeSearches()[0] as Pending, result({ total: 39 }));

    const chip = await screen.findByTestId("role-suggestion-compiler engineer");
    await act(async () => {
      fireEvent.click(chip);
    });

    const searches = takeSearches();
    expect(searches).toHaveLength(1);
    expect(searches[0]?.params.get("q")).toBe("compiler engineer");
    // The URL is the state, so a picked suggestion is a linkable result set.
    expect(url()).toContain("q=compiler+engineer");
    expect(
      (screen.getByLabelText("Search job postings") as HTMLInputElement).value,
    ).toBe("compiler engineer");
  });

  it("collapses a typing session into one history entry so back skips the whole word", async () => {
    mount();
    await settleProbe();
    await settle(takeSearches()[0] as Pending, result({ total: 39 }));

    await typeQuery("staff");
    await settle(
      takeSearches()[0] as Pending,
      result({ total: 2, jobs: [job({ id: "s1", title: "Staff SRE" })] }),
    );

    // Same typing session continuing: this must land on the existing entry.
    await typeQuery("engineer");
    await settle(
      takeSearches()[0] as Pending,
      result({ total: 1, jobs: [job({ id: "s2", title: "Staff Engineer" })] }),
    );
    expect(url()).toContain("q=staffengineer");

    // One press, not thirteen: back lands before the word was typed.
    await act(async () => {
      fireEvent.click(screen.getByTestId("go-back"));
    });
    expect(url()).toBe("");
    expect(
      (screen.getByLabelText("Search job postings") as HTMLInputElement).value,
    ).toBe("");

    // And the previous result set is re-fetched, not resurrected from memory.
    const restored = takeSearches()[0] as Pending;
    expect(restored.params.has("q")).toBe(false);
    await settle(
      restored,
      result({
        total: 39,
        jobs: [job({ id: "r1", title: "Everything Role" })],
      }),
    );
    expect(screen.getByText("Everything Role")).toBeInTheDocument();
  });

  it("restores a filter's own history entry independently of the text", async () => {
    mount();
    await settleProbe();
    await settle(takeSearches()[0] as Pending, result({ total: 39 }));

    await typeQuery("rust");
    await settle(takeSearches()[0] as Pending, result({ total: 5 }));

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Remote"));
    });
    await settle(takeSearches()[0] as Pending, result({ total: 3 }));
    expect(url()).toContain("remote=true");

    await act(async () => {
      fireEvent.click(screen.getByTestId("go-back"));
    });

    // The text survives; only the filter step is undone.
    expect(url()).toContain("q=rust");
    expect(url()).not.toContain("remote");
    expect(screen.getByLabelText("Any")).toBeChecked();
  });

  it("keeps the newer results when a slow earlier response lands last", async () => {
    mount();
    await settleProbe();
    await settle(takeSearches()[0] as Pending, result({ total: 39 }));

    await typeQuery("rust");
    const slow = takeSearches()[0] as Pending;
    expect(slow.params.get("q")).toBe("rust");

    // Second query while the first is still in flight.
    await typeQuery("go");
    const fast = takeSearches().find(
      (call) => call.params.get("q") === "rustgo",
    ) as Pending;
    expect(fast).toBeDefined();

    // The newer query answers first…
    await settle(
      fast,
      result({ total: 1, jobs: [job({ id: "new", title: "Go Engineer" })] }),
    );
    expect(screen.getByText("Go Engineer")).toBeInTheDocument();

    // …and the stale one lands afterwards. It must not win.
    await settle(
      slow,
      result({ total: 1, jobs: [job({ id: "old", title: "Rust Engineer" })] }),
    );

    expect(screen.getByText("Go Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Rust Engineer")).not.toBeInTheDocument();
  });

  it("keeps a comma inside one location instead of splitting it into two places", async () => {
    // The live corpus stores places as "Toronto, Canada". Serialising the list
    // as CSV made the server read that as Toronto OR Canada, which the
    // substring match widened to every posting in the country — so every city
    // returned the same rows.
    mount("/?locations=Toronto%2C+Canada&locations=Vancouver%2C+Canada");
    await settleProbe();

    const call = takeSearches()[0] as Pending;
    expect(call.params.getAll("locations")).toEqual([
      "Toronto, Canada",
      "Vancouver, Canada",
    ]);
    await settle(call, result({ total: 3, jobs: [job({ id: "l1" })] }));

    // One chip per place, each naming the whole place.
    expect(
      screen.getByTestId("chip-locations:Toronto, Canada"),
    ).toHaveTextContent("in Toronto, Canada");
    expect(
      screen.getByTestId("chip-locations:Vancouver, Canada"),
    ).toBeInTheDocument();

    // Removing one leaves the other whole rather than shedding a fragment.
    await act(async () => {
      fireEvent.click(screen.getByTestId("chip-locations:Toronto, Canada"));
    });
    expect((takeSearches()[0] as Pending).params.getAll("locations")).toEqual([
      "Vancouver, Canada",
    ]);
  });

  it("sends both year bounds for a 5-10 range and neither for any", async () => {
    mount();
    await settleProbe();
    await settle(takeSearches()[0] as Pending, result({ total: 39 }));

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Min years"), {
        target: { value: "5" },
      });
    });
    await settle(takeSearches()[0] as Pending, result({ total: 12 }));

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Max years"), {
        target: { value: "10" },
      });
    });
    const ranged = takeSearches()[0] as Pending;
    expect(ranged.params.get("minYears")).toBe("5");
    expect(ranged.params.get("maxYears")).toBe("10");
    expect(url()).toContain("minYears=5");
    expect(url()).toContain("maxYears=10");
    await settle(ranged, result({ total: 12 }));

    // "Any" is not "0": both bounds leave the query entirely.
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Min years"), {
        target: { value: "" },
      });
    });
    await settle(takeSearches()[0] as Pending, result({ total: 20 }));
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Max years"), {
        target: { value: "" },
      });
    });

    const anyYears = takeSearches()[0] as Pending;
    expect(anyYears.params.has("minYears")).toBe(false);
    expect(anyYears.params.has("maxYears")).toBe(false);
    expect(url()).not.toContain("Years");
  });

  it("sends minYears=0 when zero is chosen deliberately", async () => {
    mount();
    await settleProbe();
    await settle(takeSearches()[0] as Pending, result({ total: 39 }));

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Min years"), {
        target: { value: "0" },
      });
    });

    expect((takeSearches()[0] as Pending).params.get("minYears")).toBe("0");
  });

  it("renders filters that were already in the URL and clears them all at once", async () => {
    mount("/?q=platform&statuses=applied&remote=true&minYears=3&maxYears=6");
    await settleProbe();

    const initial = takeSearches()[0] as Pending;
    expect(initial.params.get("q")).toBe("platform");
    expect(initial.params.get("statuses")).toBe("applied");
    expect(initial.params.get("remote")).toBe("true");
    await settle(initial, result({ total: 4, jobs: [job({ id: "a" })] }));

    // The controls show the URL's state, not defaults.
    expect(
      (screen.getByLabelText("Search job postings") as HTMLInputElement).value,
    ).toBe("platform");
    expect(screen.getByLabelText("Remote")).toBeChecked();
    expect(screen.getByLabelText("Applied")).toBeChecked();
    expect(
      (screen.getByLabelText("Min years") as HTMLSelectElement).value,
    ).toBe("3");

    expect(screen.getByTestId("chip-q")).toHaveTextContent("platform");
    expect(screen.getByTestId("chip-years")).toHaveTextContent("3–6 yrs");
    expect(screen.getByTestId("chip-remote")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    });

    expect(url()).toBe("");
    expect(screen.queryByTestId("chip-q")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chip-years")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chip-remote")).not.toBeInTheDocument();
    expect(
      (screen.getByLabelText("Search job postings") as HTMLInputElement).value,
    ).toBe("");
  });

  it("returns focus to the row that opened the drawer when Escape closes it", async () => {
    mount();
    await settleProbe();
    await settle(
      takeSearches()[0] as Pending,
      result({
        total: 1,
        jobs: [job({ id: "j1", title: "Staff Platform Engineer" })],
      }),
    );

    const row = screen.getByRole("button", { name: "Staff Platform Engineer" });
    await act(async () => {
      fireEvent.click(row);
    });

    const drawer = screen.getByRole("dialog");
    expect(drawer).toHaveTextContent("Build payment rails.");
    expect(drawer.contains(document.activeElement)).toBe(true);

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(row);
  });

  it("offers the narrowest filter to drop when nothing matches", async () => {
    mount("/?statuses=closed&q=kubernetes");
    await settleProbe();

    // `closed` admits nothing, so it is the provable culprit — not the text.
    await settle(takeSearches()[0] as Pending, result({ total: 0, jobs: [] }));

    expect(
      screen.getByRole("button", { name: /drop status: closed/i }),
    ).toBeInTheDocument();
  });

  it("points at a way to fetch postings when the database itself is empty", async () => {
    mount();
    await settleProbe(0);
    await settle(takeSearches()[0] as Pending, result({ total: 0, jobs: [] }));

    expect(
      screen.getByRole("button", { name: /search the boards/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("npm run seed")).toBeInTheDocument();
    expect(
      screen.queryByText(/nothing matches all of those filters/i),
    ).not.toBeInTheDocument();
  });

  it("shows the server's message and retries on demand", async () => {
    mount();
    await settleProbe();

    const failing = takeSearches()[0] as Pending;
    pending = pending.filter((entry) => entry !== failing);
    await act(async () => {
      failing.reject({
        code: "UPSTREAM",
        message: "Search index is rebuilding.",
      });
    });

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Search index is rebuilding.",
      ),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    });
    await settleProbe();
    await settle(
      takeSearches()[0] as Pending,
      result({
        total: 1,
        jobs: [job({ id: "back", title: "Recovered Role" })],
      }),
    );

    expect(screen.getByText("Recovered Role")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the paging offset in the URL", async () => {
    mount();
    await settleProbe(80);
    await settle(
      takeSearches()[0] as Pending,
      result({ total: 80, jobs: [job({ id: "p1" })] }),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /next/i }));
    });

    expect((takeSearches()[0] as Pending).params.get("offset")).toBe("25");
    expect(url()).toContain("offset=25");
  });

  it("counts the corpus against the matches", async () => {
    mount("/?remote=true");
    await settleProbe(39);
    await settle(
      takeSearches()[0] as Pending,
      result({ total: 12, jobs: [job({ id: "c1" })] }),
    );

    const count = screen.getByText(/roles/).textContent ?? "";
    expect(count.replace(/\s+/g, " ")).toContain("39 roles · 12 match");
  });

  it("does not print the company twice when the title already carries it", async () => {
    mount();
    await settleProbe();
    await settle(
      takeSearches()[0] as Pending,
      result({
        total: 2,
        jobs: [
          // Shape the live corpus actually holds, from an older ingest run.
          job({
            id: "dup",
            title: "Senior Full Stack Engineer at RBC",
            company: "RBC",
          }),
          // A title whose "at" is part of the role, not the employer.
          job({ id: "keep", title: "Engineer at Scale", company: "Scale AI" }),
        ],
      }),
    );

    const dup = within(screen.getByTestId("result-dup"));
    expect(
      dup.getByRole("button", { name: "Senior Full Stack Engineer" }),
    ).toBeInTheDocument();
    expect(
      dup.getByRole("button", {
        name: "Apply for me: Senior Full Stack Engineer at RBC",
      }),
    ).toBeInTheDocument();

    expect(
      within(screen.getByTestId("result-keep")).getByRole("button", {
        name: "Engineer at Scale",
      }),
    ).toBeInTheDocument();
  });

  it("shows a real unscored marker instead of a zero", async () => {
    mount();
    await settleProbe();
    await settle(
      takeSearches()[0] as Pending,
      result({ total: 1, jobs: [job({ id: "u1", score: null })] }),
    );

    // Scoped to the row: an unscored posting must not present a fabricated 0.
    const row = within(screen.getByTestId("result-u1"));
    expect(row.getByText("unscored")).toBeInTheDocument();
    expect(row.queryByText("0")).toBeNull();
  });
});
