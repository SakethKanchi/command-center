/**
 * Builds the `CommandCenterSnapshot` that every outbound connector pushes.
 *
 * One snapshot, four lanes, read once through the repository layer. Sheets and
 * Notion both render from these same objects, which is what makes the two
 * destinations verifiably consistent with each other instead of two
 * independently-drifting projections of the database.
 *
 * No SQL lives here on purpose: the repositories already return ISO-8601
 * strings for every timestamp, so this module never converts a date and can
 * never reintroduce the epoch-seconds-versus-millis bug class.
 */

import type {
  ApplicationRow,
  CommandCenterSnapshot,
  FollowUpRow,
  InterviewRow,
  Job,
  JobStatus,
  OpportunityRow,
} from "@domain";
import { nowIso } from "@server/db";
import type { RepoBundle } from "@server/repos";

const DEFAULT_LIMIT = 100;

/** Not yet applied to: these are still decisions waiting to be made. */
const OPPORTUNITY_STATUSES: JobStatus[] = ["discovered", "screened", "ready"];
const APPLICATION_STATUSES: JobStatus[] = ["applied"];

/** A submitted application with no recorded transition is, by definition, applied. */
const DEFAULT_STAGE = "applied";

/** Stages that carry an outcome. Any other stage is still in flight. */
const TERMINAL_STAGES: Record<string, true> = { offer: true, closed: true };

export type BuildCommandCenterSnapshotOptions = {
  /** Max opportunity rows. Defaults to 100. */
  limit?: number;
  /** Minimum LLM fit score an opportunity must clear. Defaults to 0. */
  minScore?: number;
};

export type CommandCenterSnapshotSummary = {
  opportunities: number;
  applications: number;
  interviews: number;
  followUps: number;
  total: number;
};

function nullableText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function buildCommandCenterSnapshot(
  repos: RepoBundle,
  options?: BuildCommandCenterSnapshotOptions,
): CommandCenterSnapshot {
  const openJobs = repos.jobs.list({
    status: OPPORTUNITY_STATUSES,
    minScore: options?.minScore ?? 0,
    limit: options?.limit ?? DEFAULT_LIMIT,
  });
  const appliedJobs = repos.jobs.list({ status: APPLICATION_STATUSES });

  const latestStages = repos.stages.latestStageByJob();
  const resumeViews = repos.resumeLinks.viewStatsByJob();

  // Interviews and follow-ups can hang off any job, including a closed one, so
  // their company/role is resolved per row rather than from the two lanes above.
  const jobCache = new Map<string, Job | null>();
  const jobById = (jobId: string): Job | null => {
    const cached = jobCache.get(jobId);
    if (cached !== undefined) return cached;
    const job = repos.jobs.get(jobId);
    jobCache.set(jobId, job);
    return job;
  };
  for (const job of [...openJobs, ...appliedJobs]) jobCache.set(job.id, job);

  const opportunities: OpportunityRow[] = openJobs.map((job) => ({
    kind: "opportunity",
    key: `job-${job.id}`,
    jobId: job.id,
    company: job.company,
    role: job.title,
    location: nullableText(job.location),
    source: job.source,
    jobUrl: nullableText(job.url),
    salary: nullableText(job.salaryText),
    score: job.score,
    scoreReason: nullableText(job.scoreReason),
    // Reserved by the row contract for a visa-sponsor register match. Nothing
    // in this build ingests a register, so the cell stays empty rather than
    // carrying a number the agent cannot defend.
    sponsorScore: null,
    isRemote: job.isRemote,
    datePosted: nullableText(job.postedAt),
    discoveredAt: job.discoveredAt,
    status: job.status,
  }));

  const applications: ApplicationRow[] = appliedJobs.map((job) => {
    const stage = latestStages.get(job.id) ?? DEFAULT_STAGE;
    const views = resumeViews.get(job.id);
    return {
      kind: "application",
      key: `app-${job.id}`,
      jobId: job.id,
      company: job.company,
      role: job.title,
      stage,
      // An outcome is only ever written alongside a terminal transition, so
      // the extra stage read is skipped for the applications still in flight.
      outcome: TERMINAL_STAGES[stage]
        ? (repos.stages.listForJob(job.id)[0]?.outcome ?? null)
        : null,
      appliedAt: job.appliedAt,
      resumePath: nullableText(job.resumePath),
      resumeViews: views?.views ?? 0,
      lastResumeViewAt: views?.lastViewedAt ?? null,
      jobUrl: nullableText(job.url),
      score: job.score,
    };
  });

  const interviews: InterviewRow[] = [];
  for (const interview of repos.interviews.list()) {
    const job = jobById(interview.jobId);
    if (!job) continue;
    interviews.push({
      kind: "interview",
      key: `int-${interview.id}`,
      jobId: interview.jobId,
      company: job.company,
      role: job.title,
      interviewId: interview.id,
      scheduledAt: interview.scheduledAt,
      durationMins: interview.durationMins,
      interviewType: interview.type,
      outcome: nullableText(interview.outcome),
    });
  }

  const followUps: FollowUpRow[] = [];
  for (const task of repos.tasks.list({ type: "follow_up" })) {
    const job = jobById(task.jobId);
    if (!job) continue;
    followUps.push({
      kind: "follow_up",
      key: `fu-${task.id}`,
      jobId: task.jobId,
      company: job.company,
      role: job.title,
      taskId: task.id,
      title: task.title,
      dueDate: task.dueAt,
      isCompleted: task.isCompleted,
      reason: nullableText(task.reason),
    });
  }

  return {
    opportunities,
    applications,
    interviews,
    followUps,
    generatedAt: nowIso(),
  };
}

export function summarizeSnapshot(
  snapshot: CommandCenterSnapshot,
): CommandCenterSnapshotSummary {
  const opportunities = snapshot.opportunities.length;
  const applications = snapshot.applications.length;
  const interviews = snapshot.interviews.length;
  const followUps = snapshot.followUps.length;

  return {
    opportunities,
    applications,
    interviews,
    followUps,
    total: opportunities + applications + interviews + followUps,
  };
}
