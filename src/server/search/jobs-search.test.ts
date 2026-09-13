import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job, JobSearchQuery, JobTag, NewJob } from "@domain";
import { type Db, openDatabase } from "@server/db";
import { AppError } from "@server/infra/errors";
import { createRepos, type RepoBundle } from "@server/repos";
import { searchJobs } from "@server/search/jobs-search";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
let db: Db;
let repos: RepoBundle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "command-center-search-"));
  db = openDatabase(join(dir, "t.db"));
  repos = createRepos(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;

function seed(overrides: Partial<NewJob> = {}): Job {
  seq += 1;
  const url = overrides.url ?? `https://boards.example.com/job-${seq}`;
  repos.jobs.upsertMany([
    {
      source: "greenhouse",
      sourceJobId: null,
      title: `Engineer ${seq}`,
      company: "Acme",
      location: "Remote",
      isRemote: true,
      applyUrl: null,
      descriptionText: "",
      salaryText: null,
      postedAt: null,
      ...overrides,
      url,
    },
  ]);
  const job = repos.jobs.getByUrl(url);
  if (!job) throw new Error(`seed failed for ${url}`);
  return job;
}

function search(query: JobSearchQuery = {}) {
  return searchJobs(repos, query);
}

const titles = (query: JobSearchQuery = {}) =>
  search(query).jobs.map((job) => job.title);

describe("free text", () => {
  it("requires every term but does not care about order or case", () => {
    seed({ title: "Staff Backend Engineer", company: "Stripe" });
    seed({ title: "Frontend Engineer", company: "Acme" });

    expect(titles({ q: "backend STAFF" })).toEqual(["Staff Backend Engineer"]);
    expect(titles({ q: "engineer stripe" })).toEqual([
      "Staff Backend Engineer",
    ]);
    expect(titles({ q: "backend frontend" })).toEqual([]);
  });

  it("matches a quoted phrase as one unit", () => {
    seed({ title: "Site Reliability Engineer", company: "Acme" });
    seed({
      title: "Engineer, Reliability Platform",
      company: "Site Services",
      url: "https://boards.example.com/other",
    });

    expect(titles({ q: '"site reliability"' })).toEqual([
      "Site Reliability Engineer",
    ]);
    expect(titles({ q: "site reliability" })).toHaveLength(2);
  });

  it("treats % and _ as characters the candidate typed, not wildcards", () => {
    // A LIKE pattern built by concatenation turns "100%" into "match anything",
    // which silently returns the whole corpus as though it were a hit.
    seed({
      title: "Growth Engineer",
      descriptionText: "We grew 100% last year.",
    });
    seed({
      title: "Platform Engineer",
      descriptionText: "Steady growth.",
      url: "https://boards.example.com/platform",
    });
    seed({
      title: "Data Engineer",
      descriptionText: "Owns the back_end pipeline.",
      url: "https://boards.example.com/data",
    });

    expect(titles({ q: "100%" })).toEqual(["Growth Engineer"]);
    expect(titles({ q: "back_end" })).toEqual(["Data Engineer"]);
    // "_" must not stand in for an arbitrary character.
    expect(titles({ q: "back_nd" })).toEqual([]);
    expect(titles({ q: "%" })).toEqual(["Growth Engineer"]);
  });

  it("subtracts a term the candidate prefixed with a minus", () => {
    seed({
      title: "Backend Engineer",
      descriptionText: "Permanent role on the payments team.",
    });
    seed({
      title: "Backend Engineer",
      descriptionText: "Contract role via our agency.",
      url: "https://boards.example.com/agency",
    });

    expect(titles({ q: "backend" })).toHaveLength(2);
    expect(titles({ q: "backend -agency" })).toEqual(["Backend Engineer"]);
    // The exclusion is not a term to also match: a posting that says neither
    // is still a hit on what was asked for.
    expect(titles({ q: "-agency" })).toEqual(["Backend Engineer"]);
  });

  it("excludes a quoted phrase as one unit", () => {
    seed({
      title: "Security Engineer",
      descriptionText: "Requires an active security clearance.",
    });
    seed({
      title: "Platform Engineer",
      descriptionText: "Security-minded, no clearance needed.",
      url: "https://boards.example.com/platform",
    });

    expect(titles({ q: '-"security clearance"' })).toEqual([
      "Platform Engineer",
    ]);
    // Splitting the phrase would drop both rows, since each says "security".
    expect(titles({ q: "-security -clearance" })).toEqual([]);
  });
});

describe("experience years", () => {
  it("matches by overlap, so a 3-6 year posting answers a 5-10 year search", () => {
    seed({
      title: "Backend Engineer",
      descriptionText: "3-6 years of experience required.",
    });
    seed({
      title: "Principal Engineer",
      descriptionText: "12+ years of experience required.",
      url: "https://boards.example.com/principal",
    });
    seed({
      title: "Graduate Engineer",
      descriptionText: "0-1 years of experience.",
      url: "https://boards.example.com/grad",
    });

    expect(titles({ minYears: 5, maxYears: 10 }).sort()).toEqual([
      "Backend Engineer",
    ]);
    expect(titles({ minYears: 11, maxYears: 20 })).toEqual([
      "Principal Engineer",
    ]);
    // An open-ended posting keeps matching above its floor.
    expect(titles({ minYears: 30 })).toEqual(["Principal Engineer"]);
  });

  it("keeps unparseable postings visible until the candidate asks about years", () => {
    seed({ title: "Mystery Engineer", descriptionText: "Come build with us." });
    seed({
      title: "Senior Engineer",
      descriptionText: "5+ years of experience.",
      url: "https://boards.example.com/senior",
    });

    expect(titles().sort()).toEqual(["Mystery Engineer", "Senior Engineer"]);
    // Asking about years excludes the posting whose range is unknown: claiming
    // it fits would be an answer nobody has.
    expect(titles({ minYears: 0, maxYears: 40 })).toEqual(["Senior Engineer"]);
    expect(titles({ minYears: 0 })).toEqual(["Senior Engineer"]);
  });
});

describe("sorting", () => {
  it("ranks unscored postings after every scored one instead of as zero", () => {
    const unscored = seed({ title: "Unscored" });
    const low = seed({ title: "Low", url: "https://boards.example.com/low" });
    const high = seed({
      title: "High",
      url: "https://boards.example.com/high",
    });
    repos.jobs.update(low.id, { score: 4 });
    repos.jobs.update(high.id, { score: 91 });
    expect(repos.jobs.get(unscored.id)?.score).toBeNull();

    expect(titles({ sort: "score" })).toEqual(["High", "Low", "Unscored"]);
  });

  it("ranks postings with no stated salary last", () => {
    seed({ title: "Unstated", salaryText: null });
    seed({
      title: "Vague",
      salaryText: "Competitive",
      url: "https://boards.example.com/vague",
    });
    seed({
      title: "Mid",
      salaryText: "$150,000 - $170,000",
      url: "https://boards.example.com/mid",
    });
    seed({
      title: "Top",
      salaryText: "$220k",
      url: "https://boards.example.com/top",
    });

    expect(titles({ sort: "salary" }).slice(0, 2)).toEqual(["Top", "Mid"]);
    expect(titles({ sort: "salary" }).slice(2).sort()).toEqual([
      "Unstated",
      "Vague",
    ]);
  });

  it("puts a title hit above a body mention when sorting by relevance", () => {
    seed({ title: "Kafka Engineer", descriptionText: "Streaming systems." });
    seed({
      title: "Backend Engineer",
      descriptionText: "Some kafka experience helps.",
      url: "https://boards.example.com/backend",
    });

    expect(titles({ q: "kafka", sort: "relevance" })).toEqual([
      "Kafka Engineer",
      "Backend Engineer",
    ]);
  });
});

describe("result envelope", () => {
  it("reports the full match count regardless of the page size", () => {
    for (let i = 0; i < 5; i += 1) {
      seed({ title: `Rust Engineer ${i}`, url: `https://x.example.com/${i}` });
    }

    const page = search({ q: "rust", limit: 2 });
    expect(page.jobs).toHaveLength(2);
    expect(page.total).toBe(5);
    expect(page.limit).toBe(2);

    const second = search({ q: "rust", limit: 2, offset: 2 });
    expect(second.total).toBe(5);
    expect(second.jobs.map((job) => job.title)).not.toEqual(
      page.jobs.map((job) => job.title),
    );
  });

  it("clamps an absurd page size instead of serving it", () => {
    seed();
    expect(search({ limit: 5000 }).limit).toBe(100);
    expect(search({}).limit).toBe(25);
  });

  it("rejects a negative offset by name rather than paging from nowhere", () => {
    seed();
    try {
      search({ offset: -1 });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).status).toBe(400);
      expect((error as AppError).message).toContain("offset");
    }
  });
});

describe("facets", () => {
  beforeEach(() => {
    seed({ source: "greenhouse", title: "A", company: "Acme" });
    seed({
      source: "greenhouse",
      title: "B",
      company: "Acme",
      url: "https://boards.example.com/b",
    });
    seed({
      source: "lever",
      title: "C",
      company: "Beta",
      url: "https://boards.example.com/c",
    });
  });

  it("counts a facet as though its own filter were not applied", () => {
    const filtered = search({ sources: ["greenhouse"] });

    expect(filtered.total).toBe(2);
    // The source facet still reports lever, so the candidate can see what
    // switching to it would give them.
    expect(filtered.facets.sources).toEqual([
      { value: "greenhouse", count: 2 },
      { value: "lever", count: 1 },
    ]);
  });

  it("keeps every other filter in the facet counts", () => {
    const filtered = search({ q: "acme", sources: ["lever"] });

    expect(filtered.total).toBe(0);
    // Free text still applies, so lever's posting at Beta is not counted.
    expect(filtered.facets.sources).toEqual([
      { value: "greenhouse", count: 2 },
    ]);
  });

  it("reports every status even when the corpus has none of them", () => {
    const statuses = search().facets.statuses;

    expect(statuses.map((entry) => entry.value)).toEqual([
      "discovered",
      "screened",
      "ready",
      "applied",
      "closed",
    ]);
    expect(statuses.find((entry) => entry.value === "discovered")?.count).toBe(
      3,
    );
    expect(statuses.find((entry) => entry.value === "applied")?.count).toBe(0);
  });

  it("counts remote, onsite and unstated separately", () => {
    seed({
      title: "Onsite",
      isRemote: false,
      url: "https://boards.example.com/onsite",
    });
    seed({
      title: "Unknown",
      isRemote: null,
      url: "https://boards.example.com/unknown",
    });

    const filtered = search({ remote: true });
    expect(filtered.total).toBe(3);
    expect(filtered.facets.remote).toEqual({
      remote: 3,
      onsite: 1,
      unknown: 1,
    });
  });

  it("promises exactly what selecting the facet delivers", () => {
    // The facet predicate and the filter predicate are written separately, so
    // a count that does not match its own selection is the bug this catches.
    seed({
      title: "Junior",
      descriptionText: "1-2 years of experience.",
      url: "https://boards.example.com/junior",
    });
    seed({
      title: "Mid",
      descriptionText: "4-6 years of experience.",
      url: "https://boards.example.com/mid",
    });
    seed({
      title: "Veteran",
      descriptionText: "12+ years of experience.",
      url: "https://boards.example.com/veteran",
    });

    for (const bucket of search().facets.experience) {
      const selected = search({
        minYears: bucket.minYears,
        ...(bucket.maxYears === null ? {} : { maxYears: bucket.maxYears }),
      });
      expect(selected.total, bucket.label).toBe(bucket.count);
    }

    for (const source of search().facets.sources) {
      expect(search({ sources: [source.value] }).total, source.value).toBe(
        source.count,
      );
    }
  });
});

describe("filters", () => {
  it("keeps derived columns honest when a posting is edited", () => {
    const job = seed({ title: "Engineer", descriptionText: "Nothing here." });
    expect(titles({ q: "kubernetes" })).toEqual([]);

    repos.jobs.update(job.id, {
      descriptionText: "Deep kubernetes experience, 8+ years of experience.",
    });

    expect(titles({ q: "kubernetes" })).toEqual(["Engineer"]);
    expect(titles({ minYears: 8, maxYears: 12 })).toEqual(["Engineer"]);
  });

  it("filters by posted date, falling back to discovery when a board omits it", () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    seed({ title: "Stale", postedAt: old });
    seed({
      title: "Fresh",
      postedAt: new Date().toISOString(),
      url: "https://boards.example.com/fresh",
    });
    seed({
      title: "Undated",
      postedAt: null,
      url: "https://boards.example.com/undated",
    });

    // "Undated" was discovered just now, so a recency filter keeps it.
    expect(titles({ postedWithinDays: 7 }).sort()).toEqual([
      "Fresh",
      "Undated",
    ]);
  });

  it("separates postings that state pay from those that do not", () => {
    seed({ title: "Paid", salaryText: "$200k" });
    seed({
      title: "Silent",
      salaryText: null,
      url: "https://boards.example.com/silent",
    });
    seed({
      title: "Blank",
      salaryText: "   ",
      url: "https://boards.example.com/blank",
    });

    expect(titles({ hasSalary: true })).toEqual(["Paid"]);
    expect(titles({ hasSalary: false }).sort()).toEqual(["Blank", "Silent"]);
  });

  it("measures a pay floor against the top of the published range", () => {
    // The bottom of the range is what a candidate is offered at worst; the top
    // is what the posting is selling, and it is the number a pay floor is
    // shopping against. A floor of 150k has to keep this posting.
    seed({ title: "Range", salaryText: "$120,000 - $180,000" });

    expect(titles({ minSalary: 150_000 })).toEqual(["Range"]);
    expect(titles({ minSalary: 190_000 })).toEqual([]);
  });

  it("drops pay that never parsed rather than assuming it clears the floor", () => {
    seed({ title: "Stated", salaryText: "$200,000" });
    seed({
      title: "Vague",
      salaryText: "Competitive",
      url: "https://boards.example.com/vague",
    });
    seed({
      title: "Silent",
      salaryText: null,
      url: "https://boards.example.com/silent",
    });

    // Unparsed pay is not zero pay, so it stays visible right up until the
    // candidate asks about money — then it goes, because nothing is known.
    expect(titles()).toHaveLength(3);
    expect(titles({ minSalary: 1 })).toEqual(["Stated"]);
  });

  it("annualizes an hourly rate before comparing it to the floor", () => {
    // $85/hr is $176,800 a year. Compared raw it would read as 85 and be
    // dropped by every floor a candidate would ever set.
    seed({ title: "Hourly", salaryText: "$85 / hr" });
    seed({
      title: "Salaried",
      salaryText: "$150,000",
      url: "https://boards.example.com/salaried",
    });

    expect(titles({ minSalary: 160_000 })).toEqual(["Hourly"]);
  });

  it("carries the annualized pay on the card, null rather than zero when unstated", () => {
    seed({ title: "Hourly", salaryText: "$85 / hr" });
    seed({
      title: "Vague",
      salaryText: "Competitive",
      url: "https://boards.example.com/vague",
    });

    const cards = search().jobs;

    expect(cards.find((job) => job.title === "Hourly")?.salaryAnnual).toBe(
      176_800,
    );
    expect(cards.find((job) => job.title === "Vague")?.salaryAnnual).toBeNull();
  });

  it("rejects a pay floor of zero instead of filtering on nothing", () => {
    // Zero is not a floor: it admits every posting that stated a number and
    // drops every posting that did not, which is `hasSalary` wearing a hat.
    seed({ title: "Paid", salaryText: "$200k" });
    try {
      search({ minSalary: 0 });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).status).toBe(400);
      expect((error as AppError).message).toContain("minSalary");
    }
  });
});

describe("tags", () => {
  it("tags a posting for what its own prose stated and nothing more", () => {
    seed({
      title: "Senior Python Engineer",
      descriptionText: "Django services on PostgreSQL.",
    });
    seed({
      title: "Frontend Engineer",
      descriptionText: "React and TypeScript.",
      url: "https://boards.example.com/frontend",
    });

    expect(titles({ tags: ["skill:python"] })).toEqual([
      "Senior Python Engineer",
    ]);
    expect(titles({ tags: ["skill:react"] })).toEqual(["Frontend Engineer"]);
    // Neither posting says Rust. An extractor with umbrella aliases would
    // have inferred one of them from "engineer" or from the other's stack.
    expect(titles({ tags: ["skill:rust"] })).toEqual([]);
  });

  it("widens on two skills and narrows on a skill plus a level", () => {
    seed({
      title: "Senior Backend Engineer",
      descriptionText: "Python services at scale.",
    });
    seed({
      title: "Junior Backend Engineer",
      descriptionText: "Golang services at scale.",
      url: "https://boards.example.com/junior",
    });

    expect(titles({ tags: ["skill:python", "skill:go"] }).sort()).toEqual([
      "Junior Backend Engineer",
      "Senior Backend Engineer",
    ]);
    expect(
      titles({ tags: ["skill:python", "skill:go", "level:senior"] }),
    ).toEqual(["Senior Backend Engineer"]);
  });

  it("reads a refusal to sponsor as the veto, not the invitation", () => {
    // The refusal contains the positive phrase verbatim. A leftmost-wins scan
    // would hand the candidate the exact opposite of what the posting says.
    seed({
      title: "Backend Engineer",
      descriptionText: "No visa sponsorship is available for this role.",
    });

    expect(titles({ tags: ["eligibility:no_sponsorship"] })).toEqual([
      "Backend Engineer",
    ]);
    expect(titles({ tags: ["eligibility:visa_sponsorship"] })).toEqual([]);
  });

  it("names a tag nobody defined instead of returning an empty page", () => {
    seed({ title: "Engineer", descriptionText: "Python services." });
    try {
      search({ tags: ["skill:cobol" as JobTag] });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).status).toBe(400);
      expect((error as AppError).message).toContain("skill:cobol");
    }
  });

  it("promises exactly what selecting a tag facet delivers", () => {
    seed({
      title: "Senior Python Engineer",
      descriptionText: "Django, PostgreSQL, no visa sponsorship.",
    });
    seed({
      title: "Junior Python Engineer",
      descriptionText: "Python and React.",
      url: "https://boards.example.com/junior",
    });

    const facets = search().facets.tags;
    expect(facets.length).toBeGreaterThan(0);
    for (const facet of facets) {
      expect(search({ tags: [facet.tag] }).total, facet.tag).toBe(facet.count);
    }
  });
});

describe("geography", () => {
  beforeEach(() => {
    seed({ title: "Toronto Role", location: "Toronto, Canada" });
    seed({
      title: "Vancouver Role",
      location: "Vancouver, BC, Canada",
      url: "https://boards.example.com/van",
    });
    seed({
      title: "Berlin Role",
      location: "Berlin, Germany",
      url: "https://boards.example.com/ber",
    });
    seed({
      title: "Singapore Role",
      location: "Singapore",
      url: "https://boards.example.com/sg",
    });
    seed({
      title: "Placeless Role",
      location: "Remote",
      url: "https://boards.example.com/remote",
    });
  });

  it("rolls two cities in one country into a single country row", () => {
    // The raw place facet reports Toronto and Vancouver separately, which is
    // the complaint this rollup answers.
    expect(search().facets.countries).toEqual([
      { value: "CA", count: 2 },
      { value: "DE", count: 1 },
      { value: "SG", count: 1 },
    ]);
    expect(titles({ countries: ["CA"] }).sort()).toEqual([
      "Toronto Role",
      "Vancouver Role",
    ]);
  });

  it("groups countries under a macro region", () => {
    expect(search().facets.regions).toEqual([
      { value: "north_america", count: 2 },
      { value: "emea", count: 1 },
      { value: "apac", count: 1 },
    ]);
    expect(titles({ regions: ["emea"] })).toEqual(["Berlin Role"]);
  });

  it("puts a posting that states no country in no country and no region", () => {
    // "Remote" is a work arrangement. Filing it under a guessed country would
    // make every geography filter unfalsifiable.
    expect(titles()).toHaveLength(5);
    const everywhere = titles({
      regions: ["north_america", "latam", "emea", "apac", "oceania"],
    });
    expect(everywhere).not.toContain("Placeless Role");
    expect(everywhere).toHaveLength(4);
  });

  it("narrows when a country is combined with a city", () => {
    expect(titles({ countries: ["CA"], locations: ["Vancouver"] })).toEqual([
      "Vancouver Role",
    ]);
    // The two dimensions are AND-ed, so a city outside the chosen country is
    // an empty answer rather than a widened one.
    expect(titles({ countries: ["DE"], locations: ["Vancouver"] })).toEqual([]);
  });

  it("promises exactly what selecting a country facet delivers", () => {
    for (const facet of search().facets.countries) {
      expect(search({ countries: [facet.value] }).total, facet.value).toBe(
        facet.count,
      );
    }
  });
});
