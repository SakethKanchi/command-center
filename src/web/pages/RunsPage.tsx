import type { AgentRun, AgentRunDetail } from "@domain";
import { PageHeader } from "@web/components/Header";
import { RunList } from "@web/components/RunList";
import { RunTrace } from "@web/components/RunTrace";
import {
  describeError,
  EmptyState,
  ErrorBanner,
  formatCount,
  Panel,
  PanelHead,
  Skeleton,
  SkeletonPanel,
  useResource,
} from "@web/components/ui";
import { api } from "@web/lib/api";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

/**
 * The audit trail. Every run the agent has made, and the full step trace of
 * whichever one is selected.
 *
 * Selection is a route param, not state: `/runs/run_7` has to be a link you can
 * paste into a bug report, and the back button has to walk back through the
 * runs you looked at.
 */
export function RunsPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();

  const [detail, setDetail] = useState<AgentRunDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const loadRuns = useCallback(() => api.runs(50), []);
  const runs = useResource<{ runs: AgentRun[] }>(loadRuns);

  useEffect(() => {
    if (!runId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    void (async () => {
      try {
        const result = await api.run(runId);
        if (cancelled) return;
        setDetail(result.run);
        setDetailError(null);
      } catch (cause) {
        if (cancelled) return;
        setDetail(null);
        setDetailError(describeError(cause));
      } finally {
        if (!cancelled) setLoadingDetail(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const rows = runs.data?.runs ?? [];

  return (
    <>
      <PageHeader
        title="Runs"
        subtitle="Every tool call the agent made, in order, stamped with the system it touched. This is the receipt for anything that landed in your apps."
        actions={
          rows.length > 0 ? (
            <span className="u-mono text-[12px] text-ink-dim tabular-nums">
              {formatCount(rows.length)} recorded
            </span>
          ) : null
        }
      />

      <div className="flex flex-col gap-6">
        {runs.error ? (
          <ErrorBanner
            message={runs.error}
            onRetry={() => void runs.reload()}
          />
        ) : null}

        <div className="grid items-start gap-6 grid-cols-[minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          {runs.data ? (
            <Panel>
              <PanelHead
                title="Agent runs"
                aside={
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void runs.reload()}
                    disabled={runs.loading}
                  >
                    {runs.loading ? "Refreshing…" : "Refresh"}
                  </button>
                }
              />
              {rows.length === 0 ? (
                <EmptyState headline="No runs yet. Hand a role to the agent on the Pipeline page and its full step trace is kept here.">
                  <Link to="/pipeline" className="btn btn-primary">
                    Open the pipeline
                  </Link>
                </EmptyState>
              ) : (
                <div className="max-h-[640px] overflow-y-auto">
                  <RunList
                    runs={rows}
                    selectedId={runId ?? null}
                    onSelect={(id) => navigate(`/runs/${id}`)}
                  />
                </div>
              )}
            </Panel>
          ) : (
            <SkeletonPanel label="Agent runs" rows={5} />
          )}

          <div className="xl:sticky xl:top-6">
            {detailError ? (
              <Panel>
                <PanelHead title="Agent run trace" />
                <EmptyState headline={detailError}>
                  <Link to="/runs" className="btn">
                    Back to all runs
                  </Link>
                </EmptyState>
              </Panel>
            ) : loadingDetail && !detail ? (
              <TraceSkeleton />
            ) : detail ? (
              // Read-only history: a decision made here would be a second
              // chance to send mail that was already decided on.
              <RunTrace run={detail} deciding={null} onDecide={() => {}} />
            ) : (
              <Panel>
                <PanelHead title="Agent run trace" />
                <EmptyState
                  headline={
                    rows.length === 0
                      ? "Once the agent runs, its trace appears here — every step, every system, every duration."
                      : "Pick a run on the left to read its trace. The URL changes with it, so you can link straight to one."
                  }
                />
              </Panel>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Mirrors the trace: header, run summary line, then the step spine. The widths
 * vary and double as keys, so the placeholder reads as six unwritten steps
 * rather than a striped rectangle.
 */
const STEP_WIDTHS = [
  "w-[55%]",
  "w-[68%]",
  "w-[42%]",
  "w-[61%]",
  "w-[49%]",
  "w-[64%]",
] as const;

function TraceSkeleton() {
  return (
    <Panel aria-busy="true">
      <PanelHead
        title="Agent run trace"
        aside={<span className="u-meta text-ink-faint">Loading…</span>}
      />
      <div className="border-b border-ridge px-4 py-3">
        <Skeleton className="h-3.5 w-[min(70%,22rem)]" />
        <Skeleton className="mt-2.5 h-2.5 w-[min(50%,16rem)]" />
      </div>
      <div className="grid gap-4 px-4 py-4">
        {STEP_WIDTHS.map((width) => (
          <div key={width} className="flex items-start gap-3">
            <Skeleton className="size-[18px] shrink-0 rounded-xs" />
            <div className="min-w-0 flex-1">
              <Skeleton className={`h-3 max-w-[18rem] ${width}`} />
              <Skeleton className="mt-2 h-2.5 w-[min(35%,11rem)]" />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
