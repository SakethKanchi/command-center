import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, openDatabase } from "@server/db";
import { ConfigError, loadConfig, maskSecret } from "@server/infra/config";
import { notFound, toAppError, toPublicError } from "@server/infra/errors";
import {
  failInterruptedRuns,
  installShutdownHandlers,
} from "@server/infra/lifecycle";
import { createRepos, type RepoBundle } from "@server/repos";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The `ConfigError` a bad environment produces, or a failure if it started. */
function rejection(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected loadConfig to reject this environment");
}

describe("environment configuration", () => {
  it("names the offending variable instead of starting with a bad value", () => {
    const error = rejection({ PORT: "notanumber" });

    expect(error.issues).toEqual(["PORT: must be a whole number, digits only"]);
    expect(error.message).toContain("PORT");
  });

  it("reports every bad variable at once", () => {
    const error = rejection({
      PORT: "0",
      LOG_LEVEL: "verbose",
      PUBLIC_BASE_URL: "localhost:8787",
    });

    expect(error.issues.map((issue) => issue.split(":")[0])).toEqual([
      "LOG_LEVEL",
      "PORT",
      "PUBLIC_BASE_URL",
    ]);
  });

  it("starts with no credentials at all", () => {
    const config = loadConfig({});

    expect(config.credentials).toEqual({
      llmApiKey: false,
      composioApiKey: false,
    });
    expect(config.port).toBe(8787);
    expect(config.baseUrl).toBe("http://localhost:8787");
  });

  it("treats a blank assignment as absent rather than as an empty value", () => {
    const config = loadConfig({ COMPOSIO_API_KEY: "  ", DATA_DIR: "" });

    expect(config.credentials.composioApiKey).toBe(false);
    expect(config.paths.dataDir).toBeUndefined();
  });

  it("binds every interface in production and loopback elsewhere", () => {
    expect(loadConfig({ NODE_ENV: "production" }).host).toBe("0.0.0.0");
    expect(loadConfig({}).host).toBe("127.0.0.1");
    expect(loadConfig({ NODE_ENV: "production", HOST: "::1" }).host).toBe(
      "::1",
    );
  });

  it("defaults to machine-readable logs only in production", () => {
    expect(loadConfig({ NODE_ENV: "production" }).log.format).toBe("json");
    expect(loadConfig({}).log.format).toBe("text");
    expect(
      loadConfig({ NODE_ENV: "production", LOG_FORMAT: "text" }).log.format,
    ).toBe("text");
  });

  it("refuses to hand out a mutable config", () => {
    const config: { port: number } = loadConfig({});

    expect(() => {
      config.port = 1;
    }).toThrow(TypeError);
  });

  it("never reveals a whole secret", () => {
    expect(maskSecret("uak_abcdefghijklmnop")).toBe("uak_…mnop (20 chars)");
    expect(maskSecret("short")).toBe("set (5 chars)");
    expect(maskSecret(undefined)).toBe("unset");
    expect(maskSecret("")).toBe("unset");
  });
});

describe("error bodies", () => {
  it("hides an unexpected throw behind the code when redacting", () => {
    const error = toAppError(
      new Error("SQLITE_CANTOPEN: /home/op/secret/data.db"),
    );

    expect(toPublicError(error, { redactInternal: true })).toEqual({
      code: "INTERNAL",
      message: "Internal server error.",
    });
  });

  it("passes a message this server wrote on purpose through", () => {
    const error = notFound("No API route for /api/nope.");

    expect(toPublicError(error, { redactInternal: true })).toEqual({
      code: "NOT_FOUND",
      message: "No API route for /api/nope.",
    });
  });

  it("keeps the internal text outside production, where it is the point", () => {
    const error = toAppError(new Error("ledger seq went backwards"));

    expect(toPublicError(error, { redactInternal: false })).toEqual({
      code: "INTERNAL",
      message: "ledger seq went backwards",
      details: { name: "Error" },
    });
  });
});

describe("interrupted runs", () => {
  let dir: string;
  let db: Db;
  let repos: RepoBundle;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "command-center-lifecycle-"));
    db = openDatabase(join(dir, "t.db"));
    repos = createRepos(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("finalizes a run left at running, with a reason", () => {
    const run = repos.agent.createRun({ goal: "apply to something" });
    const sync = repos.connectors.startSyncRun({
      connectorId: null,
      provider: "notion",
    });

    const result = failInterruptedRuns(repos, "Server shut down mid-run.");

    expect(result).toEqual({ agentRuns: 1, syncRuns: 1 });
    const finalized = repos.agent.getRun(run.id);
    expect(finalized?.status).toBe("failed");
    expect(finalized?.completedAt).not.toBeNull();
    expect(finalized?.errorMessage).toBe("Server shut down mid-run.");
    expect(
      repos.connectors.listSyncRuns().find((row) => row.id === sync.id)?.status,
    ).toBe("failed");
  });

  it("leaves a finished run alone", () => {
    const run = repos.agent.createRun({ goal: "done already" });
    repos.agent.updateRun({
      id: run.id,
      status: "completed",
      completedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(failInterruptedRuns(repos, "irrelevant")).toEqual({
      agentRuns: 0,
      syncRuns: 0,
    });
    expect(repos.agent.getRun(run.id)?.status).toBe("completed");
    expect(repos.agent.getRun(run.id)?.errorMessage).toBeNull();
  });

  it("drains, reconciles, closes the database and exits zero, in that order", async () => {
    const order: string[] = [];
    const run = repos.agent.createRun({ goal: "in flight" });
    const codes: number[] = [];

    const shutdown = installShutdownHandlers({
      server: {
        close: (callback) => {
          order.push("close");
          callback?.();
        },
        closeIdleConnections: () => order.push("closeIdle"),
      },
      repos,
      closeDatabase: () => order.push("closeDatabase"),
      timeoutMs: 50,
      exit: (code) => codes.push(code),
      signals: [],
    });

    await shutdown("SIGTERM");

    expect(order).toEqual(["close", "closeIdle", "closeDatabase"]);
    expect(codes).toEqual([0]);
    expect(repos.agent.getRun(run.id)?.status).toBe("failed");
    expect(repos.agent.getRun(run.id)?.errorMessage).toContain("SIGTERM");
  });

  it("cuts remaining sockets at the deadline and still exits zero", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const codes: number[] = [];

    const shutdown = installShutdownHandlers({
      server: {
        // A request that never finishes: the callback is never invoked.
        close: () => events.push("close"),
        closeIdleConnections: () => events.push("closeIdle"),
        closeAllConnections: () => events.push("closeAll"),
      },
      repos,
      closeDatabase: () => events.push("closeDatabase"),
      timeoutMs: 5_000,
      exit: (code) => codes.push(code),
      signals: [],
    });

    const finished = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(5_000);
    await finished;
    vi.useRealTimers();

    expect(events).toEqual(["close", "closeIdle", "closeAll", "closeDatabase"]);
    expect(codes).toEqual([0]);
  });

  it("exits non-zero when a shutdown step fails", async () => {
    const codes: number[] = [];
    const shutdown = installShutdownHandlers({
      server: {
        close: (callback) => callback?.(),
      },
      repos,
      closeDatabase: () => {
        throw new Error("sqlite handle busy");
      },
      timeoutMs: 50,
      exit: (code) => codes.push(code),
      signals: [],
    });

    await shutdown("SIGTERM");

    expect(codes).toEqual([1]);
  });

  it("exits non-zero on a second signal rather than waiting again", async () => {
    const codes: number[] = [];
    let release: (() => void) | undefined;
    const shutdown = installShutdownHandlers({
      server: {
        close: (callback) => {
          release = () => callback?.();
        },
      },
      repos,
      closeDatabase: () => undefined,
      timeoutMs: 10_000,
      exit: (code) => codes.push(code),
      signals: [],
    });

    const first = shutdown("SIGTERM");
    await shutdown("SIGINT");
    expect(codes).toEqual([1]);

    release?.();
    await first;
    expect(codes).toEqual([1, 0]);
  });
});
