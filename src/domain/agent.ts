/**
 * "Apply For Me" agent: run + step trace.
 *
 * The agent is a bounded tool-calling loop, not an open-ended chat. It plans a
 * fixed set of steps for one job, executes them across the connected external
 * apps, and persists every tool call. That persisted trace is the artifact the
 * reliability brief cites: each step records its inputs, outputs, attempt
 * count, duration, and idempotency key, so a run can be audited or replayed.
 */

export const AGENT_RUN_MODES = ["dry_run", "live"] as const;
/**
 * `dry_run` executes every read and every local write, and stops short of the
 * irreversible external effects (sending mail, submitting a form). It is the
 * default so a misconfigured run cannot email a recruiter.
 */
export type AgentRunMode = (typeof AGENT_RUN_MODES)[number];

export const AGENT_RUN_STATUSES = [
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const AGENT_STEP_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "awaiting_approval",
  "denied",
] as const;
export type AgentStepStatus = (typeof AGENT_STEP_STATUSES)[number];

/**
 * Every tool the agent may call, and the external app it touches.
 *
 * Keeping this a closed union is what bounds the agent: the planner may only
 * emit these, and an unknown tool name fails the run instead of being improvised.
 */
export const AGENT_TOOLS = [
  "discover_jobs",
  "score_job",
  "tailor_resume",
  "render_resume_pdf",
  "verify_resume",
  "draft_outreach_email",
  "send_outreach_email",
  "push_sheets",
  "push_notion",
  "record_application",
  "schedule_follow_up",
] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];

/** Which external app a step talks to, for the multi-app trace view. */
export const AGENT_APPS = [
  "local",
  "job_boards",
  "llm",
  "gmail",
  "google_sheets",
  "notion",
] as const;
export type AgentApp = (typeof AGENT_APPS)[number];

export type AgentRun = {
  id: string;
  jobId: string | null;
  goal: string;
  mode: AgentRunMode;
  status: AgentRunStatus;
  startedAt: string;
  completedAt: string | null;
  stepsTotal: number;
  stepsSucceeded: number;
  stepsFailed: number;
  stepsSkipped: number;
  llmCalls: number;
  errorCode: string | null;
  errorMessage: string | null;
};

export type AgentStep = {
  id: string;
  runId: string;
  seq: number;
  tool: AgentTool;
  app: AgentApp;
  status: AgentStepStatus;
  requiresApproval: boolean;
  /**
   * Stable key derived from (tool, job, semantic payload). A step that already
   * succeeded under this key is never executed again, which is what makes a
   * resumed or retried run safe against duplicate emails and duplicate rows.
   */
  idempotencyKey: string | null;
  input: unknown;
  output: unknown;
  attempts: number;
  durationMs: number | null;
  startedAt: string | null;
  completedAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type AgentRunDetail = AgentRun & {
  steps: AgentStep[];
};

/** Steps that touch the outside world irreversibly and need a human decision. */
export const AGENT_APPROVAL_REQUIRED_TOOLS: readonly AgentTool[] = [
  "send_outreach_email",
];

export type AgentStepDecision = "approve" | "deny";
