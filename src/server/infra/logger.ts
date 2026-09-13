/**
 * Structured line logger.
 *
 * One JSON object per line when `LOG_FORMAT=json`, otherwise a compact human
 * form. No dependency and no transport: the agent's durable trace lives in
 * SQLite, so logs only need to be readable during a demo.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold =
  LEVELS[(process.env.LOG_LEVEL as Level | undefined) ?? "info"] ?? LEVELS.info;
const asJson = process.env.LOG_FORMAT === "json";

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
