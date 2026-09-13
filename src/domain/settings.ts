/**
 * The settings a user is allowed to change from the dashboard.
 *
 * Two groups, and the split is about blast radius rather than tidiness:
 *
 *  - `llm` is connection state. Getting it wrong means every model call fails
 *    the same way, so the API answers with *where each value came from* — a
 *    stored setting, an environment variable, or the built-in default — because
 *    "the model is wrong" and "the model you set is being ignored" look
 *    identical without it.
 *  - `agent` is the three numbers that decide when the plan stops. They are
 *    tuning, not connection: a wrong value costs a wasted run, not an outage.
 *
 * The API key is deliberately not part of the readable shape. It goes in, it
 * never comes back out; a screen only ever learns whether one is configured and
 * the last four characters, which is enough to tell two keys apart and not
 * enough to use one.
 */

/** Where an effective value came from. Shown next to the field it explains. */
export type SettingSource = "setting" | "env" | "default";

export type LlmSettings = {
  baseUrl: string;
  baseUrlSource: SettingSource;
  model: string;
  modelSource: SettingSource;
  /** False means every model call will fail with a 400 until a key is set. */
  apiKeyConfigured: boolean;
  /** `"setting"` or `"env"` when configured; `"default"` means no key at all. */
  apiKeySource: SettingSource;
  /** Last four characters of the effective key, or null when there is none. */
  apiKeyHint: string | null;
};

export type AgentSettings = {
  /** Fit score below which the plan stops before tailoring. */
  fitMinScore: number;
  /** ATS score below which a rendered resume is not allowed out the door. */
  atsMinScore: number;
  /** Days after applying before the agent nudges, absent any reply. */
  followUpDelayDays: number;
};

export type AppSettings = {
  llm: LlmSettings;
  agent: AgentSettings;
};

/**
 * Defaults, and each number is load-bearing:
 *
 *  - 20 is the floor of the "weak" band in the scoring rubric, so below it the
 *    model has found a hard disqualifier.
 *  - 70 is the ATS gate the verification step enforces, and the evals assert it.
 *  - 5 days is long enough that a nudge is not rude and short enough that the
 *    application is still recent.
 */
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  fitMinScore: 20,
  atsMinScore: 70,
  followUpDelayDays: 5,
};

/**
 * Bounds the API validates against and the UI renders as `min`/`max`.
 *
 * The ATS floor stops at 50 rather than 0: the gate exists to keep an
 * unparseable resume off a recruiter's desk, and a setting that can switch it
 * off entirely is a footgun with a nice label on it.
 */
export const AGENT_SETTING_BOUNDS = {
  fitMinScore: { min: 0, max: 100 },
  atsMinScore: { min: 50, max: 100 },
  followUpDelayDays: { min: 1, max: 60 },
} as const satisfies Record<
  keyof AgentSettings,
  { readonly min: number; readonly max: number }
>;
