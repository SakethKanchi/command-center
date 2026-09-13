import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ApiApp, createApp } from "@server/api/app";
import { type Db, openDatabase } from "@server/db";
import type { LlmClient } from "@server/llm";
import { createRepos } from "@server/repos";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
let db: Db;
let app: ApiApp;

const llm: LlmClient = {
  model: "test-model",
  completeJson: async () => {
    throw new Error("no model call expected in these tests");
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "command-center-api-"));
  db = openDatabase(join(dir, "t.db"));
  app = createApp({
    repos: createRepos(db),
    llm,
    baseUrl: "http://localhost:8787",
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("API responses", () => {
  it("answers an unknown /api path with the standard JSON error envelope", async () => {
    // Hono's default 404 is plain text. Behind the SPA fallback that surfaced
    // as 200 text/html, so a client typo looked like a malformed payload
    // instead of a wrong URL.
    const res = await app.request("/api/definitely-not-a-route");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "No API route for /api/definitely-not-a-route.",
      },
    });
  });

  it("keeps non-API 404s as plain text for the client shell to handle", async () => {
    const res = await app.request("/some/client/route");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toContain("application/json");
  });

  it("serves health as JSON with a parseable timestamp", async () => {
    const res = await app.request("/health");
    const body = (await res.json()) as { status: string; at: string };

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(Number.isNaN(Date.parse(body.at))).toBe(false);
  });

  it("wraps a successful read in the ok envelope", async () => {
    const res = await app.request("/api/snapshot");
    const body = (await res.json()) as { ok: boolean; data: unknown };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toHaveProperty("snapshot");
  });

  it("rejects an invalid query with a 400 rather than a 500", async () => {
    // limit is bounded; a value past the ceiling is the caller's mistake.
    const res = await app.request("/api/agent/runs?limit=9999");
    const body = (await res.json()) as { ok: boolean; error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("reports a missing run as NOT_FOUND, not as a crash", async () => {
    const res = await app.request("/api/agent/runs/does-not-exist");
    const body = (await res.json()) as { ok: boolean; error: { code: string } };

    expect(res.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
