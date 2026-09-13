import type { AgentSettings, AppSettings } from "@domain";
import { request } from "@web/lib/api";

/**
 * The settings screen's transport.
 *
 * Both writes are patches: `undefined` leaves a field alone and `null` clears
 * it back to the environment value. That is the same distinction the server
 * makes, kept intact here rather than flattened into empty strings, because an
 * empty string is how you accidentally erase an API key.
 */

export type SettingsBounds = Record<
  keyof AgentSettings,
  { min: number; max: number }
>;

export type SettingsResponse = {
  settings: AppSettings;
  bounds: SettingsBounds;
};

export function fetchSettings(signal?: AbortSignal): Promise<SettingsResponse> {
  return request<SettingsResponse>(
    "/api/settings",
    signal ? { signal } : undefined,
  );
}

const patch = (body: unknown): RequestInit => ({
  method: "PATCH",
  body: JSON.stringify(body),
});

export type LlmSettingsPatch = {
  baseUrl?: string | null;
  model?: string | null;
  apiKey?: string | null;
};

export function saveLlmSettings(
  body: LlmSettingsPatch,
): Promise<{ llm: AppSettings["llm"] }> {
  return request<{ llm: AppSettings["llm"] }>("/api/settings/llm", patch(body));
}

export function saveAgentSettings(
  body: Partial<AgentSettings>,
): Promise<{ agent: AgentSettings }> {
  return request<{ agent: AgentSettings }>("/api/settings/agent", patch(body));
}

export type ModelOption = { id: string; label: string };

/**
 * `baseUrl` is the one the user has typed, which may not be the saved one yet —
 * listing models for the provider you are switching *to* is the point.
 */
export function fetchModels(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<{ baseUrl: string; models: ModelOption[] }> {
  return request<{ baseUrl: string; models: ModelOption[] }>(
    `/api/settings/llm/models?baseUrl=${encodeURIComponent(baseUrl)}`,
    signal ? { signal } : undefined,
  );
}

export type ConnectionTest = {
  ok: boolean;
  model: string;
  message: string;
  latencyMs?: number;
};

export function testLlmConnection(): Promise<ConnectionTest> {
  return request<ConnectionTest>("/api/settings/llm/test", {
    method: "POST",
    body: "{}",
  });
}
