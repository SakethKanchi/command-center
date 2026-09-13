/**
 * Structured line logger.
 *
 * One JSON object per line when the format is `json`, otherwise a compact human
 * form. No dependency and no transport: the agent's durable trace lives in
 * SQLite, so logs only need to be readable during a demo and machine-parseable
 * in production.
 *
 * The level and format are not read from the environment here. Boot validates
 * them in `@server/infra/config` and pushes them in via `configureLogger`, so
 * there is exactly one place where `LOG_LEVEL=verbose` is rejected. Until that
 * call the defaults below apply, which is what makes a log line emitted while
 * the configuration is still being parsed safe.
 */

import type { LogFormat, LogLevel } from "@server/infra/config";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = LogLevel;

let threshold: number = LEVELS.info;
let asJson = false;

/** Apply validated settings. Called once at boot, before the server listens. */
export function configureLogger(options: {
  level: LogLevel;
  format: LogFormat;
}): void {
  threshold = LEVELS[options.level];
  asJson = options.format === "json";
}

function emit(level: Level, message: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;

  const stream = level === "error" || level === "warn" ? "stderr" : "stdout";
  const line = asJson
    ? JSON.stringify({
        at: new Date().toISOString(),
        level,
        message,
        ...(meta ?? {}),
      })
    : `${level.toUpperCase().padEnd(5)} ${message}${
        meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ""
      }`;

  process[stream].write(`${line}\n`);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) =>
    emit("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) =>
    emit("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) =>
    emit("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) =>
    emit("error", message, meta),
};
