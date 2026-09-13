import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobSearchResult } from "@domain";
import { respondWithError } from "@server/api/respond";
import { createJobRoutes } from "@server/api/routes/jobs";
import { type Db, openDatabase } from "@server/db";
import type { LlmClient } from "@server/llm";
import { createRepos, type RepoBundle } from "@server/repos";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  dir = mkdtempSync(join(tmpdir(), "command-center-jobs-routes-"));
  db = openDatabase(join(dir, "t.db"));
  repos = createRepos(db);

  // Mounted exactly as the server mounts it, so the tested paths are the real
  // ones and the error envelope is the shared one.
  app = new Hono();
  app.onError(respondWithError);
  app.route(
    "/api",
    createJobRoutes({ repos, llm, baseUrl: "http://localhost:8787" }),
  );
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(overrides: Record<string, unknown> = {}) {
  const url = (overrides.url as string) ?? "https://boards.example.com/a";
  repos.jobs.upsertMany([
    {
      source: "greenhouse",
      sourceJobId: null,
      title: "Staff Engineer",
      company: "Acme",
      location: "Berlin",
      isRemote: false,
      applyUrl: null,
      descriptionText: "6+ years of experience with distributed systems.",
      salaryText: null,
      postedAt: null,
      ...overrides,
      url,
    },
  ]);
  const job = repos.jobs.getByUrl(url);
  if (!job) throw new Error("seed failed");
  return job;
}

async function searchVia(query: string): Promise<JobSearchResult> {
  const res = await app.request(`/api/jobs/search${query}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: true; data: JobSearchResult };
  expect(body.ok).toBe(true);
  return body.data;
}

describe("GET /api/jobs/search", () => {
  it("answers a bare request with the whole corpus", async () => {
    seed();
    seed({ url: "https://boards.example.com/b", title: "Data Engineer" });

    const result = await searchVia("");
    expect(result.total).toBe(2);
    expect(result.limit).toBe(25);
    expect(result.offset).toBe(0);
    expect(result.facets.sources).toEqual([{ value: "greenhouse", count: 2 }]);
  });

  it("accepts list filters as repeated keys or one comma-separated value", async () => {
    seed();
    seed({
      url: "https://boards.example.com/b",
      source: "lever",
      title: "Data Engineer",
    });
    seed({
      url: "https://boards.example.com/c",
      source: "ashby",
      title: "ML Engineer",
    });

    const csv = await searchVia("?sources=greenhouse,lever");
    const repeated = await searchVia("?sources=greenhouse&sources=lever");

    expect(csv.total).toBe(2);
    expect(repeated.jobs.map((job) => job.title).sort()).toEqual(
      csv.jobs.map((job) => job.title).sort(),
    );
  });

  it("carries the parsed experience window on each card", async () => {
    seed();

    const result = await searchVia("?minYears=7&maxYears=9");
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      title: "Staff Engineer",
      experienceMinYears: 6,
      experienceMaxYears: null,
    });
  });

  it("names the offending parameter instead of returning an empty page", async () => {
    seed();

    const res = await app.request("/api/jobs/search?sort=banana");
    expect(res.status).toBe(400);

    const body = (await res.json()) as {
      ok: false;
      error: { code: string; message: string; details?: unknown };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(body.error.message).toContain("sort");
    expect(body.error.details).toMatchObject({
      fieldErrors: { sort: expect.any(Array) },
    });
  });

  it("rejects a non-numeric range bound by name", async () => {
    seed();

    const res = await app.request("/api/jobs/search?minYears=three");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("minYears");
  });

  it("rejects a pay floor that is not a positive whole number, by name", async () => {
    seed();

    for (const value of ["lots", "-5", "0", "12.5"]) {
      const res = await app.request(
        `/api/jobs/search?minSalary=${encodeURIComponent(value)}`,
      );
      expect(res.status, value).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message, value).toContain("minSalary");
    }
  });

  it("filters on a pay floor round-tripped through the query string", async () => {
    seed({ salaryText: "$120,000 - $180,000" });
    seed({
      url: "https://boards.example.com/b",
      title: "Data Engineer",
      salaryText: "$90,000",
    });
    seed({
      url: "https://boards.example.com/c",
      title: "Vague Engineer",
      salaryText: "Competitive",
    });

    const result = await searchVia("?minSalary=150000");
    expect(result.jobs.map((job) => job.title)).toEqual(["Staff Engineer"]);
    expect(result.jobs[0]?.salaryAnnual).toBe(180_000);
  });

  it("rejects a tag outside the vocabulary rather than widening the search", async () => {
    seed();

    const res = await app.request("/api/jobs/search?tags=skill:cobol");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("tags");
  });

  it("reads an empty parameter as unset rather than zero", async () => {
    // An untouched slider renders `minScore=`; coercing that to 0 would apply a
    // filter the candidate never set.
    seed();
    const result = await searchVia("?minScore=&q=");
    expect(result.total).toBe(1);
  });

  it("treats a comma-bearing place as one location, not two", async () => {
    // Places arrive as "Toronto, Canada". Comma-splitting turned that into
    // ["Toronto","Canada"], and since locations OR together as substrings,
    // "Canada" matched every Canadian row — so every city returned the same
    // set. Measured on the real corpus: Toronto and Vancouver both gave 27.
    seed({ url: "https://b.example.com/t", location: "Toronto, Canada" });
    seed({ url: "https://b.example.com/v", location: "Vancouver, Canada" });
    seed({ url: "https://b.example.com/m", location: "Montreal, Canada" });

    const result = await searchVia(
      `?locations=${encodeURIComponent("Toronto, Canada")}`,
    );

    expect(result.total).toBe(1);
    expect(result.jobs[0]?.location).toBe("Toronto, Canada");
  });

  it("accepts several places as repeated keys", async () => {
    seed({ url: "https://b.example.com/t", location: "Toronto, Canada" });
    seed({ url: "https://b.example.com/v", location: "Vancouver, Canada" });
    seed({ url: "https://b.example.com/m", location: "Montreal, Canada" });

    const result = await searchVia(
      `?locations=${encodeURIComponent("Toronto, Canada")}&locations=${encodeURIComponent("Vancouver, Canada")}`,
    );

    expect(result.total).toBe(2);
    expect(result.jobs.map((job) => job.location).sort()).toEqual([
      "Toronto, Canada",
      "Vancouver, Canada",
    ]);
  });

  it("still comma-splits enum lists, whose values cannot contain a comma", async () => {
    seed({ url: "https://b.example.com/1" });
    seed({ url: "https://b.example.com/2", source: "lever" });

    const result = await searchVia("?sources=greenhouse,lever");
    expect(result.total).toBe(2);
  });
});

describe("GET /api/jobs/:id", () => {
  it("returns the posting with its experience window", async () => {
    const job = seed();

    const res = await app.request(`/api/jobs/${job.id}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { job: { id: string; experienceMinYears: number | null } };
    };
    expect(body.data.job.id).toBe(job.id);
    expect(body.data.job.experienceMinYears).toBe(6);
  });

  it("404s for an unknown id in the shared envelope", async () => {
    const res = await app.request("/api/jobs/does-not-exist");
    expect(res.status).toBe(404);

    const body = (await res.json()) as {
      ok: false;
      error: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

describe("POST /api/jobs/:id/contact", () => {
  async function setContact(id: string, body: unknown) {
    return app.request(`/api/jobs/${id}/contact`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("stores a confirmed recipient and reports it as manual", async () => {
    const job = seed();

    const res = await setContact(job.id, { email: " Dana@Acme.io " });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { job: { contactEmail: string; contactEmailSource: string } };
    };
    expect(body.data.job.contactEmail).toBe("Dana@Acme.io");
    expect(body.data.job.contactEmailSource).toBe("manual");
  });

  it("clears the override on null, restoring the posting's own address", async () => {
    const job = seed({
      descriptionText: "6+ years of experience. Write to careers@acme.io.",
    });
    await setContact(job.id, { email: "dana@acme.io" });

    const res = await setContact(job.id, { email: null });
    const body = (await res.json()) as {
      data: { job: { contactEmail: string; contactEmailSource: string } };
    };
    expect(body.data.job.contactEmail).toBe("careers@acme.io");
    expect(body.data.job.contactEmailSource).toBe("posting");
  });

  it("rejects a malformed address rather than storing an unsendable one", async () => {
    const job = seed();

    const res = await setContact(job.id, { email: "not-an-address" });
    expect(res.status).toBe(400);
    expect(repos.jobs.get(job.id)?.contactEmail).toBeNull();
  });
});
