import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoverResult, LocationsResult } from "@domain";
import { respondWithError } from "@server/api/respond";
import { createDiscoverRoutes } from "@server/api/routes/discover";
import { type Db, openDatabase } from "@server/db";
import type { LlmClient } from "@server/llm";
import { createRepos, type RepoBundle } from "@server/repos";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let db: Db;
let repos: RepoBundle;
let app: Hono;

const llm: LlmClient = {
  model: "test-model",
  completeJson: async () => {
    throw new Error("no model call expected in these tests");
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "command-center-discover-"));
  db = openDatabase(join(dir, "t.db"));
  repos = createRepos(db);

  // Mounted exactly as the server mounts it, so the tested paths are the real
  // ones and the error envelope is the shared one.
  app = new Hono();
  app.onError(respondWithError);
  app.route(
    "/api",
    createDiscoverRoutes({ repos, llm, baseUrl: "http://localhost:8787" }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The route is the process boundary where the real transport is the global
 * `fetch`, so that is what a route-level test replaces. Every adapter beneath
 * it still takes the transport by injection.
 */
function stubFetch(route: (url: string) => Response): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push(url);
    return route(url);
  });
  return calls;
}

const leverPayload = [
  {
    id: "lev-1",
    text: "Data Engineer",
    hostedUrl: "https://jobs.lever.co/beta/lev-1",
    categories: { location: "Vancouver, Canada" },
    descriptionPlain: "Move data.",
  },
];

async function discover(body: unknown): Promise<DiscoverResult> {
  const res = await app.request("/api/discover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  const payload = (await res.json()) as { ok: true; data: DiscoverResult };
  expect(payload.ok).toBe(true);
  return payload.data;
}

describe("POST /api/discover", () => {
  it("persists the healthy board when another one fails", async () => {
    stubFetch((url) =>
      url.includes("greenhouse")
        ? jsonResponse({ message: "boom" }, 500)
        : jsonResponse(leverPayload),
    );

    const result = await discover({
      query: "engineer",
      sources: ["greenhouse", "lever"],
      boards: { greenhouse: "acme", lever: "beta" },
    });

    // The failure is named against its own board and the other board's row is
    // in the database — a discovery that threw away Lever's posting because
    // Greenhouse 500'd would be worse than useless.
    expect(result.bySource[0]).toMatchObject({
      source: "greenhouse",
      fetched: 0,
    });
    expect(result.bySource[0]?.error).toContain("500");
    expect(result.bySource[1]).toEqual({ source: "lever", fetched: 1 });
    expect(result.inserted).toBe(1);
    expect(repos.jobs.list().map((job) => job.title)).toEqual([
      "Data Engineer",
    ]);
  });

  it("reports an unknown source per source rather than rejecting the request", async () => {
    stubFetch(() => jsonResponse(leverPayload));

    const result = await discover({
      query: "engineer",
      sources: ["monster", "lever"],
      boards: { lever: "beta" },
    });

    expect(result.bySource[0]).toMatchObject({
      source: "monster",
      fetched: 0,
      error: 'unknown source "monster"',
    });
    expect(result.bySource[1]?.fetched).toBe(1);
  });

  it("skips a board-token source instead of firing a request that cannot work", async () => {
    const calls = stubFetch(() => jsonResponse({ data: [] }));

    const result = await discover({ query: "platform engineer" });

    // Default sources are every registered board, so the three ATS sources are
    // reported rather than silently dropped.
    const skipped = result.bySource.filter((report) => report.skipped);
    expect(skipped.map((report) => report.source).sort()).toEqual([
      "ashby",
      "greenhouse",
      "lever",
    ]);
    for (const report of skipped) {
      expect(report.error, report.source).toContain("board token");
      expect(report.fetched).toBe(0);
    }
    // The six keyless aggregators were each asked, and no request went to a
    // board that needs a company token — building one from an empty token is
    // the failure this skip exists to prevent.
    expect(result.bySource).toHaveLength(9);
    for (const host of [
      "freehire.me",
      "remotive.com",
      "jobicy.com",
      "himalayas.app",
      "www.themuse.com",
      "www.arbeitnow.com",
    ]) {
      expect(
        calls.some((url) => url.includes(host)),
        host,
      ).toBe(true);
    }
    expect(
      calls.filter((url) => /greenhouse\.io|ashbyhq\.com|lever\.co/.test(url)),
    ).toEqual([]);
  });

  it("never reports an all-skipped discovery as a search that found nothing", async () => {
    const calls = stubFetch(() => jsonResponse({ jobs: [] }));

    const result = await discover({
      query: "engineer",
      sources: ["greenhouse", "ashby"],
    });

    expect(calls).toEqual([]);
    expect(result).toMatchObject({ fetched: 0, inserted: 0, updated: 0 });
    // Zero counts alone would read as "searched, found nothing". Every row
    // carries the reason no search happened.
    expect(
      result.bySource.every(
        (report) => report.skipped === true && report.error,
      ),
    ).toBe(true);
  });

  it("carries the location to the aggregator and says what became of it", async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        data: [
          {
            public_slug: "a",
            url: "https://boards.example.com/a",
            title: "Platform Engineer",
            company: "Acme",
            location: "Toronto, Canada",
          },
        ],
      }),
    );

    const result = await discover({
      query: "platform engineer",
      location: "Toronto",
      remote: true,
      sources: ["freehire"],
    });

    const requested = new URL(calls[0] ?? "").searchParams;
    expect(requested.getAll("cities")).toEqual(["toronto"]);
    expect(requested.get("work_mode")).toBe("remote");
    expect(result.bySource[0]?.notes).toEqual([
      'location "Toronto" applied upstream as cities=toronto',
    ]);
  });

  it("rejects a discovery that asks for nothing at all", async () => {
    const res = await app.request("/api/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sources: ["freehire"] }),
    });

    expect(res.status).toBe(400);
    const payload = (await res.json()) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(payload.error.code).toBe("INVALID_REQUEST");
    expect(payload.error.message).toContain("query or a location");
  });
});

describe("GET /api/locations", () => {
  function seed(location: string | null, index: number): void {
    repos.jobs.upsertMany([
      {
        source: "freehire",
        sourceJobId: null,
        title: `Engineer ${index}`,
        company: "Acme",
        location,
        isRemote: null,
        applyUrl: null,
        descriptionText: "",
        salaryText: null,
        postedAt: null,
        url: `https://boards.example.com/j-${index}`,
      },
    ]);
  }

  async function locations(query = ""): Promise<LocationsResult["locations"]> {
    const res = await app.request(`/api/locations${query}`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ok: true; data: LocationsResult };
    return payload.data.locations;
  }

  it("ranks stated places by frequency for the typeahead", async () => {
    seed("Toronto, Canada", 1);
    seed("Toronto, Canada", 2);
    seed("Berlin, Germany", 3);
    seed(null, 4);

    expect(await locations()).toEqual([
      { value: "Toronto, Canada", count: 2 },
      { value: "Berlin, Germany", count: 1 },
    ]);
    expect(await locations("?limit=1")).toEqual([
      { value: "Toronto, Canada", count: 2 },
    ]);
  });

  it("offers one entry for spellings that mean the same place", async () => {
    // Both of these are Singapore, and picking either returns all four rows,
    // so two entries splitting the count would misstate both.
    seed("Singapore", 1);
    seed("Singapore", 2);
    seed("Singapore, Singapore", 3);
    seed("Québec", 4);
    seed("Quebec", 5);

    expect(await locations()).toEqual([
      { value: "Singapore", count: 3 },
      { value: "Quebec", count: 2 },
    ]);
  });
});
