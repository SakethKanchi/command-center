/**
 * Settings endpoints: read everything, write one group at a time.
 *
 * The two write routes are `PATCH`-shaped on purpose — an omitted field is
 * untouched, an explicit `null` clears the stored value back to whatever the
 * environment says. A `PUT` of the whole object would make "save the model" and
 * "wipe the API key" the same request, which is exactly the accident worth
 * designing out of a screen that holds a credential.
 *
 * `models` and `test` exist because a model id is free text a provider either
 * accepts or does not. Listing lets the user pick a real one, and the test is
 * the only honest answer to "did that work" — it spends one tiny completion
 * against the configuration as it would actually be used, rather than checking
 * that a string is non-empty.
 */

import { AGENT_SETTING_BOUNDS } from "@domain";
import type { ApiDeps } from "@server/api/app";
import { ok } from "@server/api/respond";
import { badRequest, toAppError, upstreamError } from "@server/infra/errors";
import { createLlmClient } from "@server/llm";
import {
  readAgentSettings,
  readAppSettings,
  readLlmSettings,
  resolveLlmConfig,
  writeAgentSettings,
  writeLlmSettings,
} from "@server/settings";
import { Hono } from "hono";
import { z } from "zod";

/** `null` clears; an absent key is left alone. */
const nullableText = (max: number) =>
  z.string().trim().min(1).max(max).nullable().optional();

const llmBody = z.object({
  baseUrl: z
    .string()
    .trim()
    .url("baseUrl must be an absolute URL.")
    .max(500)
    .nullable()
    .optional(),
  model: nullableText(200),
  apiKey: nullableText(500),
});

const bounded = (field: keyof typeof AGENT_SETTING_BOUNDS) =>
  z.coerce
    .number()
    .int()
    .min(AGENT_SETTING_BOUNDS[field].min)
    .max(AGENT_SETTING_BOUNDS[field].max)
    .optional();

const agentBody = z.object({
  fitMinScore: bounded("fitMinScore"),
  atsMinScore: bounded("atsMinScore"),
  followUpDelayDays: bounded("followUpDelayDays"),
});

async function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  raw: unknown,
): Promise<z.infer<T>> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw badRequest(
      result.error.issues[0]?.message ?? "Invalid settings.",
      result.error.flatten(),
    );
  }
  return result.data;
}

const MODEL_LIST_TIMEOUT_MS = 15_000;

/** One provider model as a picker needs it: an id, and a name if there is one. */
type ModelOption = { id: string; label: string };

const modelListSchema = z.object({
  data: z
    .array(z.object({ id: z.string().min(1), name: z.string().optional() }))
    .default([]),
});

/**
 * The OpenAI-compatible `/models` call.
 *
 * A provider that does not implement it is not broken — plenty of local
 * runtimes do not — so the failure is reported as a message the screen shows
 * beside a still-editable text field, never as a dead end.
 */
async function listProviderModels(
  config: { baseUrl: string; apiKey: string },
  fetchImpl: typeof fetch,
): Promise<ModelOption[]> {
  const response = await fetchImpl(`${config.baseUrl}/models`, {
    headers: {
      accept: "application/json",
      ...(config.apiKey === ""
        ? {}
        : { authorization: `Bearer ${config.apiKey}` }),
    },
    signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw upstreamError(
      `The provider answered ${response.status} for its model list.`,
    );
  }

  const parsed = modelListSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw upstreamError("The provider's model list was not in a known shape.");
  }

  return parsed.data.data
    .map((entry) => ({ id: entry.id, label: entry.name ?? entry.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The smallest structured call that still proves the whole path works. */
const TEST_SCHEMA = {
  name: "connection_test",
  schema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
} as const;

export function createSettingsRoutes(deps: ApiDeps): Hono {
  const routes = new Hono();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  routes.get("/settings", (c) =>
    ok(c, {
      settings: readAppSettings(deps.repos.settings),
      bounds: AGENT_SETTING_BOUNDS,
    }),
  );

  routes.patch("/settings/llm", async (c) => {
    const patch = await parseBody(
      llmBody,
      await c.req.json().catch(() => null),
    );
    writeLlmSettings(deps.repos.settings, patch);
    return ok(c, { llm: readLlmSettings(deps.repos.settings) });
  });

  routes.patch("/settings/agent", async (c) => {
    const patch = await parseBody(
      agentBody,
      await c.req.json().catch(() => null),
    );
    writeAgentSettings(deps.repos.settings, patch);
    return ok(c, { agent: readAgentSettings(deps.repos.settings) });
  });

  /**
   * `?baseUrl=` lets the screen list models for an endpoint the user has typed
   * but not yet saved — picking a model from the provider you are about to
   * switch to is the whole point.
   */
  routes.get("/settings/llm/models", async (c) => {
    const saved = resolveLlmConfig(deps.repos.settings);
    const requested = c.req.query("baseUrl")?.trim();
    const baseUrl =
      requested === undefined || requested === ""
        ? saved.baseUrl
        : requested.replace(/\/+$/, "");

    const models = await listProviderModels(
      { baseUrl, apiKey: saved.apiKey },
      fetchImpl,
    );
    return ok(c, { baseUrl, models });
  });

  /**
   * Answers with `{ ok: true, ... }` for a working configuration and
   * `{ ok: false, message }` for a provider that refused — a rejected key is a
   * fact about the settings, not a failure of the request that asked.
   */
  routes.post("/settings/llm/test", async (c) => {
    const config = resolveLlmConfig(deps.repos.settings);
    if (config.apiKey === "") {
      return ok(c, {
        ok: false,
        model: config.model,
        message: "No API key is configured, so nothing was called.",
      });
    }

    const started = Date.now();
    try {
      await createLlmClient({ ...config, fetchImpl }).completeJson({
        prompt: 'Reply with {"ok": true} and nothing else.',
        schema: TEST_SCHEMA,
        maxAttempts: 1,
      });
      return ok(c, {
        ok: true,
        model: config.model,
        latencyMs: Date.now() - started,
        message: `${config.model} answered in ${Date.now() - started}ms.`,
      });
    } catch (error) {
      return ok(c, {
        ok: false,
        model: config.model,
        message: toAppError(error).message,
      });
    }
  });

  return routes;
}
