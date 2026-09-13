import type {
  AgentRunDetail,
  AgentStep,
  CommandCenterSnapshot,
  ConnectorHealth,
} from "@domain";
import type { LaneSummary } from "@web/lib/api";
import { vi } from "vitest";

/**
 * Shared fixtures and a fetch double for the component suites. The dashboard
 * talks to the server through global `fetch` only, so stubbing it is enough to
 * exercise every screen with zero network.
 */

export type StubRoute = {
  method?: "GET" | "POST";
  /** Matched against the request URL as a substring; first match wins. */
  path: string;
  /** Wrapped in `{ ok: true, data }`. */
  data?: unknown;
  /** Returned as `{ ok: false, error }`. */
  error?: { code: string; message: string };
  status?: number;
  /**
   * Held before responding, so a test can observe the in-flight UI. The call is
   * recorded before the gate is awaited, which is what lets a test assert that
   * a second click issued no second request.
   */
  gate?: Promise<unknown>;
};

export type StubCall = { method: string; url: string; body: unknown };

export function installFetch(routes: StubRoute[]) {
  const calls: StubCall[] = [];

  const impl = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });

      const route = routes.find(
        (candidate) =>
          url.includes(candidate.path) &&
          (candidate.method ?? "GET") === method,
      );
      if (!route) {
        throw new Error(`No stub route for ${method} ${url}`);
      }
      if (route.gate) await route.gate;
      const payload = route.error
        ? { ok: false, error: route.error }
        : { ok: true, data: route.data };
      return {
        status: route.status ?? (route.error ? 400 : 200),
        json: async () => payload,
      } as unknown as Response;
    },
  );

  vi.stubGlobal("fetch", impl);
  return {
    calls,
    impl,
    countOf(method: string, path: string) {
      return calls.filter(
        (call) => call.method === method && call.url.includes(path),
      ).length;
    },
  };
}

export const SNAPSHOT: CommandCenterSnapshot = {
  generatedAt: "2026-09-13T10:00:00.000Z",
  opportunities: [
    {
      kind: "opportunity",
      key: "opportunity:job_1",
      jobId: "job_1",
      company: "Monzo",
      role: "Senior Backend Engineer",
      location: "London, UK",
      source: "greenhouse",
      jobUrl: "https://boards.greenhouse.io/monzo/jobs/1",
      salary: "£90k–£110k",
      score: 87,
      scoreReason: "Node and Postgres depth line up with the must-haves",
      sponsorScore: 100,
      isRemote: false,
      datePosted: "2026-09-10T00:00:00.000Z",
      discoveredAt: "2026-09-12T08:30:00.000Z",
      status: "ready",
    },
    {
      kind: "opportunity",
      key: "opportunity:job_2",
      jobId: "job_2",
      company: "Cleo",
      role: "Platform Engineer",
      location: null,
      source: "lever",
      jobUrl: "https://jobs.lever.co/cleo/2",
      salary: null,
      score: null,
      scoreReason: null,
      sponsorScore: null,
      isRemote: true,
      datePosted: null,
      discoveredAt: "2026-09-12T09:00:00.000Z",
      status: "discovered",
    },
  ],
  applications: [
    {
      kind: "application",
      key: "application:job_3",
      jobId: "job_3",
      company: "Wise",
      role: "Backend Engineer",
      stage: "recruiter_screen",
      outcome: null,
      appliedAt: "2026-09-05T12:00:00.000Z",
      resumePath: "/tmp/wise.pdf",
      resumeViews: 4,
      lastResumeViewAt: "2026-09-11T17:20:00.000Z",
      jobUrl: "https://wise.jobs/3",
      score: 82,
    },
  ],
  interviews: [
    {
      kind: "interview",
      key: "interview:iv_1",
      jobId: "job_3",
      company: "Wise",
      role: "Backend Engineer",
      interviewId: "iv_1",
      scheduledAt: "2026-09-18T14:00:00.000Z",
      durationMins: 60,
      interviewType: "technical",
      outcome: null,
    },
  ],
  followUps: [
    {
      kind: "follow_up",
      key: "follow_up:task_1",
      jobId: "job_3",
      company: "Wise",
      role: "Backend Engineer",
      taskId: "task_1",
      title: "Follow up with Wise re: Backend Engineer",
      dueDate: "2026-09-15T09:00:00.000Z",
      isCompleted: false,
      reason: "Resume opened 4x with no reply — nudge in 3d",
    },
  ],
};

export const SUMMARY: LaneSummary = {
  opportunities: 2,
  applications: 1,
  interviews: 1,
  followUps: 1,
  total: 5,
};

/**
 * Sheets connected on its own OAuth token, Notion on the hosted transport and
 * never set up, Gmail set up directly and then broken. `authMode` is present
 * because the API layer always fills it in, and the cards branch on it.
 */
export const HEALTH: ConnectorHealth[] = [
  {
    provider: "google_sheets",
    accountKey: "default",
    connected: true,
    status: "connected",
    target: "Command Center 2026",
    destinationUrl: "https://docs.google.com/spreadsheets/d/abc",
    lastSyncedAt: "2026-09-13T09:55:00.000Z",
    lastError: null,
    authMode: "direct",
    linkState: "none",
  },
  {
    provider: "notion",
    accountKey: "default",
    connected: false,
    status: "disconnected",
    target: null,
    destinationUrl: null,
    lastSyncedAt: null,
    lastError: null,
    authMode: "composio",
    linkState: "none",
  },
  {
    provider: "gmail_send",
    accountKey: "default",
    connected: false,
    status: "error",
    target: "saketh@example.com",
    destinationUrl: null,
    lastSyncedAt: "2026-09-12T18:00:00.000Z",
    lastError: "Refresh token rejected (invalid_grant).",
    authMode: "direct",
    linkState: "none",
  },
];

function step(
  overrides: Partial<AgentStep> & Pick<AgentStep, "seq" | "tool" | "app">,
): AgentStep {
  return {
    id: `step_${overrides.seq}`,
    runId: "run_1",
    status: "succeeded",
    requiresApproval: false,
    idempotencyKey: `key_${overrides.seq}`,
    input: null,
    output: null,
    attempts: 1,
    durationMs: 800,
    startedAt: "2026-09-13T10:00:00.000Z",
    completedAt: "2026-09-13T10:00:00.800Z",
    decidedAt: null,
    decidedBy: null,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

/**
 * A run that reached five external systems and parked on the one irreversible
 * step — the shape the trace has to render correctly for the demo to hold up.
 */
export const RUN: AgentRunDetail = {
  id: "run_1",
  jobId: "job_1",
  goal: "Apply to Senior Backend Engineer at Monzo",
  mode: "dry_run",
  status: "awaiting_approval",
  startedAt: "2026-09-13T10:00:00.000Z",
  completedAt: null,
  stepsTotal: 6,
  stepsSucceeded: 5,
  stepsFailed: 0,
  stepsSkipped: 0,
  llmCalls: 3,
  errorCode: null,
  errorMessage: null,
  steps: [
    step({
      seq: 1,
      tool: "discover_jobs",
      app: "job_boards",
      durationMs: 1240,
      output: {
        considered: 42,
        inserted: 3,
        updated: 1,
        sources: ["greenhouse", "lever"],
      },
    }),
    step({
      seq: 2,
      tool: "score_job",
      app: "llm",
      durationMs: 2100,
      attempts: 2,
      output: { score: 87, reason: "Node and Postgres depth match" },
    }),
    step({
      seq: 3,
      tool: "verify_resume",
      app: "local",
      durationMs: 340,
      output: {
        ats: { score: 87, passed: true, threshold: 80 },
        fabrications: [],
        styleWarnings: [
          { kind: "forbidden_phrase", claim: "leveraged", context: "…" },
        ],
      },
    }),
    step({
      seq: 4,
      tool: "push_sheets",
      app: "google_sheets",
      durationMs: 910,
      output: {
        destinationUrl: "https://docs.google.com/spreadsheets/d/abc",
        created: 1,
        updated: 2,
        unchanged: 3,
      },
    }),
    step({
      seq: 5,
      tool: "push_notion",
      app: "notion",
      durationMs: 1500,
      output: {
        destinationUrl: "https://notion.so/db",
        created: 1,
        updated: 0,
        unchanged: 4,
      },
    }),
    step({
      seq: 6,
      tool: "send_outreach_email",
      app: "gmail",
      status: "awaiting_approval",
      requiresApproval: true,
      durationMs: null,
      completedAt: null,
      input: {
        to: "hiring@monzo.com",
        subject: "Senior Backend Engineer — Saketh Kanchi",
        body: "Hi there,\n\nI applied for the Senior Backend Engineer role today.",
      },
    }),
  ],
};

export const RUN_COMPLETED: AgentRunDetail = {
  ...RUN,
  status: "completed",
  completedAt: "2026-09-13T10:00:45.000Z",
  stepsSucceeded: 6,
  steps: RUN.steps.map((entry) =>
    entry.tool === "send_outreach_email"
      ? {
          ...entry,
          status: "succeeded",
          durationMs: 620,
          output: {
            to: "hiring@monzo.com",
            subject: "Senior Backend Engineer — Saketh Kanchi",
            webUrl: "https://mail.google.com/mail/u/0/#sent/xyz",
          },
        }
      : entry,
  ),
};
