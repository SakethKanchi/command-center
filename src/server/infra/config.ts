/**
 * The environment, parsed once.
 *
 * Every variable this server treats as *configuration* is declared here, is
 * validated here, and is read by callers from the frozen object this module
 * returns. A misconfigured process must die at boot with the offending variable
 * named, not serve half its routes and fail on the request that happens to need
 * the bad value.
 *
 * Two deliberate exclusions:
 *
 *   1. **Credentials** (`LLM_API_KEY`, `COMPOSIO_API_KEY`, ...) are validated as
 *      optional and nothing more. The app is designed to run with none of them
 *      and degrade with a message, so absence can never be a parse error. They
 *      are still declared so that a blank assignment in `.env` normalizes to
 *      absent rather than to `""`, and so the boot banner can say which
 *      integrations are live.
 *   2. **Paths read on demand** (`DATA_DIR`, `DATABASE_PATH`) are validated here
 *      but still read lazily by `@server/db` and the resume writer, because the
 *      test suites point them at a fresh temp directory *after* module load.
 *      Freezing them at import time would make those suites unwritable.
 *
 * `loadConfig` is pure apart from caching the result: pass an object to test it.
 */

import { z } from "zod";

/** A blank assignment (`FOO=`) means "not set", not "set to empty string". */
const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalText = z.preprocess(
  blankToUndefined,
  z.string().trim().optional(),
);

/**
 * A whole number in a fixed range.
 *
 * Spelled as a string regex rather than `z.coerce.number()` because coercion
 * reports `PORT: Expected number, received nan`, which tells an operator what
 * zod thinks rather than what to type.
 */
const integerText = (min: number, max: number) =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .regex(/^\d+$/, "must be a whole number, digits only")
      .transform(Number)
      .refine(
        (value) => value >= min && value <= max,
        `must be between ${min} and ${max}`,
      )
      .optional(),
  );

/**
 * An absolute browser-reachable URL.
 *
 * The protocol check is not decoration: `URL.canParse("localhost:8787")`
 * succeeds, reading `localhost:` as the scheme, so a base URL missing its
 * `http://` would otherwise pass validation and then produce links nothing can
 * follow. Trailing slashes are stripped so `${baseUrl}/path` is safe.
 */
const urlText = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .refine((value) => {
      const parsed = URL.parse(value);
      return (
        parsed !== null &&
        (parsed.protocol === "http:" || parsed.protocol === "https:")
      );
    }, "must be an absolute http(s) URL, for example http://localhost:8787")
    .transform((value) => value.replace(/\/+$/, ""))
    .optional(),
);

const envSchema = z.object({
  NODE_ENV: z.preprocess(
    blankToUndefined,
    z.enum(["development", "test", "production"]).optional(),
  ),
  HOST: optionalText,
  PORT: integerText(1, 65535),
  PUBLIC_BASE_URL: urlText,
  LOG_LEVEL: z.preprocess(
    blankToUndefined,
    z.enum(["debug", "info", "warn", "error"]).optional(),
  ),
  LOG_FORMAT: z.preprocess(
    blankToUndefined,
    z.enum(["json", "text"]).optional(),
  ),
  SHUTDOWN_TIMEOUT_MS: integerText(100, 120_000),
  DATA_DIR: optionalText,
  DATABASE_PATH: optionalText,
  // Credentials and credential locations: presence only. See the header note.
  // The Composio pair is owned by `@server/connectors/composio`, which resolves
  // them per call; they are declared here only so a blank value normalizes.
  LLM_API_KEY: optionalText,
  COMPOSIO_API_KEY: optionalText,
  COMPOSIO_ORG_ID: optionalText,
  COMPOSIO_CACHE_DIR: optionalText,
});

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "json" | "text";

export type AppConfig = {
  readonly nodeEnv: "development" | "test" | "production";
  readonly isProduction: boolean;
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly log: { readonly level: LogLevel; readonly format: LogFormat };
  readonly shutdownTimeoutMs: number;
  /** Informational: the modules that own these read them lazily. */
  readonly paths: {
    readonly dataDir: string | undefined;
    readonly databasePath: string | undefined;
  };
  /** Presence of optional credentials, for the boot banner. Never the value. */
  readonly credentials: {
    readonly llmApiKey: boolean;
    readonly composioApiKey: boolean;
  };
};

export class ConfigError extends Error {
  /** One `VARIABLE: reason` per offending variable. */
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`,
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}

function build(parsed: z.infer<typeof envSchema>): AppConfig {
  const nodeEnv = parsed.NODE_ENV ?? "development";
  const isProduction = nodeEnv === "production";
  const port = parsed.PORT ?? 8787;

  return Object.freeze({
    nodeEnv,
    isProduction,
    // A container has to publish on every interface to be reachable; a laptop
    // should not put an unauthenticated single-user app on the local network.
    host: parsed.HOST ?? (isProduction ? "0.0.0.0" : "127.0.0.1"),
    port,
    baseUrl: parsed.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
    log: Object.freeze({
      level: parsed.LOG_LEVEL ?? "info",
      // A collector needs one JSON object per line; a developer needs to read
      // it. Default by environment so neither has to remember the flag.
      format: parsed.LOG_FORMAT ?? (isProduction ? "json" : "text"),
    }),
    shutdownTimeoutMs: parsed.SHUTDOWN_TIMEOUT_MS ?? 10_000,
    paths: Object.freeze({
      dataDir: parsed.DATA_DIR,
      databasePath: parsed.DATABASE_PATH,
    }),
    credentials: Object.freeze({
      llmApiKey: parsed.LLM_API_KEY !== undefined,
      composioApiKey: parsed.COMPOSIO_API_KEY !== undefined,
    }),
  });
}

let active: AppConfig | null = null;

/**
 * Parse `env` into the frozen config, caching it as the process-wide answer.
 *
 * Throws `ConfigError` listing every bad variable at once: an operator fixing a
 * deployment should see all of them, not one per restart.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = Object.entries(result.error.flatten().fieldErrors)
      .flatMap(([name, messages]) =>
        (messages ?? []).map((message) => `${name}: ${message}`),
      )
      .sort();
    throw new ConfigError(issues);
  }

  active = build(result.data);
  return active;
}

/** The loaded config, parsing `process.env` on first use if boot has not run. */
export function getConfig(): AppConfig {
  return active ?? loadConfig();
}

/** Test seam: drop the cached config so the next `getConfig` reparses. */
export function resetConfigForTests(): void {
  active = null;
}

/**
 * `uak_1234…cdef` — enough to tell two keys apart in a log, not enough to use.
 * Anything shorter than a plausible key is reported as `set` with no characters.
 */
export function maskSecret(value: string | undefined | null): string {
  if (value === undefined || value === null) return "unset";
  const trimmed = value.trim();
  if (trimmed === "") return "unset";
  if (trimmed.length < 12) return `set (${trimmed.length} chars)`;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)} (${trimmed.length} chars)`;
}
