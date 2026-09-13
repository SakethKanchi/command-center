import type {
  ApplicationRow,
  FollowUpRow,
  InterviewRow,
  OpportunityRow,
} from "@domain";
import {
  formatDate,
  formatDateTime,
  formatRelative,
  humanize,
  truncate,
} from "@web/lib/format";
import { CheckCircle2, Eye, Loader2, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState, Meter } from "./ui";

/**
 * Lanes are flight strips, not a data grid: two lines per row, identity on the
 * left and the decision-relevant number on the right. A half-width column on a
 * projector cannot carry six aligned table columns, and the strip keeps the
 * company name large enough to read from the back of a room.
 */
function LaneRow({
  primary,
  secondary,
  trailingTop,
  trailingBottom,
  testId,
}: {
  primary: ReactNode;
  secondary: ReactNode;
  trailingTop?: ReactNode;
  trailingBottom?: ReactNode;
  testId?: string;
}) {
  return (
    <li
      data-testid={testId}
      className="lane-row flex items-center gap-4 px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14.5px] font-medium text-ink">
          {primary}
        </div>
        <div className="mt-0.5 truncate text-[13px] text-ink-dim">
          {secondary}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {trailingTop}
        {trailingBottom ? (
          <span className="u-mono text-[11.5px] text-ink-faint">
            {trailingBottom}
          </span>
        ) : null}
      </div>
    </li>
  );
}

export function OpportunityLane({
  rows,
  applyingJobId,
  runInFlight,
  onApply,
}: {
  rows: OpportunityRow[];
  applyingJobId: string | null;
  runInFlight: boolean;
  onApply: (jobId: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        headline="No opportunities yet. Press Discover on the Search screen and they land here."
        action="npm run seed"
      />
    );
  }

  return (
    <ul>
      {rows.map((row) => {
        const applying = applyingJobId === row.jobId;
        return (
          <LaneRow
            key={row.key}
            testId={`opportunity-${row.jobId}`}
            primary={row.company}
            secondary={
              <>
                {row.role}
                {row.location ? ` · ${row.location}` : ""}
                {row.isRemote ? " · remote" : ""}
              </>
            }
            trailingTop={
              <div className="flex items-center gap-3">
                {row.score === null ? (
                  <span className="u-mono text-[11.5px] text-ink-faint">
                    unscored
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <span className="u-numeral text-[17px] text-ink">
                      {row.score}
                    </span>
                    <Meter value={row.score} />
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => onApply(row.jobId)}
                  disabled={runInFlight}
                  aria-label={`Apply for me: ${row.role} at ${row.company}`}
                >
                  {applying ? (
                    <Loader2 className="spin size-3.5" aria-hidden />
                  ) : (
                    <Zap className="size-3.5" aria-hidden />
                  )}
                  {applying ? "Working…" : "Apply for me"}
                </button>
              </div>
            }
            trailingBottom={`${row.source}${row.discoveredAt ? ` · found ${formatRelative(row.discoveredAt)}` : ""}`}
          />
        );
      })}
    </ul>
  );
}

/** Offer and closed are the two stages worth colouring; the rest are progress. */
const STAGE_TONE: Record<string, string> = {
  offer: "border-pass/45 text-pass",
  closed: "border-ridge-hi text-ink-faint",
};

export function ApplicationLane({ rows }: { rows: ApplicationRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState headline="Nothing submitted yet. Hand a role to the agent and it shows up here." />
    );
  }

  return (
    <ul>
      {rows.map((row) => (
        <LaneRow
          key={row.key}
          testId={`application-${row.jobId}`}
          primary={row.company}
          secondary={row.role}
          trailingTop={
            <div className="flex items-center gap-3">
              <span
                className={`u-meta rounded-xs border px-1.5 py-px ${STAGE_TONE[row.stage] ?? "border-signal/40 text-signal"}`}
              >
                {humanize(row.stage)}
              </span>
              <span
                className="flex items-center gap-1.5"
                title="Non-bot opens of the submitted resume"
              >
                <Eye
                  className={`size-3.5 ${row.resumeViews > 0 ? "text-signal" : "text-ink-faint"}`}
                  aria-hidden
                />
                <span
                  className={`u-mono text-[12.5px] ${row.resumeViews > 0 ? "text-signal" : "text-ink-faint"}`}
                  data-testid={`resume-views-${row.jobId}`}
                >
                  {row.resumeViews} {row.resumeViews === 1 ? "open" : "opens"}
                </span>
              </span>
            </div>
          }
          trailingBottom={
            row.appliedAt ? `applied ${formatDate(row.appliedAt)}` : undefined
          }
        />
      ))}
    </ul>
  );
}

export function InterviewLane({ rows }: { rows: InterviewRow[] }) {
  if (rows.length === 0) {
    return <EmptyState headline="No interviews on the calendar." />;
  }

  return (
    <ul>
      {rows.map((row) => (
        <LaneRow
          key={row.key}
          testId={`interview-${row.interviewId}`}
          primary={row.company}
          secondary={row.role}
          trailingTop={
            <span className="u-meta rounded-xs border border-ridge-hi px-1.5 py-px text-ink-dim">
              {humanize(row.interviewType)}
            </span>
          }
          trailingBottom={`${formatDateTime(row.scheduledAt)}${row.durationMins ? ` · ${row.durationMins} min` : ""}`}
        />
      ))}
    </ul>
  );
}

export function FollowUpLane({ rows }: { rows: FollowUpRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState headline="No follow-ups queued. The agent schedules one per application it submits." />
    );
  }

  return (
    <ul>
      {rows.map((row) => (
        <LaneRow
          key={row.key}
          testId={`follow-up-${row.taskId}`}
          primary={
            <span className={row.isCompleted ? "text-ink-faint" : undefined}>
              {truncate(row.title, 80)}
            </span>
          }
          // The reason is the whole point of the lane: it says why the agent
          // thinks now is the moment, not merely that a task exists.
          secondary={row.reason ?? `${row.company} · ${row.role}`}
          trailingTop={
            row.isCompleted ? (
              <span className="u-meta flex items-center gap-1 text-pass">
                <CheckCircle2 className="size-3.5" aria-hidden />
                Done
              </span>
            ) : (
              <span className="u-meta text-signal">
                {row.dueDate ? `due ${formatRelative(row.dueDate)}` : "no date"}
              </span>
            )
          }
          trailingBottom={row.dueDate ? formatDate(row.dueDate) : undefined}
        />
      ))}
    </ul>
  );
}
