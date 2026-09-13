/**
 * Effective configuration: the stored setting, else the environment, else the
 * built-in default.
 *
 * The precedence is the whole design. `.env` is how the machine is provisioned
 * and how a fresh clone boots; the settings table is how the person using the
 * dashboard changes their mind. A stored value therefore wins — otherwise the
 * screen would offer a control that silently does nothing whenever the variable
 * happens to be set — and clearing a field falls back to the variable rather
 * than to emptiness, so "reset" means "go back to how this box was configured".
 *
 * Everything here reads synchronously because `node:sqlite` is synchronous;
 * that is what lets the LLM client resolve its model on the call path instead
 * of caching a value that a restart is required to change.
 */

import {
  AGENT_SETTING_BOUNDS,
  type AgentSettings,
  type AppSettings,
  DEFAULT_AGENT_SETTINGS,
  type LlmSettings,
  type SettingSource,
} from "@domain";
import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from "@server/llm";
import type { SettingsRepo } from "@server/repos";

export const SETTING_KEYS = {
  llmBaseUrl: "llm.baseUrl",
  llmModel: "llm.model",
  llmApiKey: "llm.apiKey",
  fitMinScore: "agent.fitMinScore",
  atsMinScore: "agent.atsMinScore",
  followUpDelayDays: "agent.followUpDelayDays",
} as const;

/** Trimmed setting value, or null when absent or blank. */
function stored(settings: SettingsRepo, key: string): string | null {
  const value = settings.get(key)?.trim();
  return value === undefined || value === "" ? null : value;
}

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? null : value;
}

type Resolved = { value: string; source: SettingSource };

function resolve(
  settings: SettingsRepo,
  key: string,
  envName: string,
  fallback: string,
): Resolved {
  const fromSetting = stored(settings, key);
  if (fromSetting !== null) return { value: fromSetting, source: "setting" };
  const fromEnv = env(envName);
  if (fromEnv !== null) return { value: fromEnv, source: "env" };
  return { value: fallback, source: "default" };
}

/** Trailing slashes are stripped here so `${baseUrl}/chat/completions` is safe. */
export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * What the client actually calls with, key included.
 *
 * Kept separate from `LlmSettings` because this one carries the secret: it is
 * for the model client and the connection test, never for a response body.
 */
export type LlmRuntimeConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
};

export function resolveLlmConfig(settings: SettingsRepo): LlmRuntimeConfig {
  return {
    baseUrl: normalizeBaseUrl(
      resolve(
        settings,
        SETTING_KEYS.llmBaseUrl,
        "LLM_BASE_URL",
        DEFAULT_LLM_BASE_URL,
      ).value,
    ),
    model: resolve(
      settings,
      SETTING_KEYS.llmModel,
      "LLM_MODEL",
      DEFAULT_LLM_MODEL,
    ).value,
    apiKey: resolve(settings, SETTING_KEYS.llmApiKey, "LLM_API_KEY", "").value,
  };
}

/** The readable shape: provenance for every field, and no key. */
export function readLlmSettings(settings: SettingsRepo): LlmSettings {
  const baseUrl = resolve(
    settings,
    SETTING_KEYS.llmBaseUrl,
    "LLM_BASE_URL",
    DEFAULT_LLM_BASE_URL,
  );
  const model = resolve(
    settings,
    SETTING_KEYS.llmModel,
    "LLM_MODEL",
    DEFAULT_LLM_MODEL,
  );
  const apiKey = resolve(settings, SETTING_KEYS.llmApiKey, "LLM_API_KEY", "");
  const configured = apiKey.value !== "";

  return {
    baseUrl: normalizeBaseUrl(baseUrl.value),
    baseUrlSource: baseUrl.source,
    model: model.value,
    modelSource: model.source,
    apiKeyConfigured: configured,
    apiKeySource: apiKey.source,
    apiKeyHint: configured ? apiKey.value.slice(-4) : null,
  };
}

/**
 * A stored number outside its bounds reads as the default rather than as an
 * error: the agent has to run, and a run that halts at boot because someone
 * typed 900 into a box months ago is worse than one that uses 70.
 */
function readNumber(
  settings: SettingsRepo,
  key: string,
  field: keyof AgentSettings,
): number {
  const raw = stored(settings, key);
  if (raw === null) return DEFAULT_AGENT_SETTINGS[field];
  const parsed = Number(raw);
  const { min, max } = AGENT_SETTING_BOUNDS[field];
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return DEFAULT_AGENT_SETTINGS[field];
  }
  return parsed;
}

export function readAgentSettings(settings: SettingsRepo): AgentSettings {
  return {
    fitMinScore: readNumber(settings, SETTING_KEYS.fitMinScore, "fitMinScore"),
    atsMinScore: readNumber(settings, SETTING_KEYS.atsMinScore, "atsMinScore"),
    followUpDelayDays: readNumber(
      settings,
      SETTING_KEYS.followUpDelayDays,
      "followUpDelayDays",
    ),
  };
}

export function readAppSettings(settings: SettingsRepo): AppSettings {
  return {
    llm: readLlmSettings(settings),
    agent: readAgentSettings(settings),
  };
}

export type LlmSettingsPatch = {
  baseUrl?: string | null;
  model?: string | null;
  apiKey?: string | null;
};

/**
 * `null` clears a field back to the environment value; an absent field is left
 * alone. That distinction is what lets one endpoint serve "change the model",
 * "reset the model" and "leave the key as it is" without three flags.
 */
export function writeLlmSettings(
  settings: SettingsRepo,
  patch: LlmSettingsPatch,
): void {
  if (patch.baseUrl !== undefined) {
    settings.set(
      SETTING_KEYS.llmBaseUrl,
      patch.baseUrl === null ? null : normalizeBaseUrl(patch.baseUrl),
    );
  }
  if (patch.model !== undefined) {
    settings.set(
      SETTING_KEYS.llmModel,
      patch.model === null ? null : patch.model.trim(),
    );
  }
  if (patch.apiKey !== undefined) {
    settings.set(
      SETTING_KEYS.llmApiKey,
      patch.apiKey === null ? null : patch.apiKey.trim(),
    );
  }
}

export function writeAgentSettings(
  settings: SettingsRepo,
  patch: Partial<AgentSettings>,
): void {
  if (patch.fitMinScore !== undefined) {
    settings.set(SETTING_KEYS.fitMinScore, String(patch.fitMinScore));
  }
  if (patch.atsMinScore !== undefined) {
    settings.set(SETTING_KEYS.atsMinScore, String(patch.atsMinScore));
  }
  if (patch.followUpDelayDays !== undefined) {
    settings.set(
      SETTING_KEYS.followUpDelayDays,
      String(patch.followUpDelayDays),
    );
  }
}
