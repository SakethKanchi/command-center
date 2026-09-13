import type { CommandCenterSnapshot } from "@domain";
import type { LaneSummary } from "@web/lib/api";
import { formatRelative, pluralize } from "@web/lib/format";
import { formatCount, Skeleton } from "./ui";

/**
 * An instrument cluster, not four cards: one surface split by hairlines, so the
 * four numbers read as one reading of the pipeline. Each subtitle is derived
 * from the snapshot rather than decorative — the number alone does not say
 * whether anything is worth acting on.
 */
export function StatTiles({
  summary,
  snapshot,
  now = Date.now(),
}: {
  summary: LaneSummary;
  snapshot: CommandCenterSnapshot;
  now?: number;
}) {
  const scores = snapshot.opportunities
    .map((row) => row.score)
    .filter((score): score is number => typeof score === "number");
  const topScore = scores.length > 0 ? Math.max(...scores) : null;

  const resumeOpens = snapshot.applications.reduce(
    (total, row) => total + (row.resumeViews ?? 0),
    0,
  );

  const [nextInterviewAt] = snapshot.interviews
    .map((row) => new Date(row.scheduledAt).getTime())
    .filter((time) => Number.isFinite(time) && time >= now)
    .sort((a, b) => a - b);

  const dueSoon = snapshot.followUps.filter((row) => {
    if (row.isCompleted || !row.dueDate) return false;
    const due = new Date(row.dueDate).getTime();
    return Number.isFinite(due) && due - now <= 7 * 24 * 60 * 60 * 1000;
  }).length;

  const tiles = [
    {
      label: "Opportunities",
      value: summary.opportunities,
      note: topScore === null ? "Not scored yet" : `Top fit ${topScore}/100`,
    },
    {
      label: "Applications",
      value: summary.applications,
      note:
        resumeOpens === 0
          ? "No resume opens yet"
          : `${resumeOpens} resume ${pluralize(resumeOpens, "open")}`,
    },
    {
      label: "Interviews",
      value: summary.interviews,
      note:
        nextInterviewAt === undefined
          ? "None scheduled"
          : `Next ${formatRelative(new Date(nextInterviewAt).toISOString(), now)}`,
    },
    {
      label: "Follow-ups",
      value: summary.followUps,
      note:
        dueSoon === 0 ? "Nothing due this week" : `${dueSoon} due this week`,
    },
  ];

  return (
    // A 1px grid gap over a ridge-coloured ground draws every hairline without
    // a per-cell border rule that has to know the column count.
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-ridge bg-ridge lg:grid-cols-4">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          data-testid={`tile-${tile.label.toLowerCase()}`}
          className="bg-panel px-5 py-4"
        >
          <p className="u-meta text-ink-faint">{tile.label}</p>
          <p className="u-numeral mt-2 text-[2.75rem] text-ink">
            {formatCount(tile.value)}
          </p>
          <p className="mt-1.5 text-[13px] text-ink-dim">{tile.note}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * The cluster before the numbers arrive. Same grid, same four cells, same
 * heights — so the page does not reflow the moment the snapshot lands.
 */
export function StatTilesSkeleton() {
  return (
    <div
      aria-busy="true"
      className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-ridge bg-ridge lg:grid-cols-4"
    >
      {["Opportunities", "Applications", "Interviews", "Follow-ups"].map(
        (label) => (
          <div key={label} className="bg-panel px-5 py-4">
            <p className="u-meta text-ink-faint">{label}</p>
            <Skeleton className="mt-2 h-[2.75rem] w-16" />
            <Skeleton className="mt-2.5 h-3 w-28" />
          </div>
        ),
      )}
    </div>
  );
}
