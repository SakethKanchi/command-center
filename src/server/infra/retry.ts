import { setTimeout as sleep } from "node:timers/promises";
import { logger } from "./logger";

/**
 * Retry policy shared by every outbound adapter.
 *
 * Only 429 and 5xx are retried. A 4xx other than 429 is never retried: those
 * are validation failures, and re-issuing a request that may already have had
 * an effect (a sent email, an appended row) is worse than surfacing the error.
 */
export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 507, 509]);

export const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 300;
const MAX_DELAY_MS = 5_000;

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

/**
 * Parse `Retry-After`, which is either delta-seconds or an HTTP date.
 * Returns null when absent or unparseable so the caller falls back to backoff.
 */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return seconds <= 0 ? 0 : Math.round(seconds * 1000);
  }

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return null;
  return Math.max(0, asDate - Date.now());
}

/**
 * Exponential backoff with full jitter, capped.
 *
 * Jitter is not decoration: a single agent run fans several calls at the same
 * API, and synchronized retries would re-collide on the same rate limit.
 * `retryAfterMs` acts as a floor, never a ceiling.
 */
export function backoffDelayMs(
  attempt: number,
  retryAfterMs?: number | null,
): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  const jittered = Math.floor(Math.random() * ceiling);
  return Math.max(jittered, retryAfterMs ?? 0);
}

export type RetryableFetchOptions = {
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Used in logs so a retry storm is attributable to one adapter. */
  label: string;
};

/**
 * `fetch` with a deadline and the shared retry policy.
 *
 * Adapters take their `fetchImpl` by injection and pass it through here, which
 * is what lets every connector test drive the full retry path with no network.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryableFetchOptions,
): Promise<Response> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const timeoutMs = options.timeoutMs ?? 15_000;
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await options.fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });

      if (response.ok || !isRetryableStatus(response.status)) return response;

      lastResponse = response;
      if (attempt === maxAttempts) return response;

      const delay = backoffDelayMs(
        attempt,
        parseRetryAfterMs(response.headers.get("retry-after")),
      );
      logger.warn("Retrying upstream request", {
        label: options.label,
        status: response.status,
        attempt,
        delayMs: delay,
      });
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }

  // Unreachable in practice: the loop either returns or exhausts attempts and
  // returns the final response above.
  if (lastResponse) return lastResponse;
  throw new Error(`${options.label}: exhausted retries without a response`);
}
