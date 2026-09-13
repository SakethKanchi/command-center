/**
 * Thin typed client for the Google Sheets API v4 plus the OAuth refresh-token
 * exchange it needs.
 *
 * Two rules shape this module:
 *   1. Every call takes an injected `fetchImpl`. Nothing here touches the
 *      global `fetch`, which is what lets the adapter be tested offline.
 *   2. Credentials are passed in, never read from `process.env`. They live on
 *      the connector row.
 */

import { setTimeout as delay } from "node:timers/promises";
import {
  AppError,
  badRequest,
  forbidden,
  requestTimeout,
  unauthorized,
  upstreamError,
} from "@server/infra/errors";
import {
  backoffDelayMs,
  isRetryableStatus,
  parseRetryAfterMs,
} from "@server/infra/retry";
import { z } from "zod";

export const SHEETS_HTTP_TIMEOUT_MS = 15_000;
export const SHEETS_MAX_ATTEMPTS = 3;
/** Upper bound on a single backoff wait, including a server `Retry-After`. */
export const SHEETS_MAX_RETRY_DELAY_MS = 5_000;
/** Refresh this long before real expiry so in-flight calls never race it. */
export const SHEETS_TOKEN_REFRESH_SKEW_MS = 60_000;
/**
 * How Google interprets written cells, for BOTH transports: the direct calls
 * below put it on the URL, and the Composio argument builder reads this same
 * constant. RAW stores what we render — a leading zero survives, and a cell
 * starting with `=` stays text rather than becoming a formula. Two different
 * options would make one row render two ways depending on which transport
 * happened to write it.
 */
export const SHEETS_VALUE_INPUT_OPTION = "RAW" as const;

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
export const SPREADSHEET_WEB_BASE = "https://docs.google.com/spreadsheets/d";

// ---------------------------------------------------------------------------
// Credential / config validation
// ---------------------------------------------------------------------------

export const sheetsCredentialsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
  accessToken: z.string().min(1).optional(),
  accessTokenExpiresAt: z.number().finite().optional(),
});
export type SheetsCredentials = z.infer<typeof sheetsCredentialsSchema>;

export const sheetsConfigSchema = z.object({
  spreadsheetId: z.string().min(1),
  spreadsheetUrl: z.string().min(1).optional(),
});
export type SheetsConfig = z.infer<typeof sheetsConfigSchema>;

export function parseSheetsCredentials(value: unknown): SheetsCredentials {
  const parsed = sheetsCredentialsSchema.safeParse(value);
  if (!parsed.success) {
    throw badRequest(
      "Google Sheets connector credentials are missing or malformed.",
      parsed.error.flatten(),
    );
  }
  return parsed.data;
}

export function parseSheetsConfig(value: unknown): SheetsConfig {
  const parsed = sheetsConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw badRequest(
      "Google Sheets connector config must include a spreadsheetId.",
      parsed.error.flatten(),
    );
  }
  return parsed.data;
}

/** Canonical spreadsheet deep link, used as the connector's destination URL. */
export function spreadsheetWebUrl(spreadsheetId: string): string {
  return `${SPREADSHEET_WEB_BASE}/${spreadsheetId}`;
}

/**
 * Auth failures are the one class of error `status()` must survive, so they
 * carry a distinguishable `AppErrorCode` rather than the generic upstream one.
 */
export function isSheetsAuthError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN")
  );
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

export async function fetchWithTimeout(
  url: string,
  args: { timeoutMs: number; init: RequestInit; fetchImpl: typeof fetch },
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);

  try {
    return await args.fetchImpl(url, {
      ...args.init,
      signal: controller.signal,
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError"
    ) {
      throw requestTimeout(
        `Google Sheets request timed out after ${args.timeoutMs}ms for ${url}.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Google reports failures two ways: `{ error: { message } }` from the Sheets
 * API and `{ error, error_description }` from the OAuth endpoint. Both are
 * surfaced verbatim so a misconfigured connector says why.
 */
export function extractGoogleErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("error" in data)) return null;
  const error = data.error;

  if (typeof error === "string") {
    const description =
      "error_description" in data ? data.error_description : null;
    return typeof description === "string" && description.length > 0
      ? `${error}: ${description}`
      : error;
  }

  if (error && typeof error === "object") {
    if (
      "message" in error &&
      typeof error.message === "string" &&
      error.message.length > 0
    ) {
      return error.message;
    }
    if (
      "status" in error &&
      typeof error.status === "string" &&
      error.status.length > 0
    ) {
      return error.status;
    }
  }

  return null;
}

type GoogleRequestArgs = {
  fetchImpl: typeof fetch;
  method: "GET" | "POST" | "PUT";
  url: string;
  label: string;
  /** Bearer token; omitted for the OAuth token exchange itself. */
  token?: string | null;
  json?: unknown;
  form?: URLSearchParams;
  /** Statuses treated as auth failures; the token endpoint adds 400. */
  authStatuses?: readonly number[];
  timeoutMs?: number;
};

const DEFAULT_AUTH_STATUSES: readonly number[] = [401, 403];

/**
 * One Google API call with bounded retries. Only 429 and 5xx are retried, via
 * the shared infra retry policy so the backoff curve stays consistent across
 * the codebase; `Retry-After` is honoured as a floor and the wait is capped.
 */
async function googleRequest<T>(args: GoogleRequestArgs): Promise<T> {
  const authStatuses = args.authStatuses ?? DEFAULT_AUTH_STATUSES;
  const timeoutMs = args.timeoutMs ?? SHEETS_HTTP_TIMEOUT_MS;
  let lastError: AppError | null = null;

  for (let attempt = 1; attempt <= SHEETS_MAX_ATTEMPTS; attempt += 1) {
    const headers: Record<string, string> = {};
    if (args.token) headers.Authorization = `Bearer ${args.token}`;

    let body: BodyInit | undefined;
    if (args.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = args.form.toString();
    } else if (args.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(args.json);
    }

    const response = await fetchWithTimeout(args.url, {
      timeoutMs,
      fetchImpl: args.fetchImpl,
      init: { method: args.method, headers, body },
    });

    const data: unknown = await response.json().catch(() => null);
    // Boundary cast: the caller's generic names the documented Google payload,
    // and every reader below re-checks the fields it depends on.
    if (response.ok) return data as T;

    const detail = extractGoogleErrorMessage(data);
    const message = `Google Sheets ${args.label} failed (HTTP ${response.status})${
      detail ? `: ${detail}` : "."
    }`;

    if (authStatuses.includes(response.status)) {
      throw response.status === 403
        ? forbidden(message)
        : unauthorized(message);
    }

    if (!isRetryableStatus(response.status)) {
      throw upstreamError(message, { status: response.status });
    }

    lastError = upstreamError(message, { status: response.status });
    if (attempt >= SHEETS_MAX_ATTEMPTS) break;

    const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));

    await delay(
      Math.min(
        backoffDelayMs(attempt, retryAfterMs),
        SHEETS_MAX_RETRY_DELAY_MS,
      ),
    );
  }

  throw (
    lastError ??
    upstreamError(
      `Google Sheets ${args.label} failed after ${SHEETS_MAX_ATTEMPTS} attempts.`,
    )
  );
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/**
 * Returns credentials carrying a usable access token, reusing the cached one
 * until 60s before expiry. The caller persists the result (via
 * `onCredentialsRefreshed`) so the next run skips the round trip.
 */
export async function resolveSheetsAccessToken(
  credentials: SheetsCredentials,
  fetchImpl: typeof fetch,
): Promise<SheetsCredentials> {
  if (
    credentials.accessToken &&
    credentials.accessTokenExpiresAt &&
    credentials.accessTokenExpiresAt > Date.now() + SHEETS_TOKEN_REFRESH_SKEW_MS
  ) {
    return credentials;
  }

  const data = await googleRequest<{
    access_token?: unknown;
    expires_in?: unknown;
  }>({
    fetchImpl,
    method: "POST",
    url: GOOGLE_TOKEN_URL,
    label: "token refresh",
    // `invalid_grant` on a revoked refresh token arrives as HTTP 400.
    authStatuses: [400, 401, 403],
    form: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
    }),
  });

  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw upstreamError(
      "Google Sheets token refresh response did not include access_token.",
    );
  }

  const expiresInSeconds =
    typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
      ? data.expires_in
      : 3600;

  return {
    ...credentials,
    accessToken: data.access_token,
    accessTokenExpiresAt: Date.now() + expiresInSeconds * 1000,
  };
}

// ---------------------------------------------------------------------------
// Sheets API v4
// ---------------------------------------------------------------------------

export type SheetProperties = {
  sheetId: number;
  title: string;
};

export type SheetsSpreadsheet = {
  spreadsheetId: string;
  properties: { title: string };
  sheets: Array<{ properties: SheetProperties }>;
};

export type SheetsBatchUpdateRequest = {
  addSheet?: { properties: { title: string } };
};

export type SheetsBatchUpdateResponse = {
  spreadsheetId?: string;
  replies?: Array<{ addSheet?: { properties?: SheetProperties } }>;
};

export type SheetsValueRange = {
  range?: string;
  majorDimension?: string;
  values?: string[][];
};

export type SheetsUpdateValuesResponse = {
  spreadsheetId?: string;
  updatedRange?: string;
  updatedRows?: number;
};

export type SheetsAppendValuesResponse = {
  spreadsheetId?: string;
  updates?: {
    updatedRange?: string;
    updatedRows?: number;
  };
};

function spreadsheetPath(spreadsheetId: string): string {
  return `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}`;
}

export async function getSpreadsheet(
  token: string,
  fetchImpl: typeof fetch,
  spreadsheetId: string,
): Promise<SheetsSpreadsheet> {
  const data = await googleRequest<Partial<SheetsSpreadsheet>>({
    token,
    fetchImpl,
    method: "GET",
    label: "spreadsheet metadata read",
    url: `${spreadsheetPath(spreadsheetId)}?fields=${encodeURIComponent(
      "spreadsheetId,properties.title,sheets.properties",
    )}`,
  });

  return {
    spreadsheetId: data.spreadsheetId ?? spreadsheetId,
    properties: { title: data.properties?.title ?? "" },
    sheets: Array.isArray(data.sheets) ? data.sheets : [],
  };
}

export async function batchUpdate(
  token: string,
  fetchImpl: typeof fetch,
  spreadsheetId: string,
  requests: SheetsBatchUpdateRequest[],
): Promise<SheetsBatchUpdateResponse> {
  return googleRequest<SheetsBatchUpdateResponse>({
    token,
    fetchImpl,
    method: "POST",
    label: "spreadsheet batchUpdate",
    url: `${spreadsheetPath(spreadsheetId)}:batchUpdate`,
    json: { requests },
  });
}

export async function getValues(
  token: string,
  fetchImpl: typeof fetch,
  spreadsheetId: string,
  range: string,
): Promise<SheetsValueRange> {
  return googleRequest<SheetsValueRange>({
    token,
    fetchImpl,
    method: "GET",
    label: `values read for ${range}`,
    url: `${spreadsheetPath(spreadsheetId)}/values/${encodeURIComponent(range)}`,
  });
}

export async function updateValues(
  token: string,
  fetchImpl: typeof fetch,
  spreadsheetId: string,
  range: string,
  values: string[][],
): Promise<SheetsUpdateValuesResponse> {
  return googleRequest<SheetsUpdateValuesResponse>({
    token,
    fetchImpl,
    method: "PUT",
    label: `values update for ${range}`,
    url: `${spreadsheetPath(spreadsheetId)}/values/${encodeURIComponent(
      range,
    )}?valueInputOption=${SHEETS_VALUE_INPUT_OPTION}`,
    json: { range, majorDimension: "ROWS", values },
  });
}

export async function appendValues(
  token: string,
  fetchImpl: typeof fetch,
  spreadsheetId: string,
  range: string,
  values: string[][],
): Promise<SheetsAppendValuesResponse> {
  return googleRequest<SheetsAppendValuesResponse>({
    token,
    fetchImpl,
    method: "POST",
    label: `values append for ${range}`,
    url: `${spreadsheetPath(spreadsheetId)}/values/${encodeURIComponent(
      range,
    )}:append?valueInputOption=${SHEETS_VALUE_INPUT_OPTION}&insertDataOption=INSERT_ROWS`,
    json: { range, majorDimension: "ROWS", values },
  });
}
