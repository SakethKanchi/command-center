import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ApiApp, createApp } from "@server/api/app";
import { type Db, openDatabase } from "@server/db";
import type { LlmClient } from "@server/llm";
import { createConfiguredLlmClient } from "@server/llm/configured";
import { createRepos, type RepoBundle } from "@server/repos";
import { readAgentSettings, readLlmSettings } from "@server/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let db: Db;
let repos: RepoBundle;
let app: ApiApp;

const llm: LlmClient = {
  model: "test-model",
  completeJson: async () => {
    throw new Error("no model call expected in these tests");
  },
};

/** Restored by `vi.unstubAllEnvs` so one test's provider cannot leak. */
function noEnv(): void {
  vi.stubEnv("LLM_BASE_URL", "");
  vi.stubEnv("LLM_MODEL", "");
  vi.stubEnv("LLM_API_KEY", "");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "command-center-settings-"));
  db = openDatabase(join(dir, "t.db"));
  repos = createRepos(db);
  app = createApp({ repos, llm, baseUrl: "http://localhost:8787" });
  noEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("effective configuration", () => {
  it("prefers a stored value over the environment", () => {
    vi.stubEnv("LLM_MODEL", "env/model");
    expect(readLlmSettings(repos.settings).model).toBe("env/model");

    repos.settings.set("llm.model", "stored/model");
    const settings = readLlmSettings(repos.settings);

    expect(settings.model).toBe("stored/model");
    expect(settings.modelSource).toBe("setting");
  });

  it("falls back to the environment when the stored value is cleared", () => {
    vi.stubEnv("LLM_MODEL", "env/model");
    repos.settings.set("llm.model", "stored/model");
    repos.settings.set("llm.model", null);

    const settings = readLlmSettings(repos.settings);
    expect(settings.model).toBe("env/model");
    expect(settings.modelSource).toBe("env");
  });

  it("reports the key as configured without ever exposing it", () => {
    repos.settings.set("llm.apiKey", "sk-secret-value-9876");

    const settings = readLlmSettings(repos.settings);
    expect(settings.apiKeyConfigured).toBe(true);
    expect(settings.apiKeyHint).toBe("9876");
    expect(JSON.stringify(settings)).not.toContain("sk-secret-value");
  });

  it("reads a stored threshold outside its bounds as the default", () => {
    // A value that cannot be saved through the API can still exist in the
    // table — an old build, a manual edit. The agent has to keep running.
    repos.settings.set("agent.atsMinScore", "900");
    repos.settings.set("agent.fitMinScore", "not a number");

    expect(readAgentSettings(repos.settings)).toEqual({
      fitMinScore: 20,
      atsMinScore: 70,
      followUpDelayDays: 5,
    });
  });
});

describe("the configured model client", () => {
  it("picks up a model change without being rebuilt", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init) => {
      calls.push(
        JSON.parse(String((init as RequestInit).body)).model as string,
      );
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    repos.settings.set("llm.apiKey", "sk-test");
    repos.settings.set("llm.model", "first/model");
    const client = createConfiguredLlmClient(repos.settings, { fetchImpl });

    const schema = { name: "t", schema: { type: "object" } };
    await client.completeJson({ prompt: "hi", schema });
    repos.settings.set("llm.model", "second/model");
    await client.completeJson({ prompt: "hi", schema });

    expect(calls).toEqual(["first/model", "second/model"]);
    expect(client.model).toBe("second/model");
  });

  it("refuses to call anything when no key is configured", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = createConfiguredLlmClient(repos.settings, { fetchImpl });

    await expect(
      client.completeJson({ prompt: "hi", schema: { name: "t", schema: {} } }),
    ).rejects.toThrow(/Settings/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("settings endpoints", () => {
  const patch = (path: string, body: unknown) =>
    app.request(path, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });

  it("leaves an omitted field alone and clears an explicit null", async () => {
    await patch("/api/settings/llm", {
      model: "stored/model",
      apiKey: "sk-stored-1234",
    });

    const changed = (await (
      await patch("/api/settings/llm", { model: "other/model" })
    ).json()) as { data: { llm: { apiKeyConfigured: boolean } } };
    expect(changed.data.llm.apiKeyConfigured).toBe(true);

    const cleared = (await (
      await patch("/api/settings/llm", { apiKey: null })
    ).json()) as {
      data: { llm: { apiKeyConfigured: boolean; model: string } };
    };
    expect(cleared.data.llm.apiKeyConfigured).toBe(false);
    expect(cleared.data.llm.model).toBe("other/model");
  });

  it("rejects a threshold outside its bounds without storing it", async () => {
    const res = await patch("/api/settings/agent", { atsMinScore: 10 });

    expect(res.status).toBe(400);
    expect(readAgentSettings(repos.settings).atsMinScore).toBe(70);
  });

  it("lists provider models for a base URL that is not saved yet", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://other.example/v1/models");
      return new Response(
        JSON.stringify({ data: [{ id: "z/model" }, { id: "a/model" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const withFetch = createApp({
      repos,
      llm,
      baseUrl: "http://localhost:8787",
      fetchImpl,
    });

    const res = await withFetch.request(
      "/api/settings/llm/models?baseUrl=https://other.example/v1/",
    );
    const body = (await res.json()) as {
      data: { models: Array<{ id: string }> };
    };

    expect(body.data.models.map((model) => model.id)).toEqual([
      "a/model",
      "z/model",
    ]);
  });

  it("reports a refused key as a test result, not a failed request", async () => {
    repos.settings.set("llm.apiKey", "sk-wrong");
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "bad key" } }), {
          status: 401,
        }),
    ) as unknown as typeof fetch;
    const withFetch = createApp({
      repos,
      llm,
      baseUrl: "http://localhost:8787",
      fetchImpl,
    });

    const res = await withFetch.request("/api/settings/llm/test", {
      method: "POST",
      body: "{}",
    });
    const body = (await res.json()) as {
      ok: boolean;
      data: { ok: boolean; message: string };
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.ok).toBe(false);
    expect(body.data.message).toMatch(/key/i);
  });
});
