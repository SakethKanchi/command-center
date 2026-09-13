import { setTimeout as delay } from "node:timers/promises";
import type { AgentApp, AgentStep, AgentTool } from "@domain";
import { nowIso } from "@server/db";
import { toAppError } from "@server/infra/errors";
import { logger } from "@server/infra/logger";
import type { RepoBundle } from "@server/repos";

/**
 * Outcome of one tool call.
 *
 * `halt` is how a verification gate stops the run: the step itself succeeded
 * (the check ran and produced a verdict) but the plan must not continue. That
 * is distinct from `failed`, which means the tool could not run at all.
 */
export type StepExecution<T> =
  | { kind: "ok"; output: T }
  | { kind: "skip"; reason: string }
  | { kind: "halt"; reason: string; output?: T };

export type StepSpec<T> = {
  tool: AgentTool;
  app: AgentApp;
  /**
   * Stable key derived from the tool and the semantic payload. When present, a
   * step that already succeeded under this key is never re-executed; its
   * recorded output is reused. This is what makes retrying a run safe against
   * duplicate emails and duplicate remote rows.
   */
  idempotencyKey?: string | null;
  requiresApproval?: boolean;
  input: unknown;
  /** Attempts for transient failures. 1 means no retry. */
  maxAttempts?: number;
  run: () => Promise<StepExecution<T>>;
};

export type StepRecord<T> = {
  step: AgentStep;
  execution: StepExecution<T> | { kind: "failed"; error: string };
  /** True when the recorded output came from a prior run, not this one. */
  replayed: boolean;
};

/**
 * Mutable state for one run: where to write the trace, and the counters the
 * run summary is built from. Carrying the bundle here rather than threading it
 * through every call site is what keeps the step helpers free of any module
 * singleton.
 */
export type RunLedger = {
  repos: RepoBundle;
  runId: string;
  seq: number;
  succeeded: number;
  failed: number;
  skipped: number;
  llmCalls: number;
  /** Set when a step halted the plan, carrying the reason for the run summary. */
  haltedReason: string | null;
};

const TRANSIENT_BACKOFF_BASE_MS = 400;
const TRANSIENT_BACKOFF_CAP_MS = 4_000;

/**
 * Bounded exponential backoff with full jitter. Jitter matters here because a
 * run can fan several steps at the same external API; synchronized retries
 * would re-collide on the same rate limit.
 */
function backoffDelayMs(attempt: number): number {
  const ceiling = Math.min(
    TRANSIENT_BACKOFF_CAP_MS,
    TRANSIENT_BACKOFF_BASE_MS * 2 ** (attempt - 1),
  );
  return Math.floor(Math.random() * ceiling);
}

/**
 * Execute one planned step, persisting the full trace.
 *
 * Every path through this function leaves the `agent_steps` row in a terminal
 * state with an attempt count and a duration, so the run trace is complete
 * even when a step throws.
 */
export async function executeStep<T>(
  ledger: RunLedger,
  spec: StepSpec<T>,
): Promise<StepRecord<T>> {
  const agent = ledger.repos.agent;
  const seq = ledger.seq++;
  const requiresApproval = spec.requiresApproval ?? false;
  const idempotencyKey = spec.idempotencyKey ?? null;

  const step = agent.createStep({
    runId: ledger.runId,
    seq,
    tool: spec.tool,
    app: spec.app,
    requiresApproval,
    idempotencyKey,
    input: spec.input,
  });

  // Replay guard: reuse a prior success rather than repeating the effect.
  if (idempotencyKey) {
    const prior = agent.findSucceededStepByIdempotencyKey({
      tool: spec.tool,
      idempotencyKey,
    });
    if (prior && prior.id !== step.id) {
      const at = nowIso();
      const updated = agent.updateStep({
        id: step.id,
        status: "skipped",
        output: prior.output,
        attempts: 0,
        durationMs: 0,
        startedAt: at,
        completedAt: at,
        errorCode: null,
        errorMessage: `Replayed from step ${prior.id} (same idempotency key)`,
      });
      ledger.skipped += 1;
      logger.info("Agent step replayed from idempotency ledger", {
        runId: ledger.runId,
        tool: spec.tool,
        priorStepId: prior.id,
      });
      return {
        step: updated ?? step,
        execution: { kind: "ok", output: prior.output as T },
        replayed: true,
      };
    }
  }

  // Elapsed time is measured in millis and stored as `durationMs`; only the
  // wall-clock stamps are ISO, because only those are timestamps.
  const startedMs = Date.now();
  const maxAttempts = Math.max(1, spec.maxAttempts ?? 1);
  let attempts = 0;
  let lastError: unknown = null;

  agent.updateStep({
    id: step.id,
    status: "running",
    startedAt: nowIso(),
  });

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const execution = await spec.run();
      const durationMs = Date.now() - startedMs;

      if (execution.kind === "skip") {
        ledger.skipped += 1;
        const updated = agent.updateStep({
          id: step.id,
          status: "skipped",
          attempts,
          durationMs,
          completedAt: nowIso(),
          errorMessage: execution.reason,
        });
        return { step: updated ?? step, execution, replayed: false };
      }

      if (execution.kind === "halt") {
        // The check ran successfully and its verdict stops the plan.
        ledger.succeeded += 1;
        ledger.haltedReason = execution.reason;
        const updated = agent.updateStep({
          id: step.id,
          status: "succeeded",
          output: execution.output ?? {
            halted: true,
            reason: execution.reason,
          },
          attempts,
          durationMs,
          completedAt: nowIso(),
        });
        return { step: updated ?? step, execution, replayed: false };
      }

      ledger.succeeded += 1;
      if (spec.app === "llm") ledger.llmCalls += 1;
      const updated = agent.updateStep({
        id: step.id,
        status: "succeeded",
        output: execution.output,
        attempts,
        durationMs,
        completedAt: nowIso(),
      });
      return { step: updated ?? step, execution, replayed: false };
    } catch (error) {
      lastError = error;
      if (attempts < maxAttempts) {
        const delayMs = backoffDelayMs(attempts);
        logger.warn("Agent step attempt failed, retrying", {
          runId: ledger.runId,
          tool: spec.tool,
          attempt: attempts,
          delayMs,
          error: toAppError(error).message,
        });
        await delay(delayMs);
      }
    }
  }

  const appError = toAppError(lastError);
  ledger.failed += 1;
  const updated = agent.updateStep({
    id: step.id,
    status: "failed",
    attempts,
    durationMs: Date.now() - startedMs,
    completedAt: nowIso(),
    errorCode: appError.code,
    errorMessage: appError.message,
  });
  logger.error("Agent step failed", {
    runId: ledger.runId,
    tool: spec.tool,
    attempts,
    error: appError.message,
  });
  return {
    step: updated ?? step,
    execution: { kind: "failed", error: appError.message },
    replayed: false,
  };
}

/**
 * Park a step on a human decision instead of executing it.
 *
 * Used for irreversible external effects. The step is written with its full
 * intended input so a reviewer sees exactly what would be sent, and the run
 * ends in `awaiting_approval` rather than guessing on the user's behalf.
 */
export function parkStepForApproval(
  ledger: RunLedger,
  spec: Pick<StepSpec<unknown>, "tool" | "app" | "input" | "idempotencyKey">,
): AgentStep {
  const agent = ledger.repos.agent;
  const seq = ledger.seq++;
  const step = agent.createStep({
    runId: ledger.runId,
    seq,
    tool: spec.tool,
    app: spec.app,
    requiresApproval: true,
    idempotencyKey: spec.idempotencyKey ?? null,
    input: spec.input,
  });

  const parked = agent.updateStep({
    id: step.id,
    status: "awaiting_approval",
  });
  return parked ?? step;
}
