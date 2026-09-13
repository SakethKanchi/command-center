/**
 * The seam that makes editing a profile mean anything.
 *
 * `resolveProfile` having the right precedence is not enough on its own: if
 * the agent still called `loadProfile()`, a user could edit their profile all
 * day and every resume would still be rendered — and every generated sentence
 * still fact-checked — against the committed seed. That is worse than not
 * having an editor, because the fabrication gate would then flag the user's
 * own real achievements as invented. These tests exercise the whole pipeline
 * and read the answer off the rendered PDF.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job, ProfileDraft } from "@domain";
import { type Db, openDatabase } from "@server/db";
import type { LlmClient } from "@server/llm";
import { createRepos, type RepoBundle } from "@server/repos";
import { clearProfileCache, loadProfile } from "@server/resume/profile";
import { extractPdfText } from "@server/verification/pdf-text";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runApplyForMe } from "./apply-for-me";

const STORED_NAME = "Hedy Kiesler Markey";

/**
 * A metric that exists only in the stored profile. Tailored copy quoting it
 * passes the fabrication gate if and only if the gate is reading the stored
 * profile; measured against the seed it is an invented number and halts.
 */
const STORED_METRIC = "88 frequency channels";

function storedProfile(): ProfileDraft {
  return {
    name: STORED_NAME,
    headline: "Systems engineer building frequency-hopping control planes",
    email: "hedy@example.test",
    phone: null,
    location: "Los Angeles, CA",
    links: [],
    summary:
      "Systems engineer working on spread-spectrum signalling in TypeScript " +
      "and Node, with SQLite as the storage layer.",
    skills: [{ name: "Backend", keywords: ["TypeScript", "Node", "SQLite"] }],
    roles: [
      {
        company: "Secret Communication Systems",
        title: "Systems Engineer",
        location: "Los Angeles, CA",
        startDate: "1941",
        endDate: null,
        bullets: [
          `Designed a frequency-hopping torpedo guidance scheme across ${STORED_METRIC}.`,
          "Built the synchronisation tooling that kept transmitter and receiver in step.",
        ],
      },
    ],
    projects: [],
    education: [],
  };
}

function createLlm(tailoring: {
  headline: string;
  summary: string;
}): LlmClient {
  return {
    model: "stub-model",
    async completeJson<T>(input: { schema: { name: string } }): Promise<T> {
      if (input.schema.name.includes("scor")) {
        return {
          score: 85,
          reason: "Backend TypeScript work lines up with the posting.",
          roleSummary: "Backend agent pipelines in TypeScript.",
          mustHaves: ["TypeScript", "Node"],
          niceToHaves: ["SQLite"],
          redFlags: [],
        } as T;
      }
      if (input.schema.name.includes("tailor")) {
        return {
          ...tailoring,
          skills: [
            { name: "Backend", keywords: ["TypeScript", "Node", "SQLite"] },
          ],
        } as T;
      }
      return {
        subject: "Staff Software Engineer at Initech",
        body: "Hello, a tailored resume is attached.",
      } as T;
    },
  };
}

const SAFE_TAILORING = {
  headline: "Backend engineer building agent pipelines",
  summary:
    "Builds retrieval and agent systems in TypeScript and Node, with SQLite " +
    "as the storage layer and HTTP APIs on top.",
};

describe("the agent reads the saved profile, not the seed", () => {
  let tempDir: string;
  let db: Db;
  let repos: RepoBundle;
  let job: Job;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "command-center-stored-profile-"));
    process.env.DATA_DIR = tempDir;
    db = openDatabase(join(tempDir, "agent.db"));
    repos = createRepos(db);
    clearProfileCache();

    repos.jobs.upsertMany([
      {
        source: "greenhouse",
        sourceJobId: "stored-profile-1",
        title: "Staff Software Engineer",
        company: "Initech",
        location: "Remote - US",
        isRemote: true,
        url: "https://example.com/jobs/stored-profile-1",
        applyUrl: null,
        descriptionText:
          "We need a backend engineer fluent in TypeScript, Node and SQLite.",
        salaryText: "$190k",
        postedAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
    const seeded = repos.jobs.getByUrl(
      "https://example.com/jobs/stored-profile-1",
    );
    if (!seeded) throw new Error("job seed failed");
    job = seeded;
  });

  afterEach(async () => {
    db.close();
    clearProfileCache();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("renders the saved profile's name onto the resume", async () => {
    repos.profile.put(storedProfile());

    const run = await runApplyForMe(
      { jobId: job.id, mode: "dry_run" },
      {
        repos,
        llm: createLlm(SAFE_TAILORING),
        baseUrl: "https://cc.example.com",
      },
    );
    expect(run.status).toBe("completed");

    const resumePath = repos.jobs.get(job.id)?.resumePath;
    expect(resumePath).toBeTruthy();
    const pdf = await extractPdfText(
      new Uint8Array(await readFile(resumePath as string)),
    );

    expect(pdf.text).toContain(STORED_NAME);
    // The committed seed belongs to someone else. Its name reaching a
    // recruiter's inbox is the failure this whole seam exists to prevent.
    expect(pdf.text).not.toContain(loadProfile().name);
  });

  it("fact-checks generated copy against the saved profile", async () => {
    repos.profile.put(storedProfile());

    const run = await runApplyForMe(
      { jobId: job.id, mode: "dry_run" },
      {
        repos,
        llm: createLlm({
          headline: SAFE_TAILORING.headline,
          summary: `Designed frequency hopping across ${STORED_METRIC} in production.`,
        }),
        baseUrl: "https://cc.example.com",
      },
    );

    // The number is in the saved profile and nowhere in the seed, so a gate
    // reading the seed would halt here.
    expect(run.errorMessage).toBeNull();
    expect(run.status).toBe("completed");
  });

  it("still halts on a number neither profile supports", async () => {
    repos.profile.put(storedProfile());

    const run = await runApplyForMe(
      { jobId: job.id, mode: "dry_run" },
      {
        repos,
        llm: createLlm({
          headline: "Engineer who cut inference latency by 92%",
          summary:
            "Cut inference latency by 92% across 14 production services.",
        }),
        baseUrl: "https://cc.example.com",
      },
    );

    expect(run.errorMessage).toContain("the profile does not support");
  });

  it("falls back to the seed while no profile has been saved", async () => {
    const run = await runApplyForMe(
      { jobId: job.id, mode: "dry_run" },
      {
        repos,
        llm: createLlm(SAFE_TAILORING),
        baseUrl: "https://cc.example.com",
      },
    );
    expect(run.status).toBe("completed");

    const resumePath = repos.jobs.get(job.id)?.resumePath;
    const pdf = await extractPdfText(
      new Uint8Array(await readFile(resumePath as string)),
    );

    expect(pdf.text).toContain(loadProfile().name);
  });

  it("refuses to render from a half-finished profile instead of using the seed", async () => {
    // Silently rendering the seed here would put another person's name on the
    // resume, which is strictly worse than saying which fields are missing.
    repos.profile.put({ ...storedProfile(), summary: "", skills: [] });

    const run = await runApplyForMe(
      { jobId: job.id, mode: "dry_run" },
      {
        repos,
        llm: createLlm(SAFE_TAILORING),
        baseUrl: "https://cc.example.com",
      },
    );

    expect(run.status).toBe("failed");
    expect(run.errorMessage).toContain("summary");
    expect(run.errorMessage).toContain("skills");
    expect(repos.jobs.get(job.id)?.resumePath).toBeNull();
  });
});
