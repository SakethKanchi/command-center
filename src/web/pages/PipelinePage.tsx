import type { AgentRunDetail, AgentStepDecision } from "@domain";
import { PageHeader } from "@web/components/Header";
import {
  ApplicationLane,
  FollowUpLane,
  InterviewLane,
  OpportunityLane,
} from "@web/components/Lanes";
import { RunTrace, TracePlaceholder } from "@web/components/RunTrace";
import { StatTiles, StatTilesSkeleton } from "@web/components/StatTiles";
import {
  describeError,
  ErrorBanner,
  formatCount,
  Panel,
  PanelHead,
  SkeletonPanel,
  useResource,
} from "@web/components/ui";
import type { SnapshotResponse } from "@web/lib/api";
import { api } from "@web/lib/api";
import { formatDuration } from "@web/lib/format";
import { Loader2, RefreshCw } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

const LANES = [
  { id: "opportunities", label: "Opportunities" },
  { id: "applications", label: "Applications" },
  { id: "interviews", label: "Interviews" },
  { id: "follow_ups", label: "Follow-ups" },
] as const;

type LaneId = (typeof LANES)[number]["id"];

/** Live progress cadence for a run that takes 30-90 seconds to finish. */
const POLL_MS = 1500;

function readLane(value: string | null): LaneId {
  const match = LANES.find((lane) => lane.id === value);
  return match ? match.id : "opportunities";
}

/**
 * The four lanes of the pipeline, plus the trace of whatever the agent is doing
 * to them right now.
 *
 * The selected lane lives in `?lane=` rather than in component state: a
 * reloaded page and a pasted link both have to land on the same tab, and
 * "screenshot the interviews lane and send it to me" has to be possible.
 */
export function PipelinePage() {
  const [params, setParams] = useSearchParams();
  const lane = readLane(params.get("lane"));

  const [run, setRun] = useState<AgentRunDetail | null>(null);
  const [applyingJobId, setApplyingJobId] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [deciding, setDeciding] = useState<{
    stepId: string;
    decision: AgentStepDecision;
  } | null>(null);

  /**
   * Hard guards against a double submit. React state is batched, so two clicks
   * in one tick would both observe the idle state; a ref settles synchronously
   * and is what actually stops the second POST. It matters most for the send
   * decision, which is the one irreversible call in the app.
   */
  const applyLock = useRef(false);
  const decideLock = useRef(false);

  const loadSnapshot = useCallback(() => api.snapshot(), []);
  const snapshot = useResource<SnapshotResponse>(loadSnapshot);

  // While a run is in flight the server has already persisted its steps, so
  // polling the detail turns a 60-second wait into a trace that fills in.
  useEffect(() => {
    if (applyingJobId === null) return;
    const startedAt = Date.now();
    let cancelled = false;

    const timer = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
      void (async () => {
        try {
          const { runs: latest } = await api.runs(3);
          if (cancelled) return;
          const live = latest[0];
          if (!live) return;
          const detail = await api.run(live.id);
          if (!cancelled) setRun(detail.run);
        } catch {
          // A dropped poll is not worth surfacing: the awaited apply call is
          // the authority on whether the run succeeded.
        }
      })();
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [applyingJobId]);

  const selectLane = (next: LaneId) => {
    // `replace` so flipping through four tabs does not bury the page the user
    // arrived from under four history entries.
    const updated = new URLSearchParams(params);
    updated.set("lane", next);
    setParams(updated, { replace: true });
  };

  const tablist = useRef<HTMLDivElement>(null);

  const handleTablistKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = LANES.findIndex((entry) => entry.id === lane);
    const index =
      event.key === "ArrowRight"
        ? (current + 1) % LANES.length
        : event.key === "ArrowLeft"
          ? (current - 1 + LANES.length) % LANES.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? LANES.length - 1
              : -1;
    const next = index < 0 ? undefined : LANES[index];
    if (!next) return;
    event.preventDefault();
    selectLane(next.id);
    // Focus follows selection: the ARIA pattern for automatic-activation tabs,
    // and the only way arrow keys feel like arrow keys.
    tablist.current
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [index]?.focus();
  };

  const handleApply = async (jobId: string) => {
    if (applyLock.current) return;
    applyLock.current = true;
    setApplyingJobId(jobId);
    setElapsedMs(0);
    setActionError(null);
    setNotice(null);
    try {
      const result = await api.apply({ jobId, mode: "dry_run" });
      setRun(result.run);
      await snapshot.reload();
    } catch (cause) {
      setActionError(describeError(cause));
    } finally {
      applyLock.current = false;
      setApplyingJobId(null);
    }
  };

  const handleDecision = async (
    stepId: string,
    decision: AgentStepDecision,
  ) => {
    if (decideLock.current) return;
    decideLock.current = true;
    setDeciding({ stepId, decision });
    setActionError(null);
    try {
      const result = await api.decide(stepId, decision);
      setRun(result.run);
      setNotice(
        decision === "approve"
          ? "Outreach sent."
          : "Outreach denied. Nothing was sent.",
      );
      await snapshot.reload();
    } catch (cause) {
      setActionError(describeError(cause));
    } finally {
      decideLock.current = false;
      setDeciding(null);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await api.sync();
      const written = result.reports.reduce(
        (total, report) =>
          total +
          report.results.filter((entry) => entry.outcome !== "unchanged")
            .length,
        0,
      );
      const failed = result.reports.reduce(
        (total, report) => total + report.failures.length,
        0,
      );
      setNotice(
        `Pushed ${formatCount(written)} row${written === 1 ? "" : "s"} to ${formatCount(result.reports.length)} app${result.reports.length === 1 ? "" : "s"}${failed > 0 ? `, ${formatCount(failed)} failed` : ""}${result.skipped.length > 0 ? `, ${formatCount(result.skipped.length)} not connected` : ""}.`,
      );
      await snapshot.reload();
    } catch (cause) {
      setActionError(describeError(cause));
    } finally {
      setSyncing(false);
    }
  };

  const data = snapshot.data;
  const rows = data?.snapshot;
  const laneCounts: Record<LaneId, number> = {
    opportunities: data?.summary.opportunities ?? 0,
    applications: data?.summary.applications ?? 0,
    interviews: data?.summary.interviews ?? 0,
    follow_ups: data?.summary.followUps ?? 0,
  };
  const error = actionError ?? snapshot.error;

  return (
    <>
      <PageHeader
        title="Pipeline"
        subtitle="Every role you are tracking, in the lane it has reached. Hand one to the agent and watch the trace fill in beside it."
        actions={
          <>
            {notice ? (
              <span className="u-mono text-[11.5px] text-ink-dim">
                {notice}
              </span>
            ) : null}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleSync()}
              disabled={syncing}
            >
              {syncing ? (
                <Loader2 className="spin size-3.5" aria-hidden />
              ) : (
                <RefreshCw className="size-3.5" aria-hidden />
              )}
              {syncing ? "Syncing…" : "Push to apps"}
            </button>
          </>
        }
      />

      <div className="flex flex-col gap-6">
        {error ? (
          <ErrorBanner message={error} onRetry={() => void snapshot.reload()} />
        ) : null}

        {data ? (
          <StatTiles summary={data.summary} snapshot={data.snapshot} />
        ) : (
          <StatTilesSkeleton />
        )}

        {/* items-start: each panel takes its natural height, so neither column
            stretches to the other and clips its own scroll area.

            The base `grid-cols-[minmax(0,1fr)]` is load-bearing, not decoration:
            a bare single-column grid track is `auto`-sized, so one long job
            title forces the track past the viewport and pushes the row actions
            off-screen. Explicit minmax(0,...) lets the track shrink and the
            `truncate` inside actually take effect. */}
        <div className="grid items-start gap-6 grid-cols-[minmax(0,1fr)] xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
          {rows ? (
            <Panel>
              <h2 className="sr-only">Pipeline lanes</h2>
              {/* Roving tabindex: one stop in the Tab order, arrows move
                  between lanes. Without it a keyboard user has to press Tab
                  four times to reach the rows. */}
              <div
                ref={tablist}
                role="tablist"
                aria-label="Pipeline lanes"
                onKeyDown={handleTablistKey}
                className="flex flex-wrap gap-x-7 gap-y-0 border-b border-ridge px-4"
              >
                {LANES.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="tab"
                    id={`lane-tab-${entry.id}`}
                    className="tab"
                    aria-selected={lane === entry.id}
                    aria-controls="lane-panel"
                    tabIndex={lane === entry.id ? 0 : -1}
                    onClick={() => selectLane(entry.id)}
                  >
                    {entry.label}
                    <span className="text-ink-faint tabular-nums">
                      {formatCount(laneCounts[entry.id])}
                    </span>
                  </button>
                ))}
              </div>

              <div
                id="lane-panel"
                role="tabpanel"
                aria-labelledby={`lane-tab-${lane}`}
                className="max-h-[600px] overflow-y-auto"
              >
                {lane === "opportunities" ? (
                  <OpportunityLane
                    rows={rows.opportunities}
                    applyingJobId={applyingJobId}
                    runInFlight={applyingJobId !== null}
                    onApply={(jobId) => void handleApply(jobId)}
                  />
                ) : null}
                {lane === "applications" ? (
                  <ApplicationLane rows={rows.applications} />
                ) : null}
                {lane === "interviews" ? (
                  <InterviewLane rows={rows.interviews} />
                ) : null}
                {lane === "follow_ups" ? (
                  <FollowUpLane rows={rows.followUps} />
                ) : null}
              </div>
            </Panel>
          ) : (
            <SkeletonPanel label="Pipeline lanes" rows={6} />
          )}

          <div className="xl:sticky xl:top-6">
            {run ? (
              <RunTrace
                run={run}
                deciding={deciding}
                onDecide={(stepId, decision) =>
                  void handleDecision(stepId, decision)
                }
              />
            ) : applyingJobId ? (
              <Panel>
                <PanelHead
                  title="Agent run trace"
                  aside={
                    <span className="u-meta text-signal tabular-nums">
                      Working · {formatDuration(elapsedMs)}
                    </span>
                  }
                />
                <p className="px-4 py-10 text-center text-ink-dim">
                  The agent is scoring the role, tailoring and verifying the
                  resume, then writing to your apps. Steps appear here as they
                  land.
                </p>
              </Panel>
            ) : (
              <div className="flex flex-col gap-3">
                <TracePlaceholder />
                <p className="u-mono text-[11.5px] text-ink-faint">
                  Past runs live on{" "}
                  <Link
                    to="/runs"
                    className="rounded-sm text-ink-dim underline decoration-ridge-hi underline-offset-3 hover:text-ink hover:decoration-signal"
                  >
                    the Runs page
                  </Link>
                  .
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
