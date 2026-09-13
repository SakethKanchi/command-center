import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyProfileDraft, type ProfileDraft } from "@domain";
import { type Db, openDatabase } from "@server/db";
import { createRepos, type RepoBundle } from "@server/repos";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
let db: Db;
let repos: RepoBundle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "command-center-profile-repo-"));
  db = openDatabase(join(dir, "t.db"));
  repos = createRepos(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function renderable(overrides: Partial<ProfileDraft> = {}): ProfileDraft {
  return {
    ...emptyProfileDraft(),
    name: "Ada Lovelace",
    headline: "Analytical Engine Programmer",
    email: "ada@example.com",
    summary: "Works on mechanical computation and its notation.",
    roles: [
      {
        company: "Analytical Engines",
        title: "Lead Analyst",
        location: "London, UK",
        startDate: "1843",
        endDate: null,
        bullets: ["Published the first algorithm for a general machine."],
      },
    ],
    skills: [{ name: "Analysis", keywords: ["Notation", "Mathematics"] }],
    ...overrides,
  };
}

describe("profile repository", () => {
  it("reports no profile before one is saved", () => {
    expect(repos.profile.get()).toBeNull();
  });

  it("round-trips every field, including nested roles and skills", () => {
    const draft = renderable({
      phone: "+1 555 010 1234",
      location: "London, UK",
      links: [{ label: "GitHub", url: "https://github.com/adalovelace" }],
      education: [
        {
          school: "Somerville",
          credential: "Mathematics",
          location: "Oxford",
          startDate: "1832",
          endDate: "1835",
        },
      ],
    });

    repos.profile.put(draft);

    expect(repos.profile.get()).toEqual(draft);
  });

  it("overwrites rather than accumulating rows", () => {
    repos.profile.put(renderable());
    repos.profile.put(renderable({ name: "Ada King" }));

    expect(repos.profile.get()?.name).toBe("Ada King");
    expect(db.prepare("SELECT COUNT(*) AS n FROM profile").get()).toMatchObject(
      { n: 1 },
    );
  });

  it("drops whitespace-only values instead of storing them", () => {
    repos.profile.put(
      renderable({
        phone: "   ",
        location: "  London  ",
        roles: [
          {
            company: "Analytical Engines",
            title: "Lead Analyst",
            location: null,
            startDate: null,
            endDate: null,
            bullets: ["  Published the first algorithm.  ", "   "],
          },
        ],
      }),
    );

    const stored = repos.profile.get();
    expect(stored?.phone).toBeNull();
    expect(stored?.location).toBe("London");
    expect(stored?.roles[0]?.bullets).toEqual([
      "Published the first algorithm.",
    ]);
  });
});

describe("profile completeness", () => {
  it("is ready only when the renderer and the fact gate have what they need", () => {
    const completeness = repos.profile.completeness(renderable());

    expect(completeness.ready).toBe(true);
    expect(completeness.missing).toEqual([]);
  });

  it("names each missing requirement and refuses to be ready", () => {
    const cases: Array<[Partial<ProfileDraft>, string]> = [
      [{ name: "" }, "name"],
      [{ headline: "" }, "headline"],
      [{ email: "" }, "email"],
      [{ summary: "" }, "summary"],
      [{ roles: [] }, "roles"],
      [{ skills: [] }, "skills"],
    ];

    for (const [override, field] of cases) {
      const completeness = repos.profile.completeness(renderable(override));

      expect(completeness.ready, field).toBe(false);
      expect(
        completeness.missing.some((entry) => entry.startsWith(field)),
        `${field} should be named in ${JSON.stringify(completeness.missing)}`,
      ).toBe(true);
    }
  });

  it("treats a role with no bullets as no role at all", () => {
    // The fabrication gate has nothing to measure generated copy against when
    // a role carries only a job title, so this cannot count as ready.
    const completeness = repos.profile.completeness(
      renderable({
        roles: [
          {
            company: "Analytical Engines",
            title: "Lead Analyst",
            location: null,
            startDate: null,
            endDate: null,
            bullets: [],
          },
        ],
      }),
    );

    expect(completeness.ready).toBe(false);
    expect(completeness.missing.join(" ")).toContain("bullet");
  });

  it("scores an empty profile at zero and a full one at a hundred", () => {
    expect(repos.profile.completeness(emptyProfileDraft()).score).toBe(0);

    const full = repos.profile.completeness(
      renderable({
        location: "London, UK",
        links: [{ label: "GitHub", url: "https://github.com/adalovelace" }],
        education: [
          {
            school: "Somerville",
            credential: "Mathematics",
            location: null,
            startDate: null,
            endDate: null,
          },
        ],
      }),
    );
    expect(full.score).toBe(100);
  });

  it("scores a renderable profile below a complete one but still ready", () => {
    const bare = repos.profile.completeness(renderable());

    expect(bare.ready).toBe(true);
    expect(bare.score).toBeGreaterThan(50);
    expect(bare.score).toBeLessThan(100);
  });
});
