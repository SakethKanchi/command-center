/**
 * Process lifecycle: reconcile interrupted work, then shut down in order.
 *
 * The agent writes its own run bookkeeping — `createRun` inserts `running` and
 * every terminal path in `apply-for-me.ts` calls `updateRun` with `completed`,
 * `failed` or `awaiting_approval`. A run interrupted between those two points
 * (SIGTERM during a deploy, or a hard kill) leaves the row at `running` with no
 * `completed_at` and no reason, which reads as "still working" forever in the
 * UI and in `/api/agent/runs`. Nothing else ever cleans that up, so this module
 * does: on the way down for the signals we can handle, and on the way up for
 * the ones we cannot.
 */

import { nowIso } from "@server/db";
import { logger } from "@server/infra/logger";
import type { RepoBundle } from "@server/repos";

/** The slice of `node:http`'s Server that a shutdown needs. */
export type ServerLike = {
  close(callback?: (error?: Error) => void): unknown;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
};

export type ReconcileResult = {
  readonly agentRuns: number;
  readonly syncRuns: number;
};

/**
 * Mark every run still sitting at `running` as failed, with a reason.
 *
 * Safe to call at boot: a `running` row at that moment cannot belong to this
 * process, because nothing has started a run yet.
 */
export function failInterruptedRuns(
  repos: RepoBundle,
  reason: string,
): ReconcileResult {
  const at = nowIso();
  const dangling = repos.agent.listRuns({ status: ["running"] });
  for (const run of dangling) {
    repos.agent.updateRun({
      id: run.id,
      status: "failed",
      completedAt: at,
      errorCode: "UNAVAILABLE",
      errorMessage: reason,
    });
  }

  // `listSyncRuns` has no status filter and this table holds one row per manual
  // or agent push, so scanning it is cheaper than widening the repo API.
  const syncRuns = repos.connectors
    .listSyncRuns()
    .filter((run) => run.status === "running");
  for (const run of syncRuns) {
    repos.connectors.finishSyncRun({
      id: run.id,
      status: "failed",
      errorCode: "UNAVAILABLE",
      errorMessage: reason,
    });
  }

  return { agentRuns: dangling.length, syncRuns: syncRuns.length };
}

export type ShutdownDeps = {
  server: ServerLike;
  repos: RepoBundle;
  /** Injected so tests do not have to close the process-wide handle. */
  closeDatabase: () => void;
  /** How long in-flight requests get before their sockets are destroyed. */
  timeoutMs: number;
  exit?: (code: number) => void;
  signals?: readonly NodeJS.Signals[];
};

const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

/** The routine a signal handler runs; returned so callers can trigger it. */
export type ShutdownRoutine = (
  signal: string,
  exitCode?: number,
) => Promise<void>;

/**
 * Register signal handlers and return the shutdown routine itself.
 *
 * Order matters and is the whole point: stop accepting, drain, reconcile,
 * close the database. Reconciling before the drain would mark a run failed that
 * is about to finish normally; closing the database before the drain would make
 * an in-flight request throw on a closed handle.
 *
 * The exit code is 0 for a clean stop, including one that had to cut sockets at
 * the deadline — a slow client is not this server failing. It is 1 only when a
 * step throws, or when a second signal arrives and the operator has said twice
 * that they want the process gone.
 */
export function installShutdownHandlers(deps: ShutdownDeps): ShutdownRoutine {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;

  const drain = () =>
    new Promise<"drained" | "timeout">((resolve) => {
      const timer = setTimeout(() => {
        // Keep-alive sockets with no request on them are already gone; these
        // are requests that genuinely did not finish in time.
        deps.server.closeAllConnections?.();
        resolve("timeout");
      }, deps.timeoutMs);
      timer.unref();

      deps.server.close(() => {
        clearTimeout(timer);
        resolve("drained");
      });
      // `close` stops the listener but waits on idle keep-alive sockets, which
      // a browser holds open for a minute. Without this the drain always hits
      // the deadline.
      deps.server.closeIdleConnections?.();
    });

  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      logger.warn("Second signal during shutdown, exiting now", { signal });
      exit(1);
      return;
    }
    shuttingDown = true;

    const startedMs = Date.now();
    logger.info("Shutdown started", { signal, timeoutMs: deps.timeoutMs });

    try {
      const outcome = await drain();
      if (outcome === "timeout") {
        logger.warn("Drain deadline reached, closing remaining connections", {
          timeoutMs: deps.timeoutMs,
        });
      } else {
        logger.info("Connections drained");
      }

      const reconciled = failInterruptedRuns(
        deps.repos,
        `Server shut down on ${signal} while the run was in progress.`,
      );
      if (reconciled.agentRuns > 0 || reconciled.syncRuns > 0) {
        logger.warn("Marked interrupted runs as failed", reconciled);
      }

      deps.closeDatabase();
      logger.info("Shutdown complete", {
        signal,
        durationMs: Date.now() - startedMs,
      });
      exit(exitCode);
    } catch (error) {
      logger.error("Shutdown failed", {
        signal,
        message: error instanceof Error ? error.message : String(error),
      });
      exit(1);
    }
  };

  for (const signal of deps.signals ?? DEFAULT_SIGNALS) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  // A crash that reaches here has already skipped every `finally` in the
  // request path, so the reconcile matters more than usual. Exiting non-zero
  // lets a supervisor restart us.
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", {
      message: error.message,
      stack: error.stack,
    });
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection", {
      message: reason instanceof Error ? reason.message : String(reason),
    });
    void shutdown("unhandledRejection", 1);
  });

  return shutdown;
}
