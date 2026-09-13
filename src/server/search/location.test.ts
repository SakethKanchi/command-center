import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewJob } from "@domain";
import { type Db, openDatabase } from "@server/db";
import { createRepos, type RepoBundle } from "@server/repos";
import { searchJobs } from "@server/search/jobs-search";
import {
  listKnownLocations,
  matchesLocation,
  normalizeLocation,
} from "@server/search/location";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("matchesLocation", () => {
  it("answers a city to the row that spells out its country", () => {
    expect(matchesLocation("Toronto, Canada", "toronto")).toBe(true);
    expect(matchesLocation("Toronto, Canada", "Toronto")).toBe(true);
    expect(matchesLocation("Toronto, Canada", "vancouver")).toBe(false);
  });

  it("answers a country to every row in it, however the row spells it", () => {
    for (const row of [
      "Toronto, Canada",
      "Ontario, Canada",
      "Kelowna, Canada",
      "Dartmouth, NS, Canada",
      "Toronto, ON, CA",
      "Canada",
    ]) {
      expect(matchesLocation(row, "canada"), row).toBe(true);
    }
    expect(matchesLocation("Remote - US", "canada")).toBe(false);
  });

  it("is diacritic-insensitive in both directions", () => {
    // The corpus really does carry both spellings of the same province.
    expect(matchesLocation("Québec", "Quebec")).toBe(true);
    expect(matchesLocation("Quebec", "Québec")).toBe(true);
    expect(matchesLocation("Montréal, Québec, Canada", "montreal")).toBe(true);
  });

  it("reads a country code and its name as the same place", () => {
    expect(matchesLocation("Remote - US", "united states")).toBe(true);
    expect(matchesLocation("Remote - US", "usa")).toBe(true);
    expect(matchesLocation("Berlin, Germany", "de")).toBe(true);
    expect(matchesLocation("Norfolk, VA, US", "united states")).toBe(true);
    // No separators at all, so only word-boundary containment can reach it.
    expect(matchesLocation("Remote_USA", "usa")).toBe(true);
  });

  it("does not match a country inside an unrelated word or subdivision", () => {
    // `lower(location) LIKE '%us%'` answered yes to both of these.
    expect(matchesLocation("Houston, TX", "us")).toBe(false);
    expect(matchesLocation("Houston, TX", "united states")).toBe(false);
    // `CA` here is California, and the row already names its country.
    expect(matchesLocation("Fremont, CA, United States", "canada")).toBe(false);
    expect(matchesLocation("Fremont, CA", "canada")).toBe(false);
  });

  it("requires every part of one place string", () => {
    // A whole entry is one place: Toronto AND Canada, not Toronto OR Canada.
    expect(matchesLocation("Toronto, Canada", "Toronto, Canada")).toBe(true);
    expect(matchesLocation("Toronto, OH, US", "Toronto, Canada")).toBe(false);
    expect(matchesLocation("Ontario, Canada", "Toronto, Canada")).toBe(false);
  });

  it("forgives a country the row leaves unstated when the city matched", () => {
    // Straight off a live discovery for "Toronto, Canada": these are Toronto
    // postings that never name the country, and rejecting them made the
    // typeahead's own "Toronto, Canada" value narrower than "Toronto".
    expect(matchesLocation("Toronto, Ontario", "Toronto, Canada")).toBe(true);
    expect(matchesLocation("Toronto - Bay St", "Toronto, Canada")).toBe(true);
    // A row that states a different country still loses.
    expect(matchesLocation("Toronto, OH, US", "Toronto, Canada")).toBe(false);
    // And forgiveness needs something more specific to have matched, so a
    // bare country query cannot ride in on it.
    expect(matchesLocation("Toronto, Ontario", "canada")).toBe(false);
  });

  it("treats a posting with no stated place as no answer, and no place asked as any answer", () => {
    expect(matchesLocation(null, "toronto")).toBe(false);
    expect(matchesLocation("", "toronto")).toBe(false);
    expect(matchesLocation("Toronto, Canada", "  ")).toBe(true);
  });
});

describe("normalizeLocation", () => {
  it("folds case, accents and punctuation to comparable words", () => {
    expect(normalizeLocation("  Montréal / Québec  ")).toBe("montreal quebec");
    expect(normalizeLocation("Remote_USA")).toBe("remote usa");
  });
});

let dir: string;
let db: Db;
let repos: RepoBundle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "command-center-location-"));
  db = openDatabase(join(dir, "t.db"));
  repos = createRepos(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;

function seed(location: string | null, overrides: Partial<NewJob> = {}): void {
  seq += 1;
  repos.jobs.upsertMany([
    {
      source: "freehire",
      sourceJobId: null,
      title: `Engineer ${seq}`,
      company: "Acme",
      location,
      isRemote: null,
      applyUrl: null,
      descriptionText: "",
      salaryText: null,
      postedAt: null,
      url: `https://boards.example.com/loc-${seq}`,
      ...overrides,
    },
  ]);
}

const CORPUS = [
  "Toronto, Canada",
  "Ontario, Canada",
  "Kelowna, Canada",
  "Remote - US",
  "Québec",
  "Houston, TX",
];

function places(locations: string[]): string[] {
  return searchJobs(repos, { locations })
    .jobs.map((job) => job.location ?? "")
    .sort();
}

describe("the locations filter", () => {
  beforeEach(() => {
    for (const location of CORPUS) seed(location);
  });

  it("narrows to a city, a country or an accented place", () => {
    expect(places(["toronto"])).toEqual(["Toronto, Canada"]);
    expect(places(["canada"])).toEqual([
      "Kelowna, Canada",
      "Ontario, Canada",
      "Toronto, Canada",
    ]);
    expect(places(["Quebec"])).toEqual(["Québec"]);
  });

  it("no longer matches a country code inside an unrelated city", () => {
    // The substring filter this replaced returned "Houston, TX" here.
    expect(places(["us"])).toEqual(["Remote - US"]);
  });

  it("ORs across entries and ANDs inside one", () => {
    expect(places(["toronto", "Québec"])).toEqual([
      "Québec",
      "Toronto, Canada",
    ]);
    expect(places(["Toronto, Canada"])).toEqual(["Toronto, Canada"]);
  });

  it("returns nothing rather than everything for a place the corpus lacks", () => {
    expect(places(["Reykjavik"])).toEqual([]);
  });

  it("reports the places in the matching set as a facet", () => {
    seed("Toronto, Canada");
    const result = searchJobs(repos, { locations: ["canada"] });

    // The facet ignores its own dimension, so it offers what switching would
    // give — every stated place, not just the Canadian ones.
    expect(result.facets.locations).toEqual([
      { value: "Toronto, Canada", count: 2 },
      { value: "Houston, TX", count: 1 },
      { value: "Kelowna, Canada", count: 1 },
      { value: "Ontario, Canada", count: 1 },
      { value: "Québec", count: 1 },
      { value: "Remote - US", count: 1 },
    ]);
    expect(result.total).toBe(4);
  });
});

describe("listKnownLocations", () => {
  it("ranks stated places by frequency and skips the blank ones", () => {
    seed("Toronto, Canada");
    seed("Toronto, Canada");
    seed("Berlin, Germany");
    seed(null);
    seed("   ");

    expect(listKnownLocations(db, 50)).toEqual([
      { value: "Toronto, Canada", count: 2 },
      { value: "Berlin, Germany", count: 1 },
    ]);
    expect(listKnownLocations(db, 1)).toEqual([
      { value: "Toronto, Canada", count: 2 },
    ]);
  });
});
