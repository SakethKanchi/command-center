import type {
  AgentApp,
  AgentRunDetail,
  AgentRunStatus,
  AgentStepDecision,
} from "@domain";
import { APP_PRESENTATION } from "@web/lib/apps";
import { formatElapsed, formatRelative, pluralize } from "@web/lib/format";
import { systemsTouched } from "@web/lib/steps";
import { StepRow } from "./StepRow";
import { Panel, PanelHead } from "./ui";

const RUN_STATUS_LABEL: Record<AgentRunStatus, string> = {
  running: "Running",
  awaiting_approval: "Waiting on you",
  completed: "Complete",
  failed: "Failed",
  cancelled: "Cancelled",
};

const RUN_STATUS_TONE: Record<AgentRunStatus, string> = {
  running: "text-signal",
  awaiting_approval: "text-signal",
  completed: "text-pass",
  failed: "text-alarm",
  cancelled: "text-ink-faint",
};

/**
 * The centrepiece. Every tool call the agent made, in order, stamped with the
 * system it touched — the artifact that makes the run auditable instead of
 * merely plausible.
 */
export function RunTrace({
  run,
  deciding,
  onDecide,
}: {
  run: AgentRunDetail;
  deciding: { stepId: string; decision: AgentStepDecision } | null;
  onDecide: (stepId: string, decision: AgentStepDecision) => void;
}) {
  const systems = systemsTouched(run);
  const longestMs = run.steps.reduce(
    (longest, step) => Math.max(longest, step.durationMs ?? 0),
    0,
  );

  return (
    <Panel>
      <PanelHead
        title="Agent run trace"
        aside={
          <span className="flex items-center gap-2">
            <span className="u-meta rounded-xs border border-ridge-hi px-1.5 py-px text-ink-faint">
              {run.mode === "dry_run" ? "dry run" : "live"}
            </span>
            <span className={`u-meta ${RUN_STATUS_TONE[run.status]}`}>
              {RUN_STATUS_LABEL[run.status]}
            </span>
          </span>
        }
      />

      <div className="border-b border-ridge px-4 py-3">
        <h3 className="u-display text-[15px] leading-snug text-ink">
          {run.goal}
        </h3>
        <p className="u-mono mt-1.5 text-[11.5px] text-ink-faint">
          {formatRelative(run.startedAt)} · {run.stepsTotal}{" "}
          {pluralize(run.stepsTotal, "step")} ·{" "}
          {formatElapsed(run.startedAt, run.completedAt)} · {run.llmCalls}{" "}
          {pluralize(run.llmCalls, "LLM call")}
          {run.stepsFailed > 0 ? ` · ${run.stepsFailed} failed` : ""}
          {run.stepsSkipped > 0 ? ` · ${run.stepsSkipped} skipped` : ""}
        </p>

        {run.errorMessage ? (
          <p className="mt-2 rounded-sm border border-alarm/40 bg-alarm/10 px-2 py-1.5 text-[13px] text-alarm">
            {run.errorMessage}
          </p>
        ) : null}

        <SystemsLegend systems={systems} />
      </div>

      {/* No inner scroll: the trace is read top to bottom, and a nested
          scrollbar would hide the approval step that needs a decision. */}
      <ol>
        {run.steps.map((step, index) => (
          <StepRow
            key={step.id}
            step={step}
            isLast={index === run.steps.length - 1}
            longestMs={longestMs}
            deciding={deciding?.stepId === step.id ? deciding.decision : null}
            onDecide={onDecide}
          />
        ))}
      </ol>
    </Panel>
  );
}

/**
 * Counts the systems the run actually reached. Solid blocks rather than text
 * because this is the claim a judge has two seconds to check.
 */
function SystemsLegend({ systems }: { systems: AgentApp[] }) {
  if (systems.length === 0) return null;
  return (
    <div className="mt-3" data-testid="systems-legend">
      <p className="u-meta text-ink-faint">{systems.length} systems touched</p>
      <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-2">
        {systems.map((app) => (
          <li key={app} data-app={app} className="min-w-[54px]">
            <span className="system-block block w-full" aria-hidden />
            <span className="u-meta mt-1 block text-[10px] text-ink-dim">
              {APP_PRESENTATION[app].label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Idle state for the trace column: what the agent is for, before it runs. */
export function TracePlaceholder() {
  return (
    <Panel className="flex flex-col">
      <PanelHead title="Agent run trace" />
      <div className="px-4 py-5">
        <p className="text-ink-dim">
          Pick a role and press <span className="text-ink">Apply for me</span>.
          Every tool call lands here as it happens.
        </p>
        <ul className="mt-4 grid gap-2.5">
          {Object.entries(APP_PRESENTATION).map(([app, meta]) => (
            <li key={app} data-app={app} className="flex items-start gap-3">
              <span
                className="rail-node mt-0.5 shrink-0"
                data-filled="false"
                aria-hidden
              />
              <span>
                <span className="text-[13.5px] text-ink">{meta.label}</span>
                <span className="block text-[13px] text-ink-faint">
                  {meta.role}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}
