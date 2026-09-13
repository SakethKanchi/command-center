import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "@domain";
import { type Db, openDatabase } from "@server/db";
import { createRepos, type RepoBundle } from "@server/repos";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCommandCenterSnapshot, summarizeSnapshot } from "./snapshot";

// Every timestamp below is an ISO-8601 UTC string, because every timestamp
// column in the schema is one. A fixture written as a number would fail the
// insert rather than silently landing in 1970, which is the point.
const DISCOVERED_EARLY = "2026-02-01T00:00:00.000Z";
const APPLIED_AT = "2026-03-01T09:00:00.000Z";
const INTERVIEW_AT = "2026-03-07T09:00:00.000Z";
const TASK_DUE_AT = "2026-03-09T09:00:00.000Z";
const CLICK_NEWEST = "2026-02-28T09:00:00.000Z";

describe("command center snapshot", () => {
  let tempDir: string;
  let db: Db;
  let repos: RepoBundle;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "command-center-snapshot-"));
    db = openDatabase(join(tempDir, "snapshot.db"));
    repos = createRepos(db);
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  type JobSeed = {
    slug: string;
    status?: Job["status"];
    title?: string;
    company?: string;
    discoveredAt?: string;
    appliedAt?: string | null;
    score?: number | null;
    scoreReason?: string | null;
    salaryText?: string | null;
    location?: string | null;
    postedAt?: string | null;
    isRemote?: boolean | null;
    resumePath?: string | null;
  };

  /** Seeds through the real repository, then returns the row it created. */
  function seedJob(seed: JobSeed): Job {
    const url = `https://example.com/jobs/${seed.slug}`;
    repos.jobs.upsertMany([
      {
        source: "greenhouse",
        sourceJobId: seed.slug,
        title: seed.title ?? `Role ${seed.slug}`,
        company: seed.company ?? `Company ${seed.slug}`,
        location: seed.location ?? null,
        isRemote: seed.isRemote ?? null,
        url,
        applyUrl: null,
        descriptionText: "",
        salaryText: seed.salaryText ?? null,
        postedAt: seed.postedAt ?? null,
        status: seed.status ?? "discovered",
      },
    ]);

    const created = repos.jobs.getByUrl(url);
    if (!created) throw new Error(`seed failed for ${seed.slug}`);

    const patched = repos.jobs.update(created.id, {
      discoveredAt: seed.discoveredAt ?? DISCOVERED_EARLY,
      appliedAt: seed.appliedAt ?? null,
      score: seed.score ?? null,
      scoreReason: seed.scoreReason ?? null,
      resumePath: seed.resumePath ?? null,
    });
    if (!patched) throw new Error(`patch failed for ${seed.slug}`);
    return patched;
  }

  /**
   * Seed a click at an explicit instant.
   *
   * `recordClick` stamps the current time, which is useless for proving which
   * click wins the `MAX`: several inserts land in the same millisecond. Writing
   * `clicked_at` directly is what lets the test put a BOT click at the newest
   * instant and then assert the reported timestamp is the older human one.
   */
  function seedClickAt(
    jobId: string,
    isLikelyBot: boolean,
    clickedAt: string,
  ): void {
    const link = repos.resumeLinks.create({
      jobId,
      label: "Resume",
      destinationUrl: `https://example.com/resume/${jobId}-${clickedAt}.pdf`,
    });
    repos.db
      .prepare(
        "INSERT INTO resume_link_clicks (id, link_id, clicked_at, is_likely_bot, user_agent) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        `click-${jobId}-${clickedAt}`,
        link.id,
        clickedAt,
        isLikelyBot ? 1 : 0,
        isLikelyBot ? "bot/1.0" : "Mozilla/5.0",
      );
  }

  /**
   * Seed a click through the real `recordClick` path, which stamps the current
   * time. Used by the test that asserts the stamped format, where the exact
   * instant does not matter but the code path does.
   */
  function seedClick(jobId: string, isLikelyBot: boolean): void {
    const link = repos.resumeLinks.create({
      jobId,
      label: "Resume",
      destinationUrl: `https://example.com/resume/${jobId}.pdf`,
    });
    repos.resumeLinks.recordClick({
      linkId: link.id,
      isLikelyBot,
      userAgent: isLikelyBot ? "bot/1.0" : "Mozilla/5.0",
    });
  }

  it("counts only non-bot resume views and reports the newest human open", () => {
    const job = seedJob({ slug: "viewed", status: "applied" });

    // Three human opens, plus bot traffic that must not register — including a
    // bot click AFTER the last human one. A scanner opening the link is not a
    // recruiter reading it, and it must not move the "last opened" timestamp
    // either, or the follow-up cadence fires against a machine.
    seedClickAt(job.id, false, "2026-02-26T09:00:00.000Z");
    seedClickAt(job.id, false, "2026-02-27T09:00:00.000Z");
    seedClickAt(job.id, false, CLICK_NEWEST);
    seedClickAt(job.id, true, "2026-03-05T09:00:00.000Z");
    seedClickAt(job.id, true, "2026-03-06T09:00:00.000Z");

    const snapshot = buildCommandCenterSnapshot(repos);
    const application = snapshot.applications.find(
      (row) => row.jobId === job.id,
    );

    expect(application?.resumeViews).toBe(3);
    expect(application?.lastResumeViewAt).toBe(CLICK_NEWEST);
  });

  it("reports zero views and a null timestamp for a job with no clicks", () => {
    const job = seedJob({ slug: "unviewed", status: "applied" });

    const snapshot = buildCommandCenterSnapshot(repos);
    const application = snapshot.applications.find(
      (row) => row.jobId === job.id,
    );

    expect(application?.resumeViews).toBe(0);
    expect(application?.lastResumeViewAt).toBeNull();
  });

  it("takes stage from the latest stage event and defaults to applied", () => {
    const staged = seedJob({ slug: "staged", status: "applied" });
    const unstaged = seedJob({ slug: "unstaged", status: "applied" });

    repos.stages.append({ jobId: staged.id, toStage: "applied" });
    repos.stages.append({ jobId: staged.id, toStage: "recruiter_screen" });

    const snapshot = buildCommandCenterSnapshot(repos);

    expect(
      snapshot.applications.find((row) => row.jobId === staged.id)?.stage,
    ).toBe("recruiter_screen");
    expect(
      snapshot.applications.find((row) => row.jobId === unstaged.id)?.stage,
    ).toBe("applied");
  });

  it("carries the outcome of a terminal stage and leaves in-flight rows null", () => {
    const rejected = seedJob({ slug: "rejected", status: "applied" });
    const live = seedJob({ slug: "live", status: "applied" });

    repos.stages.append({ jobId: rejected.id, toStage: "applied" });
    repos.stages.append({
      jobId: rejected.id,
      toStage: "closed",
      outcome: "rejected",
    });
    repos.stages.append({ jobId: live.id, toStage: "technical_interview" });

    const snapshot = buildCommandCenterSnapshot(repos);

    expect(
      snapshot.applications.find((row) => row.jobId === rejected.id)?.outcome,
    ).toBe("rejected");
    expect(
      snapshot.applications.find((row) => row.jobId === live.id)?.outcome,
    ).toBeNull();
  });

  it("filters opportunities by minScore, caps them by limit, newest discovered first", () => {
    const low = seedJob({
      slug: "low",
      score: 20,
      discoveredAt: "2026-02-04T00:00:00.000Z",
    });
    const oldest = seedJob({
      slug: "oldest",
      score: 80,
      discoveredAt: "2026-02-01T00:00:00.000Z",
    });
    const middle = seedJob({
      slug: "middle",
      status: "ready",
      score: 90,
      discoveredAt: "2026-02-02T00:00:00.000Z",
    });
    const newest = seedJob({
      slug: "newest",
      score: 70,
      discoveredAt: "2026-02-03T00:00:00.000Z",
    });

    const filtered = buildCommandCenterSnapshot(repos, { minScore: 60 });
    expect(filtered.opportunities.map((row) => row.jobId)).toEqual([
      newest.id,
      middle.id,
      oldest.id,
    ]);
    expect(filtered.opportunities.map((row) => row.jobId)).not.toContain(
      low.id,
    );

    const capped = buildCommandCenterSnapshot(repos, {
      minScore: 60,
      limit: 2,
    });
    expect(capped.opportunities.map((row) => row.jobId)).toEqual([
      newest.id,
      middle.id,
    ]);
  });

  it("keeps applied jobs out of opportunities and discovered jobs out of applications", () => {
    const open = seedJob({ slug: "open", score: 75 });
    const submitted = seedJob({
      slug: "submitted",
      status: "applied",
      score: 75,
    });

    const snapshot = buildCommandCenterSnapshot(repos);

    expect(snapshot.opportunities.map((row) => row.jobId)).toEqual([open.id]);
    expect(snapshot.applications.map((row) => row.jobId)).toEqual([
      submitted.id,
    ]);
    expect(snapshot.opportunities[0]?.key).toBe(`job-${open.id}`);
    expect(snapshot.applications[0]?.key).toBe(`app-${submitted.id}`);
    expect(summarizeSnapshot(snapshot)).toEqual({
      opportunities: 1,
      applications: 1,
      interviews: 0,
      followUps: 0,
      total: 2,
    });
  });

  it("passes stored ISO timestamps through and keeps absent values null", () => {
    const dated = seedJob({
      slug: "dated",
      status: "applied",
      appliedAt: APPLIED_AT,
      resumePath: null,
      salaryText: null,
      location: null,
    });
    const bare = seedJob({
      slug: "bare",
      score: null,
      scoreReason: null,
      salaryText: null,
      postedAt: null,
      discoveredAt: "2026-02-10T00:00:00.000Z",
    });

    repos.stages.append({ jobId: dated.id, toStage: "applied" });
    repos.stages.append({ jobId: dated.id, toStage: "recruiter_screen" });
    repos.interviews.create({
      jobId: dated.id,
      scheduledAt: INTERVIEW_AT,
      durationMins: 45,
      type: "technical",
      outcome: null,
      notes: null,
    });
    const due = repos.tasks.create({
      jobId: dated.id,
      type: "follow_up",
      title: "Nudge the recruiter",
      dueAt: TASK_DUE_AT,
      isCompleted: false,
      reason: "resume opened 3x, no reply in 5d",
    });
    const undated = repos.tasks.create({
      jobId: dated.id,
      type: "follow_up",
      title: "Send thank-you note",
      dueAt: null,
      isCompleted: true,
      reason: null,
    });
    repos.tasks.create({
      jobId: dated.id,
      type: "prep",
      title: "Review system design",
      dueAt: TASK_DUE_AT,
      isCompleted: false,
      reason: null,
    });

    const snapshot = buildCommandCenterSnapshot(repos);

    const application = snapshot.applications.find(
      (row) => row.jobId === dated.id,
    );
    expect(application?.stage).toBe("recruiter_screen");
    expect(application?.appliedAt).toBe(APPLIED_AT);
    expect(application?.resumePath).toBeNull();

    expect(snapshot.interviews).toHaveLength(1);
    expect(snapshot.interviews[0]).toMatchObject({
      kind: "interview",
      jobId: dated.id,
      scheduledAt: INTERVIEW_AT,
      durationMins: 45,
      interviewType: "technical",
      outcome: null,
    });

    // Only follow-ups, dated first; `prep` belongs to a different lane.
    expect(snapshot.followUps.map((row) => row.taskId)).toEqual([
      due.id,
      undated.id,
    ]);
    expect(snapshot.followUps[0]).toMatchObject({
      kind: "follow_up",
      key: `fu-${due.id}`,
      dueDate: TASK_DUE_AT,
      isCompleted: false,
      reason: "resume opened 3x, no reply in 5d",
    });
    expect(snapshot.followUps[1]?.dueDate).toBeNull();
    expect(snapshot.followUps[1]?.reason).toBeNull();
    expect(snapshot.followUps[1]?.isCompleted).toBe(true);

    const bareRow = snapshot.opportunities.find((row) => row.jobId === bare.id);
    expect(bareRow?.score).toBeNull();
    expect(bareRow?.scoreReason).toBeNull();
    expect(bareRow?.sponsorScore).toBeNull();
    expect(bareRow?.salary).toBeNull();
    expect(bareRow?.datePosted).toBeNull();
    expect(bareRow?.discoveredAt).toBe("2026-02-10T00:00:00.000Z");

    expect(Date.parse(snapshot.generatedAt)).not.toBeNaN();
  });

  it("names the company and role on interview and follow-up rows", () => {
    const job = seedJob({
      slug: "named",
      status: "applied",
      company: "Initech",
      title: "Staff Engineer",
    });
    repos.interviews.create({
      jobId: job.id,
      scheduledAt: INTERVIEW_AT,
      durationMins: null,
      type: "onsite",
      outcome: null,
      notes: null,
    });
    repos.tasks.create({
      jobId: job.id,
      type: "follow_up",
      title: "Check in",
      dueAt: TASK_DUE_AT,
      isCompleted: false,
      reason: null,
    });

    const snapshot = buildCommandCenterSnapshot(repos);

    expect(snapshot.interviews[0]).toMatchObject({
      company: "Initech",
      role: "Staff Engineer",
    });
    expect(snapshot.followUps[0]).toMatchObject({
      company: "Initech",
      role: "Staff Engineer",
    });
  });

  it("stamps the stage event and the click with ISO timestamps", () => {
    const job = seedJob({ slug: "stamped", status: "applied" });
    const event = repos.stages.append({
      jobId: job.id,
      toStage: "applied",
      note: "submitted via the agent",
    });
    seedClick(job.id, false);

    expect(event.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    const stats = repos.resumeLinks.viewStatsByJob().get(job.id);
    expect(stats?.lastViewedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

    const snapshot = buildCommandCenterSnapshot(repos);
    const application = snapshot.applications.find(
      (row) => row.jobId === job.id,
    );
    expect(application?.lastResumeViewAt).toBe(stats?.lastViewedAt);
  });
});
