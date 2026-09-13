import { randomUUID } from "node:crypto";
import type {
  AgentApp,
  AgentRun,
  AgentRunDetail,
  AgentRunMode,
  AgentRunStatus,
  AgentStep,
  AgentStepStatus,
  AgentTool,
} from "@domain";
import { AGENT_APPROVAL_REQUIRED_TOOLS } from "@domain";
import {
  type Db,
  fromSqliteBool,
  nowIso,
  parseJsonColumn,
  toSqliteBool,
} from "@server/db";

export type AgentRunFilter = {
  jobId?: string;
  status?: AgentRunStatus[];
  limit?: number;
};

export type AgentRepo = {
  createRun(input: {
    jobId?: string | null;
    goal: string;
    mode?: AgentRunMode;
  }): AgentRun;
  getRun(id: string): AgentRun | null;
  /** The run plus its steps in execution order — the audit view. */
  getRunDetail(id: string): AgentRunDetail | null;
  listRuns(filter?: AgentRunFilter): AgentRun[];
  updateRun(input: {
    id: string;
    status?: AgentRunStatus;
    completedAt?: string | null;
    stepsTotal?: number;
    stepsSucceeded?: number;
    stepsFailed?: number;
    stepsSkipped?: number;
    llmCalls?: number;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): AgentRun | null;
  createStep(input: {
    runId: string;
    tool: AgentTool;
    app?: AgentApp;
    /** Omitted means "append": the next free seq in the run. */
    seq?: number;
    status?: AgentStepStatus;
    requiresApproval?: boolean;
    idempotencyKey?: string | null;
    input?: unknown;
  }): AgentStep;
  getStep(id: string): AgentStep | null;
  listStepsForRun(runId: string): AgentStep[];
  updateStep(input: {
    id: string;
    status?: AgentStepStatus;
    input?: unknown;
    output?: unknown;
    attempts?: number;
    durationMs?: number | null;
    startedAt?: string | null;
    completedAt?: string | null;
    decidedAt?: string | null;
    decidedBy?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): AgentStep | null;
  findSucceededStepByIdempotencyKey(input: {
    tool: AgentTool;
    idempotencyKey: string;
  }): AgentStep | null;
  listStepsAwaitingApproval(): AgentStep[];
};

type AgentRunRow = {
  id: string;
  job_id: string | null;
  goal: string;
  mode: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  steps_total: number;
  steps_succeeded: number;
  steps_failed: number;
  steps_skipped: number;
  llm_calls: number;
  error_code: string | null;
  error_message: string | null;
};

type AgentStepRow = {
  id: string;
  run_id: string;
  seq: number;
  tool: string;
  app: string;
  status: string;
  requires_approval: number;
  idempotency_key: string | null;
  input: string | null;
  output: string | null;
  attempts: number;
  duration_ms: number | null;
  started_at: string | null;
  completed_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  error_code: string | null;
  error_message: string | null;
};

type Bindable = string | number | null;

function mapRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    jobId: row.job_id,
    goal: row.goal,
    mode: row.mode as AgentRunMode,
    status: row.status as AgentRunStatus,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    stepsTotal: Number(row.steps_total),
    stepsSucceeded: Number(row.steps_succeeded),
    stepsFailed: Number(row.steps_failed),
    stepsSkipped: Number(row.steps_skipped),
    llmCalls: Number(row.llm_calls),
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

function mapStep(row: AgentStepRow): AgentStep {
  return {
    id: row.id,
    runId: row.run_id,
    seq: Number(row.seq),
    tool: row.tool as AgentTool,
    app: row.app as AgentApp,
    status: row.status as AgentStepStatus,
    requiresApproval: fromSqliteBool(row.requires_approval) ?? false,
    idempotencyKey: row.idempotency_key,
    input: parseJsonColumn<unknown>(row.input),
    output: parseJsonColumn<unknown>(row.output),
    attempts: Number(row.attempts),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

export function createAgentRepo(db: Db): AgentRepo {
  const getRun = (id: string): AgentRun | null => {
    const row = db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as
      | unknown
      | undefined;
    return row ? mapRun(row as AgentRunRow) : null;
  };

  const getStep = (id: string): AgentStep | null => {
    const row = db.prepare("SELECT * FROM agent_steps WHERE id = ?").get(id) as
      | unknown
      | undefined;
    return row ? mapStep(row as AgentStepRow) : null;
  };

  const listStepsForRun = (runId: string): AgentStep[] => {
    const rows = db
      .prepare("SELECT * FROM agent_steps WHERE run_id = ? ORDER BY seq ASC")
      .all(runId) as unknown as AgentStepRow[];
    return rows.map(mapStep);
  };

  return {
    createRun(input) {
      const run: AgentRun = {
        id: randomUUID(),
        jobId: input.jobId ?? null,
        goal: input.goal,
        mode: input.mode ?? "dry_run",
        status: "running",
        startedAt: nowIso(),
        completedAt: null,
        stepsTotal: 0,
        stepsSucceeded: 0,
        stepsFailed: 0,
        stepsSkipped: 0,
        llmCalls: 0,
        errorCode: null,
        errorMessage: null,
      };

      db.prepare(
        `INSERT INTO agent_runs (id, job_id, goal, mode, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(run.id, run.jobId, run.goal, run.mode, run.status, run.startedAt);
      return run;
    },

    getRun,

    getRunDetail(id) {
      const run = getRun(id);
      return run ? { ...run, steps: listStepsForRun(id) } : null;
    },

    listRuns(filter = {}) {
      const clauses: string[] = [];
      const params: Bindable[] = [];
      if (filter.jobId) {
        clauses.push("job_id = ?");
        params.push(filter.jobId);
      }
      if (filter.status && filter.status.length > 0) {
        clauses.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
        params.push(...filter.status);
      }

      const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
      let sql = `SELECT * FROM agent_runs${where} ORDER BY started_at DESC, rowid DESC`;
      if (filter.limit !== undefined) {
        sql += " LIMIT ?";
        params.push(filter.limit);
      }

      const rows = db.prepare(sql).all(...params) as unknown as AgentRunRow[];
      return rows.map(mapRun);
    },

    updateRun(input) {
      const assignments: string[] = [];
      const params: Bindable[] = [];
      const set = (column: string, value: Bindable) => {
        assignments.push(`${column} = ?`);
        params.push(value);
      };

      if (input.status !== undefined) set("status", input.status);
      if (input.completedAt !== undefined)
        set("completed_at", input.completedAt);
      if (input.stepsTotal !== undefined) set("steps_total", input.stepsTotal);
      if (input.stepsSucceeded !== undefined) {
        set("steps_succeeded", input.stepsSucceeded);
      }
      if (input.stepsFailed !== undefined)
        set("steps_failed", input.stepsFailed);
      if (input.stepsSkipped !== undefined) {
        set("steps_skipped", input.stepsSkipped);
      }
      if (input.llmCalls !== undefined) set("llm_calls", input.llmCalls);
      if (input.errorCode !== undefined) set("error_code", input.errorCode);
      if (input.errorMessage !== undefined) {
        set("error_message", input.errorMessage);
      }
      if (assignments.length === 0) return getRun(input.id);

      params.push(input.id);
      const result = db
        .prepare(`UPDATE agent_runs SET ${assignments.join(", ")} WHERE id = ?`)
        .run(...params);
      return result.changes === 0 ? null : getRun(input.id);
    },

    createStep(input) {
      // Always returns exactly one row; the cast names a shape SQLite cannot
      // describe to the compiler.
      const seqRow = db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM agent_steps WHERE run_id = ?",
        )
        .get(input.runId) as unknown as { next: number } | undefined;
      const nextSeq = input.seq ?? Number(seqRow?.next ?? 1);

      const step: AgentStep = {
        id: randomUUID(),
        runId: input.runId,
        seq: nextSeq,
        tool: input.tool,
        app: input.app ?? "local",
        status: input.status ?? "pending",
        // Defaulted from domain policy, not from the caller's memory: a
        // forgotten flag here is what would let an outreach email leave
        // without a human decision.
        requiresApproval:
          input.requiresApproval ??
          AGENT_APPROVAL_REQUIRED_TOOLS.includes(input.tool),
        idempotencyKey: input.idempotencyKey ?? null,
        input: input.input ?? null,
        output: null,
        attempts: 0,
        durationMs: null,
        startedAt: null,
        completedAt: null,
        decidedAt: null,
        decidedBy: null,
        errorCode: null,
        errorMessage: null,
      };

      db.prepare(
        `INSERT INTO agent_steps
           (id, run_id, seq, tool, app, status, requires_approval, idempotency_key, input)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        step.id,
        step.runId,
        step.seq,
        step.tool,
        step.app,
        step.status,
        toSqliteBool(step.requiresApproval) ?? 0,
        step.idempotencyKey,
        step.input === null ? null : JSON.stringify(step.input),
      );
      return step;
    },

    getStep,

    listStepsForRun,

    updateStep(input) {
      const assignments: string[] = [];
      const params: Bindable[] = [];
      const set = (column: string, value: Bindable) => {
        assignments.push(`${column} = ?`);
        params.push(value);
      };

      if (input.status !== undefined) set("status", input.status);
      if (input.input !== undefined) {
        set("input", input.input === null ? null : JSON.stringify(input.input));
      }
      if (input.output !== undefined) {
        set(
          "output",
          input.output === null ? null : JSON.stringify(input.output),
        );
      }
      if (input.attempts !== undefined) set("attempts", input.attempts);
      if (input.durationMs !== undefined) set("duration_ms", input.durationMs);
      if (input.startedAt !== undefined) set("started_at", input.startedAt);
      if (input.completedAt !== undefined)
        set("completed_at", input.completedAt);
      if (input.decidedAt !== undefined) set("decided_at", input.decidedAt);
      if (input.decidedBy !== undefined) set("decided_by", input.decidedBy);
      if (input.errorCode !== undefined) set("error_code", input.errorCode);
      if (input.errorMessage !== undefined) {
        set("error_message", input.errorMessage);
      }
      if (assignments.length === 0) return getStep(input.id);

      params.push(input.id);
      const result = db
        .prepare(
          `UPDATE agent_steps SET ${assignments.join(", ")} WHERE id = ?`,
        )
        .run(...params);
      return result.changes === 0 ? null : getStep(input.id);
    },

    findSucceededStepByIdempotencyKey(input) {
      // Cross-run replay guard. `idx_agent_steps_idempotency` already forbids a
      // second succeeded row for the pair, so this returns the one prior
      // success; the ordering only makes the read deterministic.
      const row = db
        .prepare(
          `SELECT * FROM agent_steps
           WHERE tool = ? AND idempotency_key = ? AND status = 'succeeded'
           ORDER BY COALESCE(completed_at, started_at, '') DESC, rowid DESC
           LIMIT 1`,
        )
        .get(input.tool, input.idempotencyKey) as unknown | undefined;
      return row ? mapStep(row as AgentStepRow) : null;
    },

    listStepsAwaitingApproval() {
      const rows = db
        .prepare(
          `SELECT * FROM agent_steps
           WHERE status = 'awaiting_approval'
           ORDER BY rowid ASC`,
        )
        .all() as unknown as AgentStepRow[];
      return rows.map(mapStep);
    },
  };
}
