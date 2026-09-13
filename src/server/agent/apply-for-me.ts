import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type {
  AgentRunDetail,
  AgentRunMode,
  AgentStepDecision,
  Job,
  OutboundEmailRequest,
} from "@domain";
import { providerAuthMode } from "@server/connectors/composio/service";
import {
  pushCommandCenter,
  sendOutboundEmail,
} from "@server/connectors/service";
import { buildCommandCenterSnapshot } from "@server/connectors/snapshot";
import { nowIso } from "@server/db";
import { getConfig } from "@server/infra/config";
import { badRequest, notFound, toAppError } from "@server/infra/errors";
import { logger } from "@server/infra/logger";
import type { LlmClient } from "@server/llm";
import { scoreJob } from "@server/llm/score-job";
import { tailorResume } from "@server/llm/tailor-resume";
import type { RepoBundle } from "@server/repos";
import { resolveProfile } from "@server/resume/profile";
import { renderResumePdf } from "@server/resume/render";
import { selectedResumeTemplate } from "@server/resume/selection";
import { applyTracerLinks } from "@server/resume/tracer";
import { readAgentSettings } from "@server/settings";
import {
  scoreAtsComplianceForPdf,
  verifyDocumentFacts,
} from "@server/verification";
import { draftOutreachEmail } from "./outreach";
import {
  executeStep,
  parkStepForApproval,
  type RunLedger,
} from "./step-runner";

/**
 * A resume opened this many times without a reply is worth chasing sooner, and
 * the shorter cadence that earns. Not user-tunable: the two numbers only mean
 * anything relative to the configured delay, which the settings screen owns.
 */
const ENGAGED_VIEW_THRESHOLD = 2;
const ENGAGED_FOLLOW_UP_DELAY_DAYS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Everything the agent reaches outside itself. Injected rather than imported so
 * a test can run the whole plan against a throwaway database, a stub model and
 * a stub `fetch`, with nothing leaving the process.
 */
export type AgentDeps = {
  repos: RepoBundle;
  llm: LlmClient;
  fetchImpl?: typeof fetch;
  /** Public origin the tracked resume links point at. */
  baseUrl?: string;
};

export type ApplyForMeInput = {
  jobId: string;
  mode?: AgentRunMode;
  /** Recruiter or hiring-contact address. Absent means no outreach step. */
  contactEmail?: string | null;
  /** Re-score even when the job already carries a score. */
  rescore?: boolean;
  /** Proceed even when the fit score is below the floor. */
  force?: boolean;
};

/**
 * Stable idempotency key for a step.
 *
 * Hashing the semantic payload (not a timestamp or a run id) is what lets a
 * retried run recognize work it already completed.
 */
function stepKey(tool: string, parts: unknown[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 32);
  return `${tool}:${digest}`;
}

function resumeOutputPath(jobId: string): string {
  return resolve(
    process.env.DATA_DIR?.trim() ?? "data",
    "resumes",
    `${jobId}.pdf`,
  );
}

/**
 * Run the Apply-For-Me plan for one job.
 *
 * The plan is fixed rather than model-chosen: score, tailor, render, verify,
 * draft, send, record, sync, schedule. A fixed plan is what makes the run
 * auditable and the failure modes enumerable; the model decides content, not
 * control flow.
 *
 * Two hard stops protect the user:
 *  - the verification gate halts before anything leaves the machine if the
 *    rendered resume fails the ATS or fabrication check;
 *  - sending mail always parks for explicit approval, and never happens at all
 *    in the default `dry_run` mode.
 */
export async function runApplyForMe(
  input: ApplyForMeInput,
  deps: AgentDeps,
): Promise<AgentRunDetail> {
  const mode = input.mode ?? "dry_run";
  const job = deps.repos.jobs.get(input.jobId);
  if (!job) throw notFound(`Job ${input.jobId} not found.`);

  const run = deps.repos.agent.createRun({
    jobId: job.id,
    goal: `Apply to ${job.title} at ${job.company}`,
    mode,
  });

  const ledger: RunLedger = {
    repos: deps.repos,
    runId: run.id,
    seq: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    llmCalls: 0,
    haltedReason: null,
  };

  try {
    await executePlan(ledger, { job, mode, input, deps });
  } catch (error) {
    const appError = toAppError(error);
    logger.error("Apply-For-Me run aborted", {
      runId: run.id,
      error: appError.message,
    });
    deps.repos.agent.updateRun({
      id: run.id,
      status: "failed",
      completedAt: nowIso(),
      stepsTotal: ledger.seq,
      stepsSucceeded: ledger.succeeded,
      stepsFailed: ledger.failed + 1,
      stepsSkipped: ledger.skipped,
      llmCalls: ledger.llmCalls,
      errorCode: appError.code,
      errorMessage: appError.message,
    });
    const detail = deps.repos.agent.getRunDetail(run.id);
    if (!detail) throw appError;
    return detail;
  }

  const hasParked = deps.repos.agent
    .listStepsAwaitingApproval()
    .some((step) => step.runId === run.id);

  deps.repos.agent.updateRun({
    id: run.id,
    status: hasParked
      ? "awaiting_approval"
      : ledger.failed > 0
        ? "failed"
        : "completed",
    completedAt: hasParked ? null : nowIso(),
    stepsTotal: ledger.seq,
    stepsSucceeded: ledger.succeeded,
    stepsFailed: ledger.failed,
    stepsSkipped: ledger.skipped,
    llmCalls: ledger.llmCalls,
    errorMessage: ledger.haltedReason,
  });

  const detail = deps.repos.agent.getRunDetail(run.id);
  if (!detail) throw new Error(`Agent run ${run.id} vanished mid-flight.`);
  return detail;
}

async function executePlan(
  ledger: RunLedger,
  context: {
    job: Job;
    mode: AgentRunMode;
    input: ApplyForMeInput;
    deps: AgentDeps;
  },
): Promise<void> {
  const { job, mode, input, deps } = context;
  const { repos, llm } = deps;
  // Read once, at the top: a run that used one fit floor to decide to tailor
  // and a different one to gate the PDF would be unexplainable in the trace.
  const tuning = readAgentSettings(repos.settings);
  // The saved profile wins over the committed seed, and the same object feeds
  // tailoring, the render and the fabrication gate below — a gate reading a
  // different profile would call the candidate's own work invented.
  const profile = resolveProfile(repos.profile).profile;

  // --- 1. Score -----------------------------------------------------------
  const needsScore = input.rescore === true || job.score === null;
  const scored = await executeStep(ledger, {
    tool: "score_job",
    app: "llm",
    input: { jobId: job.id, title: job.title, company: job.company },
    idempotencyKey: needsScore
      ? null
      : stepKey("score_job", [job.id, job.score]),
    maxAttempts: 2,
    run: async () => {
      if (!needsScore) {
        return {
          kind: "skip" as const,
          reason: `Already scored ${job.score}/100`,
        };
      }
      const result = await scoreJob({ job, profile, llm });
      repos.jobs.update(job.id, {
        score: result.score,
        scoreReason: result.reason,
        brief: result.brief,
        status: job.status === "discovered" ? "screened" : job.status,
      });
      return {
        kind: "ok" as const,
        output: { score: result.score, reason: result.reason },
      };
    },
  });
  if (scored.execution.kind === "failed") return;

  // --- 1b. Fit gate -------------------------------------------------------
  //
  // Scoring is worthless if the plan ignores the answer. A role that hard-
  // disqualifies the candidate is not worth a tailored resume, an LLM call, or
  // a recruiter's attention, so the plan stops here rather than spending three
  // more model calls to send an application that cannot succeed.
  //
  // `force` exists because the score is a model judgement, not a fact: the user
  // can always overrule it from the dashboard.
  const effectiveScore =
    scored.execution.kind === "ok" ? scored.execution.output.score : job.score;

  if (
    input.force !== true &&
    effectiveScore !== null &&
    effectiveScore < tuning.fitMinScore
  ) {
    await executeStep(ledger, {
      tool: "score_job",
      app: "local",
      input: {
        jobId: job.id,
        score: effectiveScore,
        floor: tuning.fitMinScore,
      },
      run: async () => ({
        kind: "halt" as const,
        reason: `Fit ${effectiveScore}/100 is below the ${tuning.fitMinScore} floor. Nothing was tailored or sent — re-run with force to override.`,
      }),
    });
    ledger.haltedReason = `Fit ${effectiveScore}/100 below the ${tuning.fitMinScore} floor`;
    return;
  }

  // --- 2. Tailor ----------------------------------------------------------
  const tailored = await executeStep(ledger, {
    tool: "tailor_resume",
    app: "llm",
    input: { jobId: job.id },
    maxAttempts: 2,
    run: async () => {
      const result = await tailorResume({ job, profile, llm });
      repos.jobs.update(job.id, {
        tailoredHeadline: result.headline,
        tailoredSummary: result.summary,
        tailoredSkills: result.skills,
      });
      return { kind: "ok" as const, output: result };
    },
  });
  if (tailored.execution.kind === "failed") return;
  const tailoredData =
    tailored.execution.kind === "ok" ? tailored.execution.output : null;

  // --- 3. Render ----------------------------------------------------------
  const template = selectedResumeTemplate(repos.settings);
  const rendered = await executeStep(ledger, {
    tool: "render_resume_pdf",
    app: "local",
    input: { jobId: job.id, template },
    run: async () => {
      // Tracked links are minted before the render, so the PDF that goes out
      // carries the tokens whose clicks drive the follow-up cadence.
      const withTracking = deps.baseUrl
        ? applyTracerLinks({
            profile,
            jobId: job.id,
            repos,
            baseUrl: deps.baseUrl,
          })
        : profile;

      const result = await renderResumePdf({
        profile: withTracking,
        tailored: {
          headline: tailoredData?.headline ?? null,
          summary: tailoredData?.summary ?? null,
          skills: tailoredData?.skills ?? null,
        },
        template,
        outputPath: resumeOutputPath(job.id),
      });
      repos.jobs.update(job.id, { resumePath: result.pdfPath });
      return {
        kind: "ok" as const,
        output: {
          pdfPath: result.pdfPath,
          pageCount: result.pageCount,
          template: result.template,
        },
      };
    },
  });
  // Narrowing on the discriminant gives a typed `output`; the render step has
  // no skip or halt path, so anything other than `ok` ends the plan.
  if (rendered.execution.kind !== "ok") return;
  const { pdfPath } = rendered.execution.output;

  // --- 4. Verify (hard gate) ---------------------------------------------
  const verified = await executeStep(ledger, {
    tool: "verify_resume",
    app: "local",
    input: { pdfPath, atsMinScore: tuning.atsMinScore },
    run: async () => {
      const ats = await scoreAtsComplianceForPdf(pdfPath, {
        threshold: tuning.atsMinScore,
      });

      // The fabrication gate compares generated prose against the profile, so
      // an invented metric or employer cannot reach a recruiter.
      const generatedText = [
        tailoredData?.headline ?? "",
        tailoredData?.summary ?? "",
        ...(tailoredData?.skills ?? []).flatMap((group) => group.keywords),
      ].join("\n");
      const facts = verifyDocumentFacts({
        generated: generatedText,
        sources: [JSON.stringify(profile)],
      });

      // Severity split. A claim the profile does not support is a lie and must
      // never reach a recruiter, so it halts the plan. A forbidden filler
      // phrase is a style defect: worth reporting, not worth abandoning a
      // verified application over. Conflating the two made the gate block on
      // "passionate about", which is the wrong trade.
      const fabrications = facts.violations.filter(
        (violation) => violation.kind !== "forbidden_phrase",
      );
      const styleWarnings = facts.violations.filter(
        (violation) => violation.kind === "forbidden_phrase",
      );

      const output = { ats, facts, fabrications, styleWarnings };
      if (!ats.passed) {
        return {
          kind: "halt" as const,
          reason: `Resume failed the ATS gate (${ats.score}/100, needs ${tuning.atsMinScore}). Nothing was sent.`,
          output,
        };
      }
      if (fabrications.length > 0) {
        return {
          kind: "halt" as const,
          reason: `Tailored copy contains ${fabrications.length} claim(s) the profile does not support: ${fabrications
            .map((violation) => violation.claim)
            .join(", ")}. Nothing was sent.`,
          output,
        };
      }
      return { kind: "ok" as const, output };
    },
  });
  if (verified.execution.kind === "failed") return;
  if (verified.execution.kind === "halt") {
    logger.warn("Apply-For-Me halted at the verification gate", {
      runId: ledger.runId,
      reason: verified.execution.reason,
    });
    return;
  }

  // --- 5. Draft outreach --------------------------------------------------
  // The caller may name a recipient; absent that, the posting's own address —
  // parsed at ingest or confirmed by the user — is the only other honest
  // source. No address means no outreach step at all, rather than an invented
  // one.
  const contactEmail = input.contactEmail?.trim() || job.contactEmail;
  let draft: OutboundEmailRequest | null = null;

  if (contactEmail) {
    const drafted = await executeStep(ledger, {
      tool: "draft_outreach_email",
      app: "llm",
      input: { jobId: job.id, to: contactEmail },
      maxAttempts: 2,
      run: async () => {
        const email = await draftOutreachEmail({
          job,
          profile,
          tailoredHeadline: tailoredData?.headline ?? null,
          to: contactEmail,
          resumePath: pdfPath,
          llm,
        });
        return { kind: "ok" as const, output: email };
      },
    });
    if (drafted.execution.kind === "ok") draft = drafted.execution.output;

    // Composio's Gmail takes an attachment only as a pre-uploaded S3 object,
    // and that upload route rejects a consumer key outright — so on this
    // transport the résumé cannot ride along as a file. Rather than fail the
    // send or silently drop the résumé, mint the app's own tracked link and
    // put it in the body: the recruiter still gets the résumé, and an open
    // becomes a view count on the pipeline card.
    if (
      draft &&
      draft.attachments &&
      draft.attachments.length > 0 &&
      providerAuthMode("gmail_send", { repos }) === "composio"
    ) {
      const baseUrl = getConfig().baseUrl;
      const link = repos.resumeLinks.create({
        jobId: job.id,
        label: `${job.company} — résumé`,
        destinationUrl: `${baseUrl}/api/jobs/${job.id}/resume.pdf`,
      });
      const { attachments: _unsupported, ...rest } = draft;
      draft = {
        ...rest,
        body: `${draft.body}\n\nRésumé: ${baseUrl}/r/${link.token}`,
      };
    }
  }

  // --- 6. Send (approval gated) ------------------------------------------
  if (draft) {
    if (mode === "dry_run") {
      await executeStep(ledger, {
        tool: "send_outreach_email",
        app: "gmail",
        input: draft,
        idempotencyKey: null,
        run: async () => ({
          kind: "skip" as const,
          reason:
            "dry_run mode: the message was drafted and verified but not sent.",
        }),
      });
    } else {
      // Live mode still never sends unattended. The step parks with its full
      // payload so a human approves the exact bytes that would go out.
      parkStepForApproval(ledger, {
        tool: "send_outreach_email",
        app: "gmail",
        input: draft,
        idempotencyKey: stepKey("send_outreach_email", [
          job.id,
          draft.to,
          draft.subject,
        ]),
      });
    }
  }

  // --- 7. Record the application locally ---------------------------------
  const recorded = await executeStep(ledger, {
    tool: "record_application",
    app: "local",
    input: { jobId: job.id },
    idempotencyKey: stepKey("record_application", [job.id]),
    run: async () => {
      repos.jobs.update(job.id, {
        status: "applied",
        appliedAt: nowIso(),
        resumePath: pdfPath,
      });
      const event = repos.stages.append({ jobId: job.id, toStage: "applied" });
      return {
        kind: "ok" as const,
        output: { stageEventId: event.id, stage: event.toStage },
      };
    },
  });
  if (recorded.execution.kind === "failed") return;

  // --- 8 & 9. Mirror to Sheets and Notion --------------------------------
  // One snapshot for both destinations: pushing the same rows is what makes the
  // two apps verifiably consistent instead of two independent reads.
  const snapshot = buildCommandCenterSnapshot(repos);
  const connectorDeps = { repos, fetchImpl: deps.fetchImpl };

  for (const provider of ["google_sheets", "notion"] as const) {
    await executeStep(ledger, {
      tool: provider === "google_sheets" ? "push_sheets" : "push_notion",
      app: provider,
      input: { provider, jobId: job.id },
      maxAttempts: 2,
      run: async () => {
        const result = await pushCommandCenter(
          { providers: [provider], trigger: "agent", snapshot },
          connectorDeps,
        );
        const skipped = result.skipped.find(
          (entry) => entry.provider === provider,
        );
        if (skipped) return { kind: "skip" as const, reason: skipped.reason };

        const report = result.reports.find(
          (candidate) => candidate.provider === provider,
        );
        if (!report) throw badRequest(`${provider} returned no push report.`);
        if (report.failures.length > 0) {
          throw badRequest(
            `${provider}: ${report.failures[0]?.errorMessage} (${report.failures.length} row(s) failed)`,
          );
        }
        return {
          kind: "ok" as const,
          output: {
            destinationUrl: report.destinationUrl,
            created: report.results.filter((r) => r.outcome === "created")
              .length,
            updated: report.results.filter((r) => r.outcome === "updated")
              .length,
            unchanged: report.results.filter((r) => r.outcome === "unchanged")
              .length,
          },
        };
      },
    });
  }

  // --- 10. Schedule the follow-up ----------------------------------------
  await executeStep(ledger, {
    tool: "schedule_follow_up",
    app: "local",
    input: { jobId: job.id },
    idempotencyKey: stepKey("schedule_follow_up", [job.id]),
    run: async () => {
      // Engagement shortens the cadence: a resume already opened twice earns a
      // faster nudge than one nobody has looked at.
      const views = repos.resumeLinks.viewStatsByJob().get(job.id)?.views ?? 0;
      const engaged = views >= ENGAGED_VIEW_THRESHOLD;
      // The engaged cadence is a ceiling, not a replacement: a user who sets a
      // one-day delay must not get a *slower* nudge for an opened resume.
      const delayDays = engaged
        ? Math.min(ENGAGED_FOLLOW_UP_DELAY_DAYS, tuning.followUpDelayDays)
        : tuning.followUpDelayDays;
      const dueAt = new Date(Date.now() + delayDays * DAY_MS).toISOString();
      const reason = engaged
        ? `Resume opened ${views}x with no reply — nudge in ${delayDays}d`
        : `No reply expected yet — standard ${delayDays}d cadence`;

      const task = repos.tasks.create({
        jobId: job.id,
        type: "follow_up",
        title: `Follow up with ${job.company} re: ${job.title}`,
        dueAt,
        isCompleted: false,
        reason,
      });
      return {
        kind: "ok" as const,
        output: { title: task.title, dueAt, reason, views },
      };
    },
  });
}

/**
 * Approve or deny a parked step and, on approval, perform the effect.
 *
 * Sending happens here rather than in the plan so the irreversible action is
 * always attributable to a named decision.
 */
export async function decideAgentStep(
  input: {
    stepId: string;
    decision: AgentStepDecision;
    decidedBy: string;
  },
  deps: AgentDeps,
): Promise<AgentRunDetail> {
  const agent = deps.repos.agent;
  const step = agent.getStep(input.stepId);
  if (!step) throw notFound(`Agent step ${input.stepId} not found.`);
  if (step.status !== "awaiting_approval") {
    throw badRequest(
      `Step ${step.id} is ${step.status}, not awaiting approval.`,
    );
  }

  const runDetail = (): AgentRunDetail => {
    const detail = agent.getRunDetail(step.runId);
    if (!detail) throw notFound(`Agent run ${step.runId} not found.`);
    return detail;
  };

  if (input.decision === "deny") {
    agent.updateStep({
      id: step.id,
      status: "denied",
      decidedAt: nowIso(),
      decidedBy: input.decidedBy,
    });
    agent.updateRun({
      id: step.runId,
      status: "completed",
      completedAt: nowIso(),
      errorMessage: "Outreach denied by reviewer; nothing was sent.",
    });
    return runDetail();
  }

  if (step.tool !== "send_outreach_email") {
    throw badRequest(`No approval handler for tool ${step.tool}.`);
  }

  const startedMs = Date.now();
  try {
    const result = await sendOutboundEmail(step.input as OutboundEmailRequest, {
      repos: deps.repos,
      fetchImpl: deps.fetchImpl,
    });
    const at = nowIso();
    agent.updateStep({
      id: step.id,
      status: "succeeded",
      output: result,
      attempts: 1,
      durationMs: Date.now() - startedMs,
      completedAt: at,
      decidedAt: at,
      decidedBy: input.decidedBy,
    });
    agent.updateRun({ id: step.runId, status: "completed", completedAt: at });
  } catch (error) {
    const appError = toAppError(error);
    const at = nowIso();
    agent.updateStep({
      id: step.id,
      status: "failed",
      attempts: 1,
      durationMs: Date.now() - startedMs,
      completedAt: at,
      decidedAt: at,
      decidedBy: input.decidedBy,
      errorCode: appError.code,
      errorMessage: appError.message,
    });
    agent.updateRun({
      id: step.runId,
      status: "failed",
      completedAt: at,
      errorCode: appError.code,
      errorMessage: appError.message,
    });
  }

  return runDetail();
}
