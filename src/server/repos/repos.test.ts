import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job, JobBrief, NewJob, SkillGroup } from "@domain";
import { type Db, openDatabase, transaction } from "@server/db";
import { AppError } from "@server/infra/errors";
import { createRepos, type RepoBundle } from "@server/repos";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
let db: Db;
let repos: RepoBundle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "command-center-repos-"));
  db = openDatabase(join(dir, "t.db"));
  repos = createRepos(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const POSTING_URL = "https://boards.example.com/acme/staff-engineer";

function newJob(overrides: Partial<NewJob> = {}): NewJob {
  return {
    source: "greenhouse",
    sourceJobId: null,
    title: "Staff Engineer",
    company: "Acme",
    location: "Remote",
    isRemote: true,
    url: POSTING_URL,
    applyUrl: null,
    descriptionText: "Build things.",
    salaryText: null,
    postedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Narrow a repo read that the test has already established must exist. */
function present<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`expected ${what} to exist`);
  return value;
}

function seedJob(overrides: Partial<NewJob> = {}): Job {
  repos.jobs.upsertMany([newJob(overrides)]);
  const url = overrides.url ?? POSTING_URL;
  return present(repos.jobs.getByUrl(url), `job ${url}`);
}

describe("jobs", () => {
  it("upserts by url and leaves agent output alone on re-ingest", () => {
    expect(repos.jobs.upsertMany([newJob()])).toEqual({
      inserted: 1,
      updated: 0,
    });

    const first = present(repos.jobs.getByUrl(POSTING_URL), "job");
    repos.jobs.update(first.id, {
      score: 88,
      scoreReason: "Backend-heavy, remote",
      status: "ready",
      resumePath: "/tmp/resume.pdf",
    });

    const second = repos.jobs.upsertMany([
      newJob({
        title: "Staff Engineer, Platform",
        descriptionText: "Build better things.",
        salaryText: "$220k",
      }),
    ]);
    expect(second).toEqual({ inserted: 0, updated: 1 });

    const after = present(repos.jobs.getByUrl(POSTING_URL), "job");
    expect(after.id).toBe(first.id);
    expect(repos.jobs.list()).toHaveLength(1);

    // Posting fields refreshed...
    expect(after.title).toBe("Staff Engineer, Platform");
    expect(after.descriptionText).toBe("Build better things.");
    expect(after.salaryText).toBe("$220k");
    // ...agent output untouched. Clobbering these would silently undo a
    // scoring pass on every crawl.
    expect(after.score).toBe(88);
    expect(after.scoreReason).toBe("Backend-heavy, remote");
    expect(after.status).toBe("ready");
    expect(after.resumePath).toBe("/tmp/resume.pdf");
    expect(after.discoveredAt).toBe(first.discoveredAt);
  });

  it("dedupes on (source, source_job_id) when the url changed", () => {
    expect(
      repos.jobs.upsertMany([
        newJob({ sourceJobId: "gh-42", url: "https://jobs.example.com/old" }),
      ]),
    ).toEqual({ inserted: 1, updated: 0 });

    expect(
      repos.jobs.upsertMany([
        newJob({
          sourceJobId: "gh-42",
          url: "https://jobs.example.com/new",
          title: "Staff Engineer (Reposted)",
        }),
      ]),
    ).toEqual({ inserted: 0, updated: 1 });

    const all = repos.jobs.list();
    expect(all).toHaveLength(1);
    expect(present(all.at(0) ?? null, "job").title).toBe(
      "Staff Engineer (Reposted)",
    );
  });

  it("reads the outreach recipient out of the posting at ingest", () => {
    const job = seedJob({
      descriptionText: "Apply by writing to careers@acme.io.",
    });

    expect(job.contactEmail).toBe("careers@acme.io");
    expect(job.contactEmailSource).toBe("posting");
  });

  it("keeps a confirmed recipient across a re-ingest, and restores the posting's on clear", () => {
    // The whole point of the user-owned column: a crawl refreshes the posting
    // every time it runs, and it must not silently redirect mail a human
    // already approved the address for.
    const job = seedJob({
      descriptionText: "Apply by writing to careers@acme.io.",
    });
    const saved = present(
      repos.jobs.setContactEmail(job.id, "dana@acme.io"),
      "saved card",
    );
    expect(saved.contactEmail).toBe("dana@acme.io");
    expect(saved.contactEmailSource).toBe("manual");

    repos.jobs.upsertMany([
      newJob({ descriptionText: "Apply by writing to jobs@acme.io." }),
    ]);
    const reingested = present(repos.jobs.getCard(job.id), "re-ingested card");
    expect(reingested.contactEmail).toBe("dana@acme.io");

    const cleared = present(
      repos.jobs.setContactEmail(job.id, null),
      "cleared card",
    );
    expect(cleared.contactEmail).toBe("jobs@acme.io");
    expect(cleared.contactEmailSource).toBe("posting");
  });

  it("filters by status and score, newest discovered first, honouring limit", () => {
    const one = seedJob({ url: "https://jobs.example.com/1", title: "One" });
    const two = seedJob({ url: "https://jobs.example.com/2", title: "Two" });
    const three = seedJob({
      url: "https://jobs.example.com/3",
      title: "Three",
    });

    repos.jobs.update(one.id, {
      discoveredAt: "2026-09-01T00:00:00.000Z",
      score: 10,
      status: "screened",
    });
    repos.jobs.update(two.id, {
      discoveredAt: "2026-09-03T00:00:00.000Z",
      score: 90,
      status: "ready",
    });
    // Left unscored on purpose.
    repos.jobs.update(three.id, { discoveredAt: "2026-09-02T00:00:00.000Z" });

    const titles = (filter?: Parameters<typeof repos.jobs.list>[0]) =>
      repos.jobs.list(filter).map((job) => job.title);

    expect(titles()).toEqual(["Two", "Three", "One"]);
    expect(titles({ status: ["ready"] })).toEqual(["Two"]);
    expect(titles({ status: ["ready", "screened"] })).toEqual(["Two", "One"]);
    expect(titles({ limit: 2 })).toEqual(["Two", "Three"]);

    // An unscored row is "not yet judged", not "judged zero".
    expect(titles({ minScore: 1 })).toEqual(["Two", "One"]);
    expect(titles({ minScore: 0 })).toEqual(["Two", "Three", "One"]);
    expect(titles({ minScore: 50 })).toEqual(["Two"]);

    expect(repos.jobs.counts()).toEqual({
      discovered: 1,
      screened: 1,
      ready: 1,
      applied: 0,
      closed: 0,
    });
  });

  it("round-trips JSON columns and rejects an unknown field", () => {
    const job = seedJob();
    const brief: JobBrief = {
      roleSummary: "Own the ingest pipeline.",
      mustHaves: ["TypeScript", "SQL"],
      niceToHaves: ["SQLite internals"],
      redFlags: ["on-call every other week"],
    };
    const tailoredSkills: SkillGroup[] = [
      { name: "Backend", keywords: ["TypeScript", "SQLite"] },
      { name: "Infra", keywords: ["Docker"] },
    ];

    const updated = present(
      repos.jobs.update(job.id, { brief, tailoredSkills }),
      "updated job",
    );
    expect(updated.brief).toEqual(brief);
    expect(updated.tailoredSkills).toEqual(tailoredSkills);

    // A fresh bundle proves it survived the column, not the object in hand.
    const reread = present(createRepos(db).jobs.get(job.id), "reread job");
    expect(reread.brief).toEqual(brief);
    expect(reread.tailoredSkills).toEqual(tailoredSkills);

    // A caller-supplied stamp wins over the automatic one, which is what a
    // backfill needs; clearing a JSON column takes an explicit null.
    const stamped = present(
      repos.jobs.update(job.id, {
        updatedAt: "2026-01-01T00:00:00.000Z",
        brief: null,
      }),
      "stamped job",
    );
    expect(stamped.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(stamped.brief).toBeNull();
    expect(stamped.tailoredSkills).toEqual(tailoredSkills);

    let caught: unknown;
    try {
      repos.jobs.update(job.id, {
        suitabilityScore: 4,
      } as unknown as Partial<Job>);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    if (!(caught instanceof AppError)) throw new Error("expected AppError");
    expect(caught.code).toBe("INVALID_REQUEST");

    expect(repos.jobs.update("missing-id", { score: 1 })).toBeNull();
  });
});

describe("stages", () => {
  it("reports the newest stage per job in one grouped read", () => {
    const jobA = seedJob({ url: "https://jobs.example.com/a" });
    const jobB = seedJob({ url: "https://jobs.example.com/b" });

    repos.stages.append({ jobId: jobA.id, toStage: "applied" });
    repos.stages.append({ jobId: jobA.id, toStage: "recruiter_screen" });
    const third = repos.stages.append({
      jobId: jobA.id,
      toStage: "technical_interview",
      note: "loop booked",
    });
    repos.stages.append({ jobId: jobB.id, toStage: "applied" });

    expect(third.fromStage).toBe("recruiter_screen");

    const latest = repos.stages.latestStageByJob();
    expect(latest.size).toBe(2);
    expect(latest.get(jobA.id)).toBe("technical_interview");
    expect(latest.get(jobB.id)).toBe("applied");

    expect(repos.stages.listForJob(jobA.id).map((e) => e.toStage)).toEqual([
      "technical_interview",
      "recruiter_screen",
      "applied",
    ]);
  });
});

describe("resume links", () => {
  it("counts human views only, and skips jobs nobody opened", () => {
    const viewed = seedJob({ url: "https://jobs.example.com/viewed" });
    const botOnly = seedJob({ url: "https://jobs.example.com/bot-only" });
    const untouched = seedJob({ url: "https://jobs.example.com/untouched" });

    const viewedLink = repos.resumeLinks.create({
      jobId: viewed.id,
      label: "Portfolio",
      destinationUrl: "https://portfolio.example.com",
    });
    const botLink = repos.resumeLinks.create({
      jobId: botOnly.id,
      label: "Portfolio",
      destinationUrl: "https://portfolio.example.com",
    });
    repos.resumeLinks.create({
      jobId: untouched.id,
      label: "Portfolio",
      destinationUrl: "https://portfolio.example.com",
    });

    expect(repos.resumeLinks.listForJob(viewed.id)).toEqual([viewedLink]);
    expect(
      present(repos.resumeLinks.getByToken(viewedLink.token), "link").id,
    ).toBe(viewedLink.id);
    expect(repos.resumeLinks.getByToken("not-a-token")).toBeNull();

    const human = (linkId: string) =>
      repos.resumeLinks.recordClick({
        linkId,
        isLikelyBot: false,
        userAgent: "Mozilla/5.0",
      });
    const bot = (linkId: string) =>
      repos.resumeLinks.recordClick({
        linkId,
        isLikelyBot: true,
        userAgent: "Slackbot-LinkExpanding 1.0",
      });

    const clicks = [
      human(viewedLink.id),
      human(viewedLink.id),
      human(viewedLink.id),
      bot(viewedLink.id),
      bot(viewedLink.id),
    ];
    bot(botLink.id);

    // Spread the clicks across distinct instants so "newest non-bot" is
    // unambiguous, with both bot clicks strictly newer than every human one.
    const restamp = db.prepare(
      "UPDATE resume_link_clicks SET clicked_at = ? WHERE id = ?",
    );
    const stamps = [
      "2026-09-10T10:00:00.000Z",
      "2026-09-11T10:00:00.000Z",
      "2026-09-12T10:00:00.000Z",
      "2026-09-13T10:00:00.000Z",
      "2026-09-13T11:00:00.000Z",
    ];
    clicks.forEach((click, index) => {
      restamp.run(present(stamps.at(index) ?? null, "stamp"), click.id);
    });

    const stats = repos.resumeLinks.viewStatsByJob();
    expect(stats.size).toBe(1);
    expect(stats.get(viewed.id)).toEqual({
      views: 3,
      lastViewedAt: "2026-09-12T10:00:00.000Z",
    });
    // A bot-inflated count would fire the follow-up cadence before a human
    // ever looked, so neither job below may appear at all.
    expect(stats.has(botOnly.id)).toBe(false);
    expect(stats.has(untouched.id)).toBe(false);
  });
});

describe("connectors", () => {
  it("summarizes without letting credentials cross the boundary", () => {
    const sheets = repos.connectors.upsertConnected({
      provider: "google_sheets",
      displayName: "Command Center",
      credentials: { refreshToken: "super-secret-refresh" },
      config: { spreadsheetId: "sheet-1" },
    });
    const bare = repos.connectors.upsertConnected({ provider: "notion" });

    const summary = repos.connectors.toSummary(sheets);
    expect("credentials" in summary).toBe(false);
    expect(summary.hasCredentials).toBe(true);
    expect(JSON.stringify(summary)).not.toContain("super-secret-refresh");
    expect(summary.provider).toBe("google_sheets");
    expect(summary.accountKey).toBe("default");
    expect(summary.status).toBe("connected");
    expect(summary.config).toEqual({ spreadsheetId: "sheet-1" });

    const bareSummary = repos.connectors.toSummary(bare);
    expect("credentials" in bareSummary).toBe(false);
    expect(bareSummary.hasCredentials).toBe(false);

    // Reconnecting with config only must not wipe the refresh token: that is
    // the difference between a working connector and a silent 401 mid-demo.
    repos.connectors.upsertConnected({
      provider: "google_sheets",
      config: { spreadsheetId: "sheet-2" },
    });
    const reconnected = present(
      repos.connectors.getByProvider("google_sheets"),
      "connector",
    );
    expect(reconnected.id).toBe(sheets.id);
    expect(reconnected.credentials).toEqual({
      refreshToken: "super-secret-refresh",
    });
    expect(reconnected.config).toEqual({ spreadsheetId: "sheet-2" });

    const disconnected = present(
      repos.connectors.disconnect(sheets.id),
      "disconnected connector",
    );
    expect(disconnected.status).toBe("disconnected");
    expect(disconnected.credentials).toBeNull();
    expect(repos.connectors.toSummary(disconnected).hasCredentials).toBe(false);
  });

  it("upserts the record ledger in place, keyed by entity", () => {
    const job = seedJob();
    const connector = repos.connectors.upsertConnected({ provider: "notion" });
    const key = `opportunity:${job.id}`;

    repos.connectors.upsertRecords(connector.id, [
      {
        entityKind: "opportunity",
        entityId: job.id,
        remoteId: "page-1",
        remoteUrl: "https://notion.so/page-1",
        contentHash: "hash-1",
      },
    ]);

    const first = repos.connectors.getRecords(connector.id);
    expect(first.size).toBe(1);
    const before = present(first.get(key) ?? null, "record");
    expect(before.provider).toBe("notion");
    expect(before.remoteId).toBe("page-1");
    expect(before.contentHash).toBe("hash-1");
    expect(before.lastPushedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    repos.connectors.upsertRecords(connector.id, [
      {
        entityKind: "opportunity",
        entityId: job.id,
        remoteId: "page-1",
        remoteUrl: "https://notion.so/page-1",
        contentHash: "hash-2",
      },
    ]);

    const second = repos.connectors.getRecords(connector.id);
    expect(second.size).toBe(1);
    const after = present(second.get(key) ?? null, "record");
    expect(after.id).toBe(before.id);
    expect(after.contentHash).toBe("hash-2");
  });

  it("tracks a sync run from start to finish", () => {
    const connector = repos.connectors.upsertConnected({
      provider: "google_sheets",
    });
    const run = repos.connectors.startSyncRun({
      connectorId: connector.id,
      provider: "google_sheets",
      trigger: "agent",
    });
    expect(run.status).toBe("running");
    expect(run.completedAt).toBeNull();

    const finished = present(
      repos.connectors.finishSyncRun({
        id: run.id,
        status: "completed",
        recordsConsidered: 4,
        recordsCreated: 3,
        recordsUnchanged: 1,
      }),
      "finished run",
    );
    expect(finished.status).toBe("completed");
    expect(finished.recordsCreated).toBe(3);
    expect(finished.recordsUnchanged).toBe(1);
    expect(finished.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    expect(
      repos.connectors.listSyncRuns({ provider: "google_sheets" }),
    ).toHaveLength(1);
    expect(repos.connectors.listSyncRuns({ provider: "notion" })).toEqual([]);
  });
});

describe("agent trace", () => {
  it("replays only a succeeded step for an idempotency key", () => {
    const job = seedJob();
    const run = repos.agent.createRun({
      jobId: job.id,
      goal: "Apply to Acme",
      mode: "live",
    });
    const key = `push_sheets:${job.id}`;

    const failed = repos.agent.createStep({
      runId: run.id,
      tool: "push_sheets",
      app: "google_sheets",
      idempotencyKey: key,
    });
    repos.agent.updateStep({
      id: failed.id,
      status: "failed",
      attempts: 3,
      errorCode: "UPSTREAM_ERROR",
      completedAt: "2026-09-13T09:00:00.000Z",
    });
    expect(
      repos.agent.findSucceededStepByIdempotencyKey({
        tool: "push_sheets",
        idempotencyKey: key,
      }),
    ).toBeNull();

    const succeeded = repos.agent.createStep({
      runId: run.id,
      tool: "push_sheets",
      app: "google_sheets",
      idempotencyKey: key,
    });
    repos.agent.updateStep({
      id: succeeded.id,
      status: "succeeded",
      output: { created: 4 },
      attempts: 1,
      durationMs: 120,
      completedAt: "2026-09-13T09:05:00.000Z",
    });

    const found = present(
      repos.agent.findSucceededStepByIdempotencyKey({
        tool: "push_sheets",
        idempotencyKey: key,
      }),
      "succeeded step",
    );
    expect(found.id).toBe(succeeded.id);
    expect(found.output).toEqual({ created: 4 });
    expect(found.durationMs).toBe(120);

    // The same key under a different tool is a different effect.
    expect(
      repos.agent.findSucceededStepByIdempotencyKey({
        tool: "push_notion",
        idempotencyKey: key,
      }),
    ).toBeNull();
  });

  it("exposes the run detail in execution order and parks approvals", () => {
    const run = repos.agent.createRun({ goal: "Apply to Acme" });
    repos.agent.createStep({ runId: run.id, tool: "score_job", app: "llm" });
    const outreach = repos.agent.createStep({
      runId: run.id,
      tool: "send_outreach_email",
      app: "gmail",
    });
    // Approval is domain policy, not a flag the caller has to remember.
    expect(outreach.requiresApproval).toBe(true);
    expect(outreach.seq).toBe(2);

    repos.agent.updateStep({ id: outreach.id, status: "awaiting_approval" });
    repos.agent.updateRun({
      id: run.id,
      status: "awaiting_approval",
      stepsTotal: 2,
      stepsSucceeded: 1,
      llmCalls: 1,
    });

    const detail = present(repos.agent.getRunDetail(run.id), "run detail");
    expect(detail.status).toBe("awaiting_approval");
    expect(detail.llmCalls).toBe(1);
    expect(detail.steps.map((step) => step.seq)).toEqual([1, 2]);
    expect(detail.steps.map((step) => step.tool)).toEqual([
      "score_job",
      "send_outreach_email",
    ]);

    const parked = repos.agent.listStepsAwaitingApproval();
    expect(parked.map((step) => step.id)).toEqual([outreach.id]);
    expect(
      repos.agent.listRuns({ status: ["awaiting_approval"] }),
    ).toHaveLength(1);
  });
});

describe("settings", () => {
  it("treats a null value as deletion", () => {
    repos.settings.set("llm.model", "gpt-4o-mini");
    repos.settings.set("llm.temperature", "0");
    expect(repos.settings.get("llm.model")).toBe("gpt-4o-mini");
    expect(repos.settings.all()).toEqual({
      "llm.model": "gpt-4o-mini",
      "llm.temperature": "0",
    });

    repos.settings.set("llm.model", "gpt-4.1");
    expect(repos.settings.get("llm.model")).toBe("gpt-4.1");

    repos.settings.set("llm.model", null);
    expect(repos.settings.get("llm.model")).toBeNull();
    expect(repos.settings.all()).toEqual({ "llm.temperature": "0" });
  });
});

describe("transactions", () => {
  it("rolls back a failed batch and leaves the connection usable", () => {
    expect(() =>
      transaction(db, () => {
        repos.jobs.upsertMany([
          newJob({ url: "https://jobs.example.com/rolled-back" }),
        ]);
        repos.settings.set("half.written", "yes");
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(
      repos.jobs.getByUrl("https://jobs.example.com/rolled-back"),
    ).toBeNull();
    expect(repos.jobs.list()).toEqual([]);
    expect(repos.settings.get("half.written")).toBeNull();
    expect(db.isTransaction).toBe(false);

    expect(
      repos.jobs.upsertMany([
        newJob({ url: "https://jobs.example.com/after" }),
      ]),
    ).toEqual({ inserted: 1, updated: 0 });
    expect(repos.jobs.list()).toHaveLength(1);
  });
});
