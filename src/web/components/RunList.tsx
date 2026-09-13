import type { AgentRun, AgentRunStatus } from "@domain";
import { formatElapsed, formatRelative, pluralize } from "@web/lib/format";
import { EmptyState } from "./ui";

const STATUS_TONE: Record<AgentRunStatus, string> = {
  running: "text-signal",
  awaiting_approval: "text-signal",
  completed: "text-pass",
  failed: "text-alarm",
  cancelled: "text-ink-faint",
};

const STATUS_LABEL: Record<AgentRunStatus, string> = {
  running: "Running",
  awaiting_approval: "Waiting on you",
  completed: "Complete",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function RunList({
  runs,
  selectedId,
  onSelect,
}: {
  runs: AgentRun[];
  selectedId: string | null;
  onSelect: (runId: string) => void;
}) {
  if (runs.length === 0) {
    return (
      <EmptyState headline="No runs yet. Every run the agent makes is kept here with its full step trace." />
    );
  }

  return (
    <ul>
      {runs.map((run) => (
        <li key={run.id} className="lane-row">
          <button
            type="button"
            onClick={() => onSelect(run.id)}
            aria-current={run.id === selectedId}
            data-testid={`run-${run.id}`}
            className={`flex w-full items-center gap-4 px-4 py-3 text-left ${run.id === selectedId ? "border-l-2 border-signal bg-panel-hi pl-3.5" : ""}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14.5px] font-medium text-ink">
                {run.goal}
              </span>
              <span className="u-mono mt-0.5 block text-[11.5px] text-ink-faint">
                {run.stepsSucceeded}/{run.stepsTotal}{" "}
                {pluralize(run.stepsTotal, "step")} ·{" "}
                {formatElapsed(run.startedAt, run.completedAt)} ·{" "}
                {formatRelative(run.startedAt)}
                {run.mode === "dry_run" ? " · dry run" : ""}
              </span>
            </span>
            <span className={`u-meta shrink-0 ${STATUS_TONE[run.status]}`}>
              {STATUS_LABEL[run.status]}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
