import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@server/db";
import { openDatabase } from "@server/db";
import type { RepoBundle } from "@server/repos";
import { createRepos } from "@server/repos";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { arbeitnowAdapter } from "./arbeitnow";
import { ashbyAdapter } from "./ashby";
import { freehireAdapter } from "./freehire";
import { greenhouseAdapter } from "./greenhouse";
import { himalayasAdapter } from "./himalayas";
import { jobicyAdapter } from "./jobicy";
import { leverAdapter } from "./lever";
import { ingestJobs, listSourceAdapters, SOURCE_ADAPTERS } from "./registry";
import { remotiveAdapter } from "./remotive";
import { themuseAdapter } from "./themuse";
import {
  assertAllowedUrl,
  htmlToText,
  joinLocations,
  stripCompanyFromTitle,
  toIsoOrNull,
} from "./types";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  );
}

type Recorded = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The whole suite runs on this: every adapter takes its transport by
 * injection, so a recorded payload is enough to exercise the real request
 * construction, the real guards and the real mapping with no socket open.
 */
function makeFetch(route: (url: string) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({ url, init: init ?? {} });
    return route(url);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("source adapters", () => {
  it("maps a greenhouse board to NewJob rows", async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(fixture("greenhouse-jobs")),
    );

    const jobs = await greenhouseAdapter.fetchJobs({
      board: "northwindlabs",
      limit: 25,
      fetchImpl,
    });

    expect(calls[0]?.url).toBe(
      "https://boards-api.greenhouse.io/v1/boards/northwindlabs/jobs?content=true",
    );
    // The redirect guard is an SSRF control, not a preference.
    expect(calls[0]?.init.redirect).toBe("error");

    // The third fixture posting has no absolute_url: unusable, so dropped.
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toEqual({
      source: "greenhouse",
      sourceJobId: "4009231007",
      title: "Senior Backend Engineer",
      company: "Northwind Labs",
      location: "Remote - United States",
      isRemote: true,
      url: "https://job-boards.greenhouse.io/northwindlabs/jobs/4009231007",
      applyUrl: null,
      descriptionText:
        "We're hiring a Senior Backend Engineer. You will own latency & reliability for our ingestion tier. 6+ years of Go or TypeScript Postgres at scale",
      salaryText: null,
      postedAt: "2026-08-21T18:12:03.000Z",
    });
    expect(jobs[0]?.descriptionText).not.toMatch(/[<>]/);

    // No company_name on this one, so the board token stands in, and
    // first_published is absent so updated_at is the posting date.
    expect(jobs[1]?.company).toBe("Northwindlabs");
    expect(jobs[1]?.isRemote).toBe(false);
    expect(jobs[1]?.postedAt).toBe("2026-09-02T13:31:44.000Z");
    expect(jobs[1]?.descriptionText).toBe("Own the warehouse.");
  });

  it("maps an ashby board, folds secondary locations and trusts workplaceType", async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(fixture("ashby-job-board")),
    );

    const jobs = await ashbyAdapter.fetchJobs({
      board: "meridian",
      limit: 25,
      fetchImpl,
    });

    expect(calls[0]?.url).toBe(
      "https://api.ashbyhq.com/posting-api/job-board/meridian?includeCompensation=true",
    );
    // The unlisted draft never becomes a row.
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toEqual({
      source: "ashby",
      sourceJobId: "4b1a7c2e-9f31-4a18-8c44-2b2f0c7d55aa",
      title: "Product Engineer",
      company: "Meridian",
      location: "San Francisco, CA · Berlin · Germany",
      isRemote: true,
      url: "https://jobs.ashbyhq.com/meridian/4b1a7c2e-9f31-4a18-8c44-2b2f0c7d55aa",
      applyUrl:
        "https://jobs.ashbyhq.com/meridian/4b1a7c2e-9f31-4a18-8c44-2b2f0c7d55aa/application",
      descriptionText:
        "Build the product surface end to end. You will work across React and the API layer.",
      salaryText: "$180K – $220K • Offers Equity",
      postedAt: "2026-09-01T16:45:00.000Z",
    });

    // `isRemote: true` next to `workplaceType: "Hybrid"` is an office-anchored
    // role. Believing the boolean here is how a hybrid job passes a
    // remote-only filter.
    expect(jobs[1]?.isRemote).toBe(false);
    expect(jobs[1]?.salaryText).toBeNull();
  });

  it("maps lever postings, assembling the split description body", async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(fixture("lever-postings")),
    );

    const jobs = await leverAdapter.fetchJobs({
      board: "orbitalworks",
      limit: 25,
      fetchImpl,
    });

    expect(calls[0]?.url).toBe(
      "https://api.lever.co/v0/postings/orbitalworks?mode=json",
    );
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toEqual({
      source: "lever",
      sourceJobId: "7f3c1b90-2a44-4d51-bb7e-9c0d21a4e8f1",
      title: "Senior Platform Engineer",
      company: "Orbitalworks",
      location: "Remote (US) · Toronto, ON",
      isRemote: true,
      url: "https://jobs.lever.co/orbitalworks/7f3c1b90-2a44-4d51-bb7e-9c0d21a4e8f1",
      applyUrl:
        "https://jobs.lever.co/orbitalworks/7f3c1b90-2a44-4d51-bb7e-9c0d21a4e8f1/apply",
      // `descriptionPlain` is empty here, the intro is HTML-only, and the
      // requirements live in `lists[]`. Reading one field yields the intro and
      // none of the must-haves.
      descriptionText:
        "Own the deployment platform. What you will do Design CI/CD for 40 services Own the release train We are an equal opportunity employer.",
      salaryText: "USD 170,000–210,000/yr",
      postedAt: "2026-08-25T16:00:00.000Z",
    });
    expect(jobs[1]?.descriptionText).toBe(
      "Answer hard questions from customers.",
    );
    expect(jobs[1]?.isRemote).toBe(false);
    expect(jobs[1]?.salaryText).toBeNull();
    expect(jobs[1]?.postedAt).toBe("2026-08-13T16:00:00.000Z");
  });

  it("maps a freehire search, including the leaked-markup description", async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(fixture("freehire-search")),
    );

    const jobs = await freehireAdapter.fetchJobs({
      query: "platform engineer",
      limit: 25,
      fetchImpl,
    });

    const requested = new URL(calls[0]?.url ?? "");
    expect(requested.origin).toBe("https://freehire.me");
    expect(requested.pathname).toBe("/api/v1/agent/jobs/search");
    expect(requested.searchParams.get("q")).toBe("platform engineer");
    expect(requested.searchParams.get("limit")).toBe("25");
    expect(requested.searchParams.get("include_description")).toBe("true");
    expect(requested.searchParams.get("description_format")).toBe("text");

    // The third posting has no url — freehire indexes it but nothing can be
    // applied to, so it never becomes a row.
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toEqual({
      source: "freehire",
      sourceJobId: "ai-infrastructure-engineer-halcyon-7fd2",
      title: "AI Infrastructure Engineer",
      company: "Halcyon Systems",
      // The posting states "United States"; the "us" country facet is the same
      // place and must not be appended as a second location.
      location: "United States",
      isRemote: true,
      url: "https://boards.greenhouse.io/halcyon/jobs/5512890?utm_source=freehire.me",
      applyUrl: null,
      descriptionText:
        "Halcyon is building the eval harness for production LLM systems. You will own the inference gateway: routing, caching & failure isolation. Requirements: - 5 years backend - Comfortable with GPUs",
      salaryText: "USD 190,000–240,000/yr",
      postedAt: "2026-09-05T08:15:00.000Z",
    });

    // `location` is empty on this one: the geography is only in the facets,
    // and the lowercase country code is rendered as a country code.
    expect(jobs[1]?.location).toBe("Chicago · US");
    expect(jobs[1]?.isRemote).toBe(false);
    expect(jobs[1]?.salaryText).toBeNull();
    // Markdown section rule, leaked markup and an entity in one body.
    expect(jobs[1]?.descriptionText).toBe(
      "*About the role* Ship features across the stack. Work with React & Node.",
    );
    // posted_at is null on this one, so created_at is the fallback.
    expect(jobs[1]?.postedAt).toBe("2026-08-29T12:00:00.000Z");
  });

  it("maps a remotive feed and enforces the filters it only pretends to apply", async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(fixture("remotive-jobs")),
    );

    const jobs = await remotiveAdapter.fetchJobs({
      query: "data engineer",
      limit: 25,
      fetchImpl,
    });

    const requested = new URL(calls[0]?.url ?? "");
    expect(requested.origin).toBe("https://remotive.com");
    expect(requested.searchParams.get("search")).toBe("data engineer");
    // Widened to the board's ceiling, not the caller's page size: a keyword
    // this adapter has to match itself must see more than the first 25 rows of
    // a feed whose own search does nothing.
    expect(requested.searchParams.get("limit")).toBe("100");

    // Their search is advisory: the recorded payload is what the live board
    // really answers for an engineering query, marketing rows included. Only
    // the local pass narrows it, which is the whole reason it exists.
    expect(jobs.map((job) => job.title)).toEqual(["Senior Data Engineer"]);
    expect(jobs[0]).toEqual({
      source: "remotive",
      sourceJobId: "2091097",
      title: "Senior Data Engineer",
      company: "Lemon.io",
      location: "LATAM, Europe, USA, Canada, APAC",
      isRemote: true,
      url: "https://remotive.com/remote-jobs/software-development/senior-data-engineer-2091097",
      applyUrl: null,
      descriptionText:
        "Are you a talented Senior Data Engineer looking for a remote job that lets you show your skills and get decent compensation? Look no further than Lemon.io.",
      // The wire value is the empty string rather than an absent key.
      salaryText: null,
      postedAt: "2026-08-19T12:12:11.000Z",
    });
  });

  it("drops the remotive row with no link and keeps the employer's own pay text", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(fixture("remotive-jobs")),
    );

    const jobs = await remotiveAdapter.fetchJobs({ limit: 25, fetchImpl });

    // Four postings, one without a url: nothing to open and nothing to apply
    // to, so it never becomes a row.
    expect(jobs).toHaveLength(3);
    expect(jobs.some((job) => job.title === "Senior Backend Engineer")).toBe(
      false,
    );
    // A trailing space in the company name would split one employer in two on
    // every grouping pass.
    expect(jobs[0]?.company).toBe("Coalition Technologies");
    expect(jobs[2]?.salaryText).toBe("$14/hour");
  });

  it("refuses to answer an on-site search from a remote-only board", async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(fixture("remotive-jobs")),
    );
    const notes: string[] = [];

    const jobs = await remotiveAdapter.fetchJobs({
      query: "engineer",
      remote: false,
      limit: 25,
      fetchImpl,
      notes,
    });

    // Returning remote rows under a filter that excluded them would be
    // answering a different question, so no request goes out at all.
    expect(jobs).toEqual([]);
    expect(calls).toEqual([]);
    expect(notes).toEqual([
      "remotive lists only remote work, so it was not queried",
    ]);
  });

  it("maps a jobicy search, formatting pay with the period it states", async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(fixture("jobicy-jobs")),
    );

    const jobs = await jobicyAdapter.fetchJobs({
      query: "marketing",
      limit: 100,
      fetchImpl,
    });

    const requested = new URL(calls[0]?.url ?? "");
    expect(requested.searchParams.get("tag")).toBe("marketing");
    // Their documented ceiling, not the caller's page size.
    expect(requested.searchParams.get("count")).toBe("50");
    expect(requested.searchParams.has("geo")).toBe(false);

    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toEqual({
      source: "jobicy",
      sourceJobId: "153180",
      title: "Senior Product Marketing Manager",
      company: "Teramind",
      location: "USA",
      isRemote: true,
      url: "https://jobicy.com/jobs/153180-senior-product-marketing-manager-5",
      applyUrl: null,
      descriptionText:
        "The Role You'll own how Teramind is positioned, packaged, and sold. This is a senior, hands-on role at the center of our GTM engine.",
      salaryText: "USD 160,000–200,000/yr",
      postedAt: "2026-09-13T11:56:44.000Z",
    });
    // The wire writes "LATAM,  Canada,  USA" with doubled separators.
    expect(jobs[2]?.location).toBe("LATAM · Canada · USA");
    expect(jobs[1]?.salaryText).toBeNull();
  });

  it("sends jobicy a geo slug it accepts and never one it would reject", async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(fixture("jobicy-jobs")),
    );
    const notes: string[] = [];

    await jobicyAdapter.fetchJobs({
      location: "Berlin, Germany",
      limit: 25,
      fetchImpl,
      notes,
    });
    // An unknown slug is a hard 400 that would take the whole source down, so
    // a city the board cannot express resolves to its country or to nothing.
    expect(new URL(calls[0]?.url ?? "").searchParams.get("geo")).toBe(
      "germany",
    );
    expect(notes).toEqual([
      'location "Berlin, Germany" applied upstream as geo=germany',
    ]);

    const local: string[] = [];
    const jobs = await jobicyAdapter.fetchJobs({
      location: "New York, NY",
      limit: 25,
      fetchImpl,
      notes: local,
    });
    expect(new URL(calls[1]?.url ?? "").searchParams.has("geo")).toBe(false);
    expect(jobs).toEqual([]);
    expect(local[0]).toContain("no geo slug for that place");
  });

  it("maps a himalayas page, qualifying its id and its residence restriction", async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse({
        ...(fixture("himalayas-jobs") as object),
        nextCursor: null,
      }),
    );

    const jobs = await himalayasAdapter.fetchJobs({ limit: 20, fetchImpl });

    expect(new URL(calls[0]?.url ?? "").searchParams.get("limit")).toBe("20");
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toEqual({
      source: "himalayas",
      // The payload carries no id at all, and a bare slug repeats across
      // companies, so the company qualifies it.
      sourceJobId: "dickssportinggoods/senior-software-engineer-supply-chain",
      title: "Senior Software Engineer - Supply Chain",
      company: "DICK'S Sporting Goods",
      location: "United States",
      isRemote: true,
      url: "https://himalayas.app/companies/dickssportinggoods/jobs/senior-software-engineer-supply-chain",
      // Same link twice on the wire, so there is no separate apply target.
      applyUrl: null,
      descriptionText:
        "At DICK’S Sporting Goods, we believe in how positively sports can change lives. You will build and operate the services behind our supply chain platform, working in Java and Kubernetes.",
      salaryText: "USD 83,000–138,200/yr",
      postedAt: "2026-09-13T19:26:58.000Z",
    });
    // An hourly rate collapsed to one figure, carrying its period: without it
    // a 16 reads as an annual salary to the scoring pass.
    expect(jobs[1]?.salaryText).toBe("USD 16/hr");
    // Salary period is populated even when the posting states no figures.
    expect(jobs[2]?.salaryText).toBeNull();
  });

  it("walks the himalayas cursor for a keyword the board cannot search", async () => {
    const page = fixture("himalayas-jobs") as { jobs: unknown[] };
    const { fetchImpl, calls } = makeFetch((url) =>
      jsonResponse(
        url.includes("cursor=second")
          ? { jobs: page.jobs, nextCursor: null }
          : { jobs: page.jobs, nextCursor: "second" },
      ),
    );
    const notes: string[] = [];

    const jobs = await himalayasAdapter.fetchJobs({
      query: "kubernetes",
      limit: 20,
      fetchImpl,
      notes,
    });

    // Two requests, the second echoing the cursor the first handed back, and
    // it stops there because that page reported no further cursor.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain("cursor=second");
    // The same posting arrived twice across the two pages; a duplicate url is
    // a duplicate row downstream, so only one survives.
    expect(jobs.map((job) => job.title)).toEqual([
      "Senior Software Engineer - Supply Chain",
    ]);
    expect(notes[0]).toContain('query "kubernetes" was applied locally');
  });

  it("maps a muse page, folding its location list and reading remote from it", async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(fixture("themuse-jobs")),
    );

    const jobs = await themuseAdapter.fetchJobs({ limit: 25, fetchImpl });

    // `page` is required and zero-based; omitting it is a 400.
    expect(new URL(calls[0]?.url ?? "").searchParams.get("page")).toBe("0");
    // `page_count` is 1, so the walk stops without a speculative second page.
    expect(calls).toHaveLength(1);

    // The Bank of America row has an empty `refs`, and `landing_page` is the
    // only absolute url the payload carries.
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toEqual({
      source: "themuse",
      sourceJobId: "22049518",
      title: "Senior Backend Engineer, Growth (US)",
      company: "Nanit",
      location: "New York, NY",
      isRemote: false,
      url: "https://www.themuse.com/jobs/nanit/senior-backend-engineer-growth-us",
      applyUrl: null,
      descriptionText:
        "Nanit is moving families beyond overwhelm by transforming how parents understand their baby's early years. You will own the growth backend: Node services, Postgres and the experimentation platform.",
      salaryText: null,
      postedAt: "2026-08-17T18:29:15.000Z",
    });
    // Five locations, one of which is their spelling of remote work — the only
    // place a work mode appears in this payload.
    expect(jobs[1]?.location).toBe(
      "El Segundo, CA · Flexible / Remote · Lockhart, TX · New York, NY · Redmond, WA",
    );
    expect(jobs[1]?.isRemote).toBe(true);
  });

  it("asks the muse for remote work by place, since it has no work-mode field", async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(fixture("themuse-jobs")),
    );
    const notes: string[] = [];

    const jobs = await themuseAdapter.fetchJobs({
      query: "starlink",
      remote: true,
      limit: 25,
      fetchImpl,
      notes,
    });

    expect(
      new URL(calls[0]?.url ?? "").searchParams.getAll("location"),
    ).toEqual(["Flexible / Remote"]);
    // No keyword parameter exists at all, so the query is ours to apply.
    expect(jobs.map((job) => job.title)).toEqual([
      "Manager, Starlink Enterprise Sales",
    ]);
    expect(notes[0]).toContain("no keyword parameter");
  });

  it("maps arbeitnow, trusting its own remote flag over German place names", async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(fixture("arbeitnow-jobs")),
    );

    const jobs = await arbeitnowAdapter.fetchJobs({ limit: 25, fetchImpl });

    expect(calls[0]?.url).toBe(
      "https://www.arbeitnow.com/api/job-board-api?page=1",
    );
    // An unfiltered request never pays for a second page.
    expect(calls).toHaveLength(1);

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toEqual({
      source: "arbeitnow",
      sourceJobId: "director-ai-automation-onemedia-germany-munich-249102",
      title: "Director AI & Automation",
      company: "Onemedia Consulting",
      location: "Onemedia Germany, Munich",
      isRemote: false,
      url: "https://www.arbeitnow.com/jobs/companies/onemedia-consulting/director-ai-automation-onemedia-germany-munich-249102",
      applyUrl: null,
      descriptionText:
        "We are looking for a Director AI & Automation to own our technology strategy and architect automation across the agency.",
      // The feed carries no pay field of any kind.
      salaryText: null,
      // Epoch seconds, not milliseconds.
      postedAt: "2026-09-13T20:09:55.000Z",
    });
    // "Homeoffice" is not a word the English remote-hint pattern knows, so the
    // board's own boolean is the only reliable signal here.
    expect(jobs[1]?.isRemote).toBe(true);
    expect(jobs[1]?.descriptionText).toContain("Kubernetes-Cluster");
  });

  it("walks arbeitnow pages for a local keyword and stops on an empty one", async () => {
    const { fetchImpl, calls } = makeFetch((url) =>
      jsonResponse(
        url.endsWith("page=1") ? fixture("arbeitnow-jobs") : { data: [] },
      ),
    );
    const notes: string[] = [];

    const jobs = await arbeitnowAdapter.fetchJobs({
      query: "kubernetes",
      limit: 25,
      fetchImpl,
      notes,
    });

    // Page two is empty, which is the end of the feed rather than a thin page,
    // so the walk stops instead of spending its remaining budget.
    expect(calls.map((call) => call.url)).toEqual([
      "https://www.arbeitnow.com/api/job-board-api?page=1",
      "https://www.arbeitnow.com/api/job-board-api?page=2",
    ]);
    expect(jobs.map((job) => job.company)).toEqual(["virtual7 GmbH"]);
    expect(notes[0]).toContain('keyword "kubernetes"');
  });

  it("registers nine sources, six of them usable without a company token", () => {
    expect(Object.keys(SOURCE_ADAPTERS).sort()).toEqual([
      "arbeitnow",
      "ashby",
      "freehire",
      "greenhouse",
      "himalayas",
      "jobicy",
      "lever",
      "remotive",
      "themuse",
    ]);
    // The three ATS boards publish one company each, so a keyword-first
    // discovery can only reach the other six. That count is the point of the
    // set: with one keyless source, a search had a single opinion.
    expect(
      listSourceAdapters().filter((adapter) => adapter.needsBoardToken),
    ).toHaveLength(3);
    expect(
      listSourceAdapters().filter((adapter) => !adapter.needsBoardToken),
    ).toHaveLength(6);
  });
});

describe("htmlToText", () => {
  it("strips tags, decodes entities and collapses whitespace", () => {
    expect(
      htmlToText(
        "<p>Alpha&nbsp;beta</p>\n  <p>Gamma</p>Tom &amp; Jerry &lt; 5 &#39;quoted&#39;<br>next",
      ),
    ).toBe("Alpha beta Gamma Tom & Jerry < 5 'quoted' next");
  });

  it("keeps a word boundary across block tags but not inline ones", () => {
    expect(htmlToText("experience.</p><p>You will")).toBe(
      "experience. You will",
    );
    expect(htmlToText("one<br>two")).toBe("one two");
    expect(htmlToText("a<br/>b")).toBe("a b");
    // An inline tag inside a sentence must not leave a space before the stop.
    expect(htmlToText("<strong>Engineer</strong>.")).toBe("Engineer.");
  });

  it("decodes markup that survived JSON encoding, and drops script bodies", () => {
    expect(htmlToText("&lt;p&gt;A&lt;/p&gt;&lt;p&gt;B&lt;/p&gt;")).toBe("A B");
    expect(htmlToText("<script>alert('x')</script>Hi")).toBe("Hi");
  });

  it("leaves prose that merely mentions angle brackets intact", () => {
    // The unconditional double-decode this replaces turned `&lt; 50ms &gt;`
    // into a tag and ate the text between them.
    expect(htmlToText("keep p99 &lt; 50ms &gt; always")).toBe(
      "keep p99 < 50ms > always",
    );
    // A bare `<` that starts no tag is prose. A `<[^>]+>` stripper eats
    // everything up to the next `>` and reports "Salary 50k".
    expect(htmlToText("Salary < 100k and > 50k")).toBe(
      "Salary < 100k and > 50k",
    );
    expect(htmlToText("I <3 this <b>role</b>")).toBe("I <3 this role");
  });

  it("returns an empty string for a missing body", () => {
    expect(htmlToText(undefined)).toBe("");
    expect(htmlToText(null)).toBe("");
  });
});

describe("toIsoOrNull", () => {
  it("reads a zoneless board timestamp as UTC, not as host-local time", () => {
    // Remotive publishes "2026-09-11T20:16:48" with no offset. `Date.parse`
    // treats a zoneless date-*time* as local, so before this was pinned the
    // same recorded payload produced a different postedAt on every machine —
    // and a different calendar day on any host west of Greenwich.
    expect(toIsoOrNull("2026-09-11T20:16:48")).toBe("2026-09-11T20:16:48.000Z");
    expect(toIsoOrNull("2026-09-11 20:16")).toBe("2026-09-11T20:16:00.000Z");
    // A stated offset is still honoured — it is data, unlike the host's.
    expect(toIsoOrNull("2026-09-11T20:16:48+02:00")).toBe(
      "2026-09-11T18:16:48.000Z",
    );
  });

  it("tells epoch seconds from milliseconds", () => {
    expect(toIsoOrNull(1789330195)).toBe("2026-09-13T20:09:55.000Z");
    expect(toIsoOrNull(1789330195000)).toBe("2026-09-13T20:09:55.000Z");
    expect(toIsoOrNull(0)).toBeNull();
    expect(toIsoOrNull("not a date")).toBeNull();
  });
});

describe("joinLocations", () => {
  it("drops a fragment whose segments are already covered", () => {
    // Boards hand back overlapping views of one place. Concatenating them
    // blindly rendered "Calgary, Canada · Calgary · CA" in the dashboard.
    expect(joinLocations(["Calgary, Canada", "Calgary"])).toBe(
      "Calgary, Canada",
    );
    expect(joinLocations(["Calgary", "Calgary, Canada"])).toBe(
      "Calgary · Calgary, Canada",
    );
  });

  it("keeps genuinely distinct places", () => {
    expect(joinLocations(["Berlin, Germany", "Lisbon, Portugal"])).toBe(
      "Berlin, Germany · Lisbon, Portugal",
    );
  });

  it("is case-insensitive and skips blanks", () => {
    expect(joinLocations(["Remote - US", "remote - us", null, "  "])).toBe(
      "Remote - US",
    );
  });

  it("returns null when nothing usable survives", () => {
    expect(joinLocations([null, undefined, "", " , "])).toBeNull();
  });
});

describe("stripCompanyFromTitle", () => {
  it("removes a trailing company name behind any common separator", () => {
    for (const separator of [" at ", " @ ", " - ", " — ", ", "]) {
      expect(
        stripCompanyFromTitle(`Senior Engineer${separator}RBC`, "RBC"),
      ).toBe("Senior Engineer");
    }
  });

  it("matches the company case-insensitively", () => {
    expect(
      stripCompanyFromTitle("Data Engineer at ACME Corp", "acme corp"),
    ).toBe("Data Engineer");
  });

  it("leaves a title whose tail is not the company", () => {
    // "Scale" here is part of the role, not the employer, so it stays.
    expect(stripCompanyFromTitle("Engineer at Scale", "Stripe")).toBe(
      "Engineer at Scale",
    );
    expect(stripCompanyFromTitle("Engineer, Payments", "Stripe")).toBe(
      "Engineer, Payments",
    );
  });

  it("never empties a title that is only the company name", () => {
    // Removing everything would leave a row with no title at all.
    expect(stripCompanyFromTitle("RBC", "RBC")).toBe("RBC");
  });

  it("strips only the trailing occurrence", () => {
    expect(
      stripCompanyFromTitle("Stripe Platform Engineer at Stripe", "Stripe"),
    ).toBe("Stripe Platform Engineer");
  });
});

describe("SSRF guards", () => {
  it("rejects a traversing or URL-shaped board token before any request", async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ jobs: [] }));

    for (const board of ["../evil", "http://x"]) {
      for (const adapter of [greenhouseAdapter, ashbyAdapter, leverAdapter]) {
        await expect(
          adapter.fetchJobs({ board, limit: 5, fetchImpl }),
        ).rejects.toMatchObject({
          name: "AppError",
          code: "INVALID_REQUEST",
          status: 400,
        });
      }
    }

    expect(calls).toHaveLength(0);
  });

  it("refuses a host that is not on the adapter's allowlist", async () => {
    // A self-hosting override is exactly the half-trusted input that turns a
    // configuration knob into an SSRF primitive.
    vi.stubEnv("FREEHIRE_API_URL", "https://freehire.me.attacker.example");
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ data: [] }));

    await expect(
      freehireAdapter.fetchJobs({ query: "engineer", limit: 5, fetchImpl }),
    ).rejects.toMatchObject({
      name: "AppError",
      code: "FORBIDDEN",
      status: 403,
    });
    expect(calls).toHaveLength(0);
  });

  it("matches allowlisted hosts exactly and requires https", () => {
    const allowed = { "boards-api.greenhouse.io": true } as const;

    expect(
      assertAllowedUrl(
        "https://boards-api.greenhouse.io/v1/boards/x/jobs",
        allowed,
        "t",
      ),
    ).toBe("https://boards-api.greenhouse.io/v1/boards/x/jobs");
    // A suffix match would accept this; an exact table does not.
    expect(() =>
      assertAllowedUrl(
        "https://boards-api.greenhouse.io.attacker.test/v1",
        allowed,
        "t",
      ),
    ).toThrow(/refused host/);
    expect(() =>
      assertAllowedUrl("http://boards-api.greenhouse.io/v1", allowed, "t"),
    ).toThrow(/non-HTTPS/);
    expect(() =>
      assertAllowedUrl("http://169.254.169.254/latest/meta-data", allowed, "t"),
    ).toThrow(/refused/);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });
});

describe("ingestJobs", () => {
  let dir: string;
  let db: Db;
  let repos: RepoBundle;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "command-center-ingest-"));
    db = openDatabase(join(dir, "ingest.db"));
    repos = createRepos(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists healthy sources and reports the failing one", async () => {
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes("api.lever.co"))
        return jsonResponse({ message: "not found" }, 404);
      if (url.includes("greenhouse"))
        return jsonResponse(fixture("greenhouse-jobs"));
      return jsonResponse(fixture("freehire-search"));
    });

    const result = await ingestJobs({
      sources: [
        { id: "greenhouse", board: "northwindlabs" },
        { id: "lever", board: "orbitalworks" },
        { id: "freehire", query: "platform engineer" },
        { id: "monster", query: "anything" },
      ],
      repos,
      fetchImpl,
    });

    expect(result.bySource).toEqual([
      { id: "greenhouse", fetched: 2 },
      { id: "lever", fetched: 0, error: "lever: HTTP 404" },
      { id: "freehire", fetched: 2 },
      { id: "monster", fetched: 0, error: 'unknown source "monster"' },
    ]);
    expect(result.inserted).toBe(4);
    expect(result.updated).toBe(0);

    const stored = repos.jobs.list();
    expect(stored).toHaveLength(4);
    expect(stored.map((job) => job.source).sort()).toEqual([
      "freehire",
      "freehire",
      "greenhouse",
      "greenhouse",
    ]);
  });

  it("collapses duplicate urls within one batch to a single row", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(fixture("greenhouse-jobs")),
    );

    const result = await ingestJobs({
      // Two boards mirroring the same postings — the aggregator/ATS overlap.
      sources: [
        { id: "greenhouse", board: "northwindlabs" },
        { id: "greenhouse", board: "northwind-mirror" },
      ],
      repos,
      fetchImpl,
    });

    expect(result.bySource).toEqual([
      { id: "greenhouse", fetched: 2 },
      { id: "greenhouse", fetched: 2 },
    ]);
    expect(result.inserted).toBe(2);
    expect(result.updated).toBe(0);
    expect(repos.jobs.list()).toHaveLength(2);
    // First source in the caller's list wins: the second fixture posting has
    // no company_name, so it carries the FIRST board's humanized token and
    // never "Northwind Mirror".
    expect(
      repos.jobs
        .list()
        .map((job) => job.company)
        .sort(),
    ).toEqual(["Northwind Labs", "Northwindlabs"]);
  });

  it("re-ingesting the same board updates rather than duplicating", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(fixture("greenhouse-jobs")),
    );
    const sources = [{ id: "greenhouse", board: "northwindlabs" }];

    await ingestJobs({ sources, repos, fetchImpl });
    const second = await ingestJobs({ sources, repos, fetchImpl });

    expect(second).toMatchObject({ inserted: 0, updated: 2 });
    expect(repos.jobs.list()).toHaveLength(2);
  });

  it("never runs more than five sources at once", async () => {
    // Fake timers, not a real sleep: each stubbed request parks on the clock
    // so overlap is observable, and the test drives that clock rather than
    // waiting on it.
    vi.useFakeTimers();
    let inFlight = 0;
    let peak = 0;
    const { fetchImpl, calls } = makeFetch(async (url) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Executor form: `Promise.withResolvers` needs lib ES2024 and this
      // project targets ES2023.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
      inFlight -= 1;
      return jsonResponse(url.includes("api.lever.co") ? [] : { jobs: [] });
    });

    const run = ingestJobs({
      sources: [
        { id: "greenhouse", board: "alpha" },
        { id: "greenhouse", board: "bravo" },
        { id: "ashby", board: "charlie" },
        { id: "ashby", board: "delta" },
        { id: "lever", board: "echo" },
        { id: "lever", board: "foxtrot" },
        { id: "greenhouse", board: "golf" },
      ],
      repos,
      fetchImpl,
    });

    // Comfortably past seven 5ms requests however they are scheduled — a
    // sequential implementation finishes inside this window too, and fails on
    // the peak assertion rather than on a timeout.
    await vi.advanceTimersByTimeAsync(200);
    const result = await run;

    expect(calls).toHaveLength(7);
    expect(peak).toBe(5);
    expect(result.bySource).toHaveLength(7);
    expect(result.bySource.every((report) => report.error === undefined)).toBe(
      true,
    );
  });
});

/**
 * The aggregator's geography vocabulary, as measured against the live service:
 * `cities` and `countries` are two views of one OR-ed dimension, a value
 * outside the vocabulary returns zero rows rather than an error, and
 * `meta.ignored_params` names any parameter the service did not use.
 */
describe("freehire location", () => {
  const searchPayload = (locations: string[]) => ({
    data: locations.map((location, index) => ({
      public_slug: `job-${index}`,
      url: `https://boards.example.com/job-${index}`,
      title: "Platform Engineer",
      company: "Acme",
      location,
    })),
  });

  it("asks the board for the city, not just the keyword", async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(searchPayload(["Toronto, Canada"])),
    );

    await freehireAdapter.fetchJobs({
      query: "platform engineer",
      location: "Toronto",
      limit: 25,
      fetchImpl,
    });

    const requested = new URL(calls[0]?.url ?? "");
    expect(requested.searchParams.getAll("cities")).toEqual(["toronto"]);
    expect(requested.searchParams.get("q")).toBe("platform engineer");
    expect(calls).toHaveLength(1);
  });

  it("sends a country as the ISO code the board accepts, and only one geography tier", async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(searchPayload(["Toronto, Canada"])),
    );

    await freehireAdapter.fetchJobs({
      location: "Canada",
      limit: 5,
      fetchImpl,
    });
    // `countries=canada` returns zero rows upstream where `countries=ca`
    // returns fifteen thousand.
    expect(
      new URL(calls[0]?.url ?? "").searchParams.getAll("countries"),
    ).toEqual(["ca"]);

    await freehireAdapter.fetchJobs({
      location: "Toronto, Canada",
      limit: 5,
      fetchImpl,
    });
    // The dimension is OR-ed, so adding the country would widen the search to
    // all of Canada rather than narrow it to Toronto.
    const second = new URL(calls[1]?.url ?? "").searchParams;
    expect(second.getAll("cities")).toEqual(["toronto"]);
    expect(second.getAll("countries")).toEqual([]);
  });

  it("carries the work mode, which is a separate intersecting dimension", async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ data: [] }));

    await freehireAdapter.fetchJobs({ remote: true, limit: 5, fetchImpl });
    await freehireAdapter.fetchJobs({ remote: false, limit: 5, fetchImpl });

    expect(new URL(calls[0]?.url ?? "").searchParams.get("work_mode")).toBe(
      "remote",
    );
    expect(new URL(calls[1]?.url ?? "").searchParams.get("work_mode")).toBe(
      "onsite",
    );
  });

  it("filters locally and says so when the board ignored the parameter", async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse({
        ...searchPayload(["Toronto, Canada", "Berlin, Germany", "Houston, TX"]),
        meta: { ignored_params: [{ param: "cities" }] },
      }),
    );
    const notes: string[] = [];

    const jobs = await freehireAdapter.fetchJobs({
      location: "Toronto",
      limit: 25,
      fetchImpl,
      notes,
    });

    // The board handed back the unfiltered set, so the rows have to be cut here
    // rather than passed off as a filtered result.
    expect(jobs.map((job) => job.location)).toEqual(["Toronto, Canada"]);
    expect(calls).toHaveLength(1);
    expect(notes).toEqual([
      'freehire ignored cities; filtered 3 rows locally to 1 for "Toronto"',
    ]);
  });

  it("re-asks unfiltered when a filtered request comes back empty", async () => {
    // A value outside the board's city index is a silent zero, which is
    // indistinguishable from "no such job" unless we go and check.
    const { fetchImpl, calls } = makeFetch((url) =>
      jsonResponse(
        new URL(url).searchParams.has("cities")
          ? { data: [] }
          : searchPayload(["Kelowna, Canada", "Houston, TX"]),
      ),
    );
    const notes: string[] = [];

    const jobs = await freehireAdapter.fetchJobs({
      location: "Kelowna",
      limit: 25,
      fetchImpl,
      notes,
    });

    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]?.url ?? "").searchParams.has("cities")).toBe(false);
    expect(jobs.map((job) => job.location)).toEqual(["Kelowna, Canada"]);
    expect(notes).toEqual([
      'freehire returned no rows for cities=kelowna; filtered 2 rows locally to 1 for "Kelowna"',
    ]);
  });

  it("trusts the city index with a multi-word place, because it serves them", async () => {
    // `cities=greater+toronto+area` really does return rows upstream. A shape
    // guard here would suppress a filter the board can serve.
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(searchPayload(["Greater Toronto Area, Canada"])),
    );
    const notes: string[] = [];

    const jobs = await freehireAdapter.fetchJobs({
      location: "Greater Toronto Area",
      limit: 25,
      fetchImpl,
      notes,
    });

    expect(new URL(calls[0]?.url ?? "").searchParams.getAll("cities")).toEqual([
      "greater toronto area",
    ]);
    expect(jobs).toHaveLength(1);
    expect(notes).toEqual([
      'location "Greater Toronto Area" applied upstream as cities=greater toronto area',
    ]);
  });

  it("applies place text that is only a work mode itself", async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse(searchPayload(["Remote - US", "Toronto, Canada"])),
    );
    const notes: string[] = [];

    const jobs = await freehireAdapter.fetchJobs({
      location: "Remote",
      limit: 25,
      fetchImpl,
      notes,
    });

    // `work_mode` travels, but no geography does, so the place is ours to apply.
    const requested = new URL(calls[0]?.url ?? "").searchParams;
    expect(requested.get("work_mode")).toBe("remote");
    expect(requested.getAll("cities")).toEqual([]);
    expect(jobs.map((job) => job.location)).toEqual(["Remote - US"]);
    expect(notes).toEqual([
      'freehire has no place parameter for that text; filtered 2 rows locally to 1 for "Remote"',
    ]);
  });

  it("says the filter was applied upstream when it was", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(searchPayload(["Toronto, Canada"])),
    );
    const notes: string[] = [];

    await freehireAdapter.fetchJobs({
      location: "Toronto",
      limit: 25,
      fetchImpl,
      notes,
    });

    expect(notes).toEqual([
      'location "Toronto" applied upstream as cities=toronto',
    ]);
  });
});
