import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "@domain";
import { type Db, openDatabase } from "@server/db";
import type { LlmClient } from "@server/llm";
import { createRepos, type RepoBundle } from "@server/repos";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideAgentStep, runApplyForMe } from "./apply-for-me";

const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

const SAFE_TAILORING = {
  headline: "Backend engineer building agent pipelines",
  summary:
    "Builds retrieval and agent systems in TypeScript and Node, with SQLite as " +
    "the storage layer and HTTP APIs on top.",
  skills: [{ name: "Backend", keywords: ["TypeScript", "Node", "SQLite"] }],
};

/**
 * A tailoring pass that invents a metric the profile cannot support. The fact
 * gate has to catch this before anything leaves the machine.
 */
const FABRICATED_TAILORING = {
  headline: "Engineer who cut inference latency by 92%",
  summary:
    "Cut inference latency by 92% across 14 production services while leading " +
    "a team of 9 engineers.",
  skills: [{ name: "Backend", keywords: ["TypeScript"] }],
};

type StubOptions = { tailoring?: typeof SAFE_TAILORING; score?: number };

/** Deterministic model. No network, and every schema answered in one shape. */
function createLlm(options: StubOptions = {}): LlmClient {
  return {
    model: "stub-model",
    async completeJson<T>(input: { schema: { name: string } }): Promise<T> {
      if (input.schema.name.includes("scor")) {
        const score = options.score ?? 82;
        return {
          score,
          reason:
            score < 20
              ? "Hard disqualifier: the posting requires 10 years of Fortran."
              : "Backend TypeScript work lines up with the posting.",
          roleSummary: "Backend agent pipelines in TypeScript.",
          mustHaves: ["TypeScript", "Node"],
          niceToHaves: ["SQLite"],
          redFlags: score < 20 ? ["Fortran"] : [],
        } as T;
      }
      if (input.schema.name.includes("tailor")) {
        return (options.tailoring ?? SAFE_TAILORING) as T;
      }
      return {
        subject: "Staff Software Engineer at Initech",
        body:
          "Hello, I build agent pipelines in TypeScript and Node against SQLite, " +
          "which is the core of this role. A tailored resume is attached.",
      } as T;
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("apply-for-me", () => {
  let tempDir: string;
  let db: Db;
  let repos: RepoBundle;
  let job: Job;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "command-center-agent-"));
    process.env.DATA_DIR = tempDir;
    db = openDatabase(join(tempDir, "agent.db"));
    repos = createRepos(db);

    repos.jobs.upsertMany([
      {
        source: "greenhouse",
        sourceJobId: "agent-1",
        title: "Staff Software Engineer",
        company: "Initech",
        location: "Remote - US",
        isRemote: true,
        url: "https://example.com/jobs/agent-1",
        applyUrl: null,
        descriptionText:
          "We need a backend engineer fluent in TypeScript, Node and SQLite. " +
          "You will build agent pipelines, retrieval systems and HTTP APIs.",
        salaryText: "$190k",
        postedAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
    const seeded = repos.jobs.getByUrl("https://example.com/jobs/agent-1");
    if (!seeded) throw new Error("job seed failed");
    job = seeded;
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function connectGmail(): void {
    repos.connectors.upsertConnected({
      provider: "gmail_send",
      credentials: {
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      },
      config: { fromAddress: "me@example.com" },
    });
  }

  const gmailFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return jsonResponse({ access_token: "access-token", expires_in: 3600 });
    }
    if (url.includes("/profile")) {
      return jsonResponse({ emailAddress: "me@example.com" });
    }
    if (url.includes("/messages/send")) {
      return jsonResponse({ id: "msg-1", threadId: "thread-1" });
    }
    throw new Error(`unstubbed gmail request: ${url}`);
  };

  it("drafts and verifies without sending in dry_run", async () => {
    const run = await runApplyForMe(
      {
        jobId: job.id,
        mode: "dry_run",
        contactEmail: "recruiter@initech.example",
      },
      { repos, llm: createLlm(), baseUrl: "https://cc.example.com" },
    );

    expect(run.status).toBe("completed");
    const send = run.steps.find((step) => step.tool === "send_outreach_email");
    expect(send?.status).toBe("skipped");
    expect(send?.output).toBeNull();

    const drafted = run.steps.find(
      (step) => step.tool === "draft_outreach_email",
    );
    expect(drafted?.status).toBe("succeeded");
    expect(repos.jobs.get(job.id)?.status).toBe("applied");
  });

  it("addresses outreach to the posting's own contact when the caller names none", async () => {
    // The dashboard's Apply button sends no recipient, so this fallback is the
    // only reason outreach happens at all from the UI.
    repos.jobs.update(job.id, {
      descriptionText: `${job.descriptionText} Questions to careers@initech.io.`,
    });

    const run = await runApplyForMe(
      { jobId: job.id, mode: "dry_run" },
      { repos, llm: createLlm(), baseUrl: "https://cc.example.com" },
    );

    const drafted = run.steps.find(
      (step) => step.tool === "draft_outreach_email",
    );
    expect(drafted?.status).toBe("succeeded");
    expect(drafted?.input).toMatchObject({ to: "careers@initech.io" });
  });

  it("runs the plan without an outreach step when nobody can be contacted", async () => {
    const run = await runApplyForMe(
      { jobId: job.id, mode: "dry_run" },
      { repos, llm: createLlm(), baseUrl: "https://cc.example.com" },
    );

    expect(run.status).toBe("completed");
    expect(run.steps.map((step) => step.tool)).not.toContain(
      "draft_outreach_email",
    );
    expect(run.steps.map((step) => step.tool)).not.toContain(
      "send_outreach_email",
    );
  });

  it("stops before tailoring when the fit score is below the floor", async () => {
    const run = await runApplyForMe(
      { jobId: job.id, contactEmail: "recruiter@initech.example" },
      {
        repos,
        llm: createLlm({ score: 10 }),
        baseUrl: "https://cc.example.com",
      },
    );

    // Scoring ran; nothing after it did. Spending three more model calls and a
    // recruiter's attention on a role that hard-disqualifies you is the waste
    // this gate exists to prevent.
    expect(run.steps.map((step) => step.tool)).toEqual([
      "score_job",
      "score_job",
    ]);
    expect(run.errorMessage).toContain("below the 20 floor");

    // The score is still persisted — the run was useful even though it stopped.
    const stored = repos.jobs.get(job.id);
    expect(stored?.score).toBe(10);
    expect(stored?.status).toBe("screened");
    expect(stored?.tailoredHeadline).toBeNull();
    expect(stored?.appliedAt).toBeNull();
  });

  it("proceeds past a low fit score when the user forces it", async () => {
    const run = await runApplyForMe(
      { jobId: job.id, force: true },
      {
        repos,
        llm: createLlm({ score: 10 }),
        baseUrl: "https://cc.example.com",
      },
    );

    // The score is a model judgement, not a fact, so the user can overrule it.
    expect(run.steps.map((step) => step.tool)).toContain("tailor_resume");
    expect(repos.jobs.get(job.id)?.status).toBe("applied");
  });

  it("applies the fit floor at its boundary, not one point off", async () => {
    const run = await runApplyForMe(
      { jobId: job.id },
      {
        repos,
        llm: createLlm({ score: 20 }),
        baseUrl: "https://cc.example.com",
      },
    );

    expect(run.steps.map((step) => step.tool)).toContain("tailor_resume");
  });

  it("honours a fit floor raised in settings", async () => {
    // 45 clears the shipped floor of 20, so a run that still halts proves the
    // gate reads the setting rather than the constant it replaced.
    repos.settings.set("agent.fitMinScore", "60");

    const run = await runApplyForMe(
      { jobId: job.id },
      {
        repos,
        llm: createLlm({ score: 45 }),
        baseUrl: "https://cc.example.com",
      },
    );

    expect(run.steps.map((step) => step.tool)).not.toContain("tailor_resume");
    expect(run.errorMessage).toContain("below the 60 floor");
  });

  it("stamps every trace timestamp as an ISO string", async () => {
    const run = await runApplyForMe(
      { jobId: job.id },
      { repos, llm: createLlm(), baseUrl: "https://cc.example.com" },
    );

    expect(run.startedAt).toMatch(ISO);
    expect(run.completedAt).toMatch(ISO);
    for (const step of run.steps) {
      if (step.startedAt !== null) expect(step.startedAt).toMatch(ISO);
      if (step.completedAt !== null) expect(step.completedAt).toMatch(ISO);
    }
    expect(repos.jobs.get(job.id)?.appliedAt).toMatch(ISO);
    expect(repos.stages.listForJob(job.id)[0]?.occurredAt).toMatch(ISO);
    expect(repos.tasks.list({ type: "follow_up" })[0]?.dueAt).toMatch(ISO);
  });

  it("halts before recording the application when the copy is fabricated", async () => {
    const run = await runApplyForMe(
      { jobId: job.id },
      {
        repos,
        llm: createLlm({ tailoring: FABRICATED_TAILORING }),
        baseUrl: "https://cc.example.com",
      },
    );

    const verify = run.steps.find((step) => step.tool === "verify_resume");
    expect(verify?.status).toBe("succeeded");
    expect(run.errorMessage).toContain("the profile does not support");
    expect(run.steps.some((step) => step.tool === "record_application")).toBe(
      false,
    );
    expect(repos.jobs.get(job.id)?.status).not.toBe("applied");
    expect(repos.stages.listForJob(job.id)).toHaveLength(0);
  });

  it("skips an unconfigured destination rather than failing the run", async () => {
    const run = await runApplyForMe(
      { jobId: job.id },
      { repos, llm: createLlm(), baseUrl: "https://cc.example.com" },
    );

    const pushes = run.steps.filter((step) => step.tool.startsWith("push_"));
    expect(pushes).toHaveLength(2);
    for (const push of pushes) {
      expect(push.status).toBe("skipped");
      expect(push.errorMessage).toBe("Not configured");
    }
    expect(run.status).toBe("completed");
  });

  it("replays the idempotent local effects instead of duplicating them", async () => {
    const deps = { repos, llm: createLlm(), baseUrl: "https://cc.example.com" };
    await runApplyForMe({ jobId: job.id }, deps);
    const second = await runApplyForMe({ jobId: job.id }, deps);

    const replayed = second.steps.filter(
      (step) =>
        step.status === "skipped" &&
        step.errorMessage?.startsWith("Replayed from step") === true,
    );
    expect(replayed.map((step) => step.tool).sort()).toEqual([
      "record_application",
      "schedule_follow_up",
    ]);
    expect(repos.stages.listForJob(job.id)).toHaveLength(1);
    expect(repos.tasks.list({ type: "follow_up" })).toHaveLength(1);
  });

  it("parks a live send for approval with the full draft on the step", async () => {
    connectGmail();
    const run = await runApplyForMe(
      {
        jobId: job.id,
        mode: "live",
        contactEmail: "recruiter@initech.example",
      },
      {
        repos,
        llm: createLlm(),
        baseUrl: "https://cc.example.com",
        fetchImpl: gmailFetch,
      },
    );

    expect(run.status).toBe("awaiting_approval");
    const parked = run.steps.find(
      (step) => step.status === "awaiting_approval",
    );
    expect(parked?.tool).toBe("send_outreach_email");
    expect(parked?.requiresApproval).toBe(true);
    expect(parked?.output).toBeNull();
    expect(parked?.input).toMatchObject({
      to: "recruiter@initech.example",
      subject: expect.stringContaining("Initech"),
    });
  });

  it("sends only after approval, and records who decided", async () => {
    connectGmail();
    const deps = {
      repos,
      llm: createLlm(),
      baseUrl: "https://cc.example.com",
      fetchImpl: gmailFetch,
    };
    const run = await runApplyForMe(
      {
        jobId: job.id,
        mode: "live",
        contactEmail: "recruiter@initech.example",
      },
      deps,
    );
    const parked = run.steps.find(
      (step) => step.status === "awaiting_approval",
    );
    if (!parked) throw new Error("expected a parked step");

    const approved = await decideAgentStep(
      { stepId: parked.id, decision: "approve", decidedBy: "dashboard" },
      deps,
    );

    const sent = approved.steps.find((step) => step.id === parked.id);
    expect(sent?.status).toBe("succeeded");
    expect(sent?.decidedBy).toBe("dashboard");
    expect(sent?.decidedAt).toMatch(ISO);
    expect(sent?.output).toMatchObject({
      messageId: "msg-1",
      to: "recruiter@initech.example",
    });
    expect(approved.status).toBe("completed");
  });

  it("sends nothing when the reviewer denies", async () => {
    connectGmail();
    const deps = {
      repos,
      llm: createLlm(),
      baseUrl: "https://cc.example.com",
      // No stub: a request here would throw, which is the assertion.
      fetchImpl: (async () => {
        throw new Error("denied step must not reach the network");
      }) as unknown as typeof fetch,
    };
    const run = await runApplyForMe(
      {
        jobId: job.id,
        mode: "live",
        contactEmail: "recruiter@initech.example",
      },
      deps,
    );
    const parked = run.steps.find(
      (step) => step.status === "awaiting_approval",
    );
    if (!parked) throw new Error("expected a parked step");

    const denied = await decideAgentStep(
      { stepId: parked.id, decision: "deny", decidedBy: "dashboard" },
      deps,
    );

    const step = denied.steps.find((candidate) => candidate.id === parked.id);
    expect(step?.status).toBe("denied");
    expect(step?.output).toBeNull();
    expect(denied.status).toBe("completed");
    expect(denied.errorMessage).toContain("nothing was sent");
  });

  it("refuses a decision on a step that is not awaiting one", async () => {
    const run = await runApplyForMe(
      { jobId: job.id },
      { repos, llm: createLlm(), baseUrl: "https://cc.example.com" },
    );
    const succeeded = run.steps.find((step) => step.status === "succeeded");
    if (!succeeded) throw new Error("expected a succeeded step");

    await expect(
      decideAgentStep(
        { stepId: succeeded.id, decision: "approve", decidedBy: "dashboard" },
        { repos, llm: createLlm() },
      ),
    ).rejects.toThrow(/not awaiting approval/);
  });
});
