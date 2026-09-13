/**
 * Core job-search domain model.
 *
 * Deliberately small: an opportunity, the application it becomes, the
 * interviews and follow-ups that hang off it. Every field here is either
 * rendered in the dashboard or read by the agent — nothing is carried "just in
 * case", because every extra column is another thing the connectors have to
 * agree on.
 */

export const JOB_STATUSES = [
  "discovered",
  "screened",
  "ready",
  "applied",
  "closed",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Where an outreach address came from. No third value: this app never derives
 * a recipient from a company domain, because a guessed address is a fabricated
 * one and it reaches a real stranger.
 */
export const JOB_CONTACT_SOURCES = ["posting", "manual"] as const;
export type JobContactSource = (typeof JOB_CONTACT_SOURCES)[number];

/** Stages an application moves through once submitted. */
export const APPLICATION_STAGES = [
  "applied",
  "recruiter_screen",
  "technical_interview",
  "onsite",
  "offer",
  "closed",
] as const;
export type ApplicationStage = (typeof APPLICATION_STAGES)[number];

export const APPLICATION_OUTCOMES = [
  "offer_accepted",
  "offer_declined",
  "rejected",
  "withdrawn",
  "ghosted",
] as const;
export type ApplicationOutcome = (typeof APPLICATION_OUTCOMES)[number];

export const INTERVIEW_TYPES = [
  "recruiter_screen",
  "technical",
  "system_design",
  "behavioural",
  "onsite",
] as const;
export type InterviewType = (typeof INTERVIEW_TYPES)[number];

export const TASK_TYPES = ["follow_up", "prep", "todo"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export type Job = {
  id: string;
  /** Adapter that produced this row, e.g. `greenhouse`, `lever`, `freehire`. */
  source: string;
  /** Identifier the source uses, for dedupe across re-ingests. */
  sourceJobId: string | null;
  title: string;
  company: string;
  location: string | null;
  isRemote: boolean | null;
  url: string;
  applyUrl: string | null;
  descriptionText: string;
  salaryText: string | null;
  /**
   * Outreach recipient: the address a human confirmed when there is one,
   * otherwise the one the posting itself states. Null means the app has no way
   * to contact anybody about this role, and the UI must say so rather than
   * offer outreach it cannot perform.
   */
  contactEmail: string | null;
  contactEmailSource: JobContactSource | null;
  postedAt: string | null;
  status: JobStatus;
  /** 0-100 LLM fit score; null until the agent has scored it. */
  score: number | null;
  scoreReason: string | null;
  /** Structured read of the posting, produced alongside the score. */
  brief: JobBrief | null;
  tailoredHeadline: string | null;
  tailoredSummary: string | null;
  tailoredSkills: SkillGroup[] | null;
  resumePath: string | null;
  discoveredAt: string;
  appliedAt: string | null;
  updatedAt: string;
};

export type SkillGroup = { name: string; keywords: string[] };

/**
 * What the model extracted from the posting. Kept as evidence next to the
 * score so a low number is explainable rather than an opaque verdict.
 */
export type JobBrief = {
  roleSummary: string;
  mustHaves: string[];
  niceToHaves: string[];
  redFlags: string[];
};

export type NewJob = Omit<
  Job,
  | "id"
  | "status"
  // Derived from the posting text or set by the user; never supplied by an
  // ingest adapter.
  | "contactEmail"
  | "contactEmailSource"
  | "score"
  | "scoreReason"
  | "brief"
  | "tailoredHeadline"
  | "tailoredSummary"
  | "tailoredSkills"
  | "resumePath"
  | "discoveredAt"
  | "appliedAt"
  | "updatedAt"
> &
  Partial<Pick<Job, "status">>;

export type StageEvent = {
  id: string;
  jobId: string;
  fromStage: ApplicationStage | null;
  toStage: ApplicationStage;
  outcome: ApplicationOutcome | null;
  note: string | null;
  /** ISO-8601. Every timestamp crossing a boundary in this codebase is ISO. */
  occurredAt: string;
};

export type Interview = {
  id: string;
  jobId: string;
  scheduledAt: string;
  durationMins: number | null;
  type: InterviewType;
  outcome: string | null;
  notes: string | null;
};

export type Task = {
  id: string;
  jobId: string;
  type: TaskType;
  title: string;
  dueAt: string | null;
  isCompleted: boolean;
  /** Why the agent scheduled this, e.g. "resume opened 3x, no reply in 5d". */
  reason: string | null;
};

/**
 * A tracked link embedded in a submitted resume. A non-bot click means somebody
 * actually opened the document, which is the only engagement signal available
 * without a reply — and it is what shortens the follow-up cadence.
 */
export type ResumeLink = {
  id: string;
  jobId: string;
  token: string;
  label: string;
  destinationUrl: string;
};

export type ResumeLinkClick = {
  id: string;
  linkId: string;
  clickedAt: string;
  isLikelyBot: boolean;
  userAgent: string | null;
};

/** The candidate. Single source of truth for every fabrication check. */
export type Profile = {
  name: string;
  email: string;
  phone: string | null;
  location: string | null;
  links: Array<{ label: string; url: string }>;
  headline: string;
  summary: string;
  experience: Array<{
    company: string;
    title: string;
    start: string;
    end: string | null;
    location: string | null;
    bullets: string[];
  }>;
  projects: Array<{
    name: string;
    description: string;
    url: string | null;
    bullets: string[];
  }>;
  skills: SkillGroup[];
  education: Array<{
    school: string;
    degree: string;
    start: string | null;
    end: string | null;
  }>;
};
