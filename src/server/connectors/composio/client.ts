/**
 * Thin typed client for the Composio API v3.1.
 *
 * Composio is the *fallback* transport: it brokers OAuth on the user's behalf
 * so Gmail and Notion can be connected by clicking a hosted consent link,
 * with no Google Cloud project and no Notion integration secret. The direct
 * implementations still win whenever their own credentials are present.
 *
 * Every request goes through the injected `fetchImpl`, never the global
 * `fetch`, so the entire auth + tool-execution surface is exercisable offline.
 */

import {
  badRequest,
  notFound,
  requestTimeout,
  unauthorized,
  upstreamError,
} from "@server/infra/errors";
import { logger } from "@server/infra/logger";
import { fetchWithRetry } from "@server/infra/retry";
import { z } from "zod";

export const COMPOSIO_API_BASE = "https://backend.composio.dev/api/v3.1";
export const COMPOSIO_HTTP_TIMEOUT_MS = 20_000;
export const COMPOSIO_MAX_ATTEMPTS = 3;

/**
 * Where a key comes from; the free tier covers this whole demo. This is
 * `platform.composio.dev` — `app.composio.dev` is the old host and does not
 * serve the API-keys page, so quoting it sent the user somewhere useless.
 */
export const COMPOSIO_DASHBOARD_URL = "https://platform.composio.dev";

/**
 * Composio's Connect Link is short-lived. Used only when a `link` response
 * omits `expires_at`, so the UI always has a deadline to count down from
 * rather than an empty field.
 */
export const COMPOSIO_LINK_FALLBACK_TTL_MS = 15 * 60_000;

export const COMPOSIO_MISSING_KEY_MESSAGE =
  `COMPOSIO_API_KEY is missing or invalid. Add a key from ${COMPOSIO_DASHBOARD_URL} (free tier) to .env as COMPOSIO_API_KEY, then restart the server.` as const;

/**
 * Statuses Composio reports for a connected account. Only `ACTIVE` means the
 * user finished consent; `INITIATED` means the link is still open.
 */
export const COMPOSIO_ACCOUNT_STATUSES = [
  "INITIALIZING",
  "INITIATED",
  "ACTIVE",
  "FAILED",
  "EXPIRED",
  "INACTIVE",
] as const;
export type ComposioAccountStatus =
  | (typeof COMPOSIO_ACCOUNT_STATUSES)[number]
  | "UNKNOWN";

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

const authConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullish(),
  toolkit_slug: z.string().nullish(),
  toolkit: z.object({ slug: z.string().nullish() }).nullish(),
});

/**
 * v3 list endpoints answer `{items, total_pages, ...}`; a couple of older
 * deployments answer `{data}` and some answer a bare array. Accepting all
 * three costs one union and removes a whole class of "worked in curl, failed
 * in the app" bug.
 */
function listOf<T extends z.ZodTypeAny>(item: T) {
  return z.union([
    z.object({ items: z.array(item) }),
    z.object({ data: z.array(item) }),
    z.array(item),
  ]);
}

function unwrapList<T>(value: T[] | { items: T[] } | { data: T[] }): T[] {
  if (Array.isArray(value)) return value;
  if ("items" in value) return value.items;
  return value.data;
}

const linkSchema = z.object({
  link_token: z.string().nullish(),
  redirect_url: z.string().min(1),
  expires_at: z.union([z.string(), z.number()]).nullish(),
  connected_account_id: z.string().nullish(),
  id: z.string().nullish(),
});

const connectedAccountSchema = z.object({
  id: z.string().min(1),
  status: z.string().nullish(),
  status_reason: z.string().nullish(),
  toolkit_slug: z.string().nullish(),
  toolkit: z.object({ slug: z.string().nullish() }).nullish(),
  /** Composio surfaces the consenting identity under several keys. */
  user_id: z.string().nullish(),
  auth_config: z.object({ id: z.string().nullish() }).nullish(),
});

/**
 * Tool execution envelope. `successful: false` arrives with HTTP 200, which is
 * why this client must never treat a 2xx as a success on its own.
 */
const toolExecutionSchema = z.object({
  data: z.unknown().nullish(),
  error: z.unknown().nullish(),
  successful: z.boolean().nullish(),
  log_id: z.string().nullish(),
});

/**
 * Composio's failure envelope, confirmed against a live 401:
 * `{"error":{"message":"Invalid API key: ck_**blFZ","code":801,
 *   "slug":"APIKey_InvalidAPIKey","status":401}}`.
 */
const composioErrorSchema = z.object({
  error: z
    .union([
      z.string(),
      z.object({
        message: z.string().nullish(),
        code: z.union([z.number(), z.string()]).nullish(),
        slug: z.string().nullish(),
        status: z.number().nullish(),
        request_id: z.string().nullish(),
        suggested_fix: z.string().nullish(),
      }),
    ])
    .nullish(),
  message: z.string().nullish(),
  detail: z.string().nullish(),
});

/** The slug Composio returns for a bad or absent key. */
export const COMPOSIO_INVALID_KEY_SLUG = "APIKey_InvalidAPIKey";

export type ComposioAuthConfig = {
  id: string;
  toolkitSlug: string | null;
  name: string | null;
};

export type ComposioLink = {
  linkToken: string | null;
  redirectUrl: string;
  /** ISO-8601 UTC, always populated so the UI can show a deadline. */
  expiresAt: string;
  connectedAccountId: string;
};

export type ComposioConnectedAccount = {
  id: string;
  status: ComposioAccountStatus;
  statusReason: string | null;
  toolkitSlug: string | null;
  authConfigId: string | null;
  userId: string | null;
};

export type ComposioToolResult = {
  data: unknown;
  logId: string | null;
};

export type ComposioClientOptions = {
  apiKey?: string | null;
  baseUrl?: string;
  /**
   * Injected for tests. Optional at the boundary only: it is resolved once
   * here and every request below uses the captured value, so no call site can
   * reach the global `fetch` by accident.
   */
  fetchImpl?: typeof fetch;
  userId?: string;
};

export type ComposioClient = {
  readonly userId: string;
  readonly baseUrl: string;
  listAuthConfigs(toolkitSlug: string): Promise<ComposioAuthConfig[]>;
  createAuthConfig(toolkitSlug: string): Promise<ComposioAuthConfig>;
  ensureAuthConfig(toolkitSlug: string): Promise<string>;
  createLink(args: {
    authConfigId: string;
    callbackUrl?: string | null;
  }): Promise<ComposioLink>;
  getConnectedAccount(id: string): Promise<ComposioConnectedAccount>;
  listConnectedAccounts(
    toolkitSlug: string,
  ): Promise<ComposioConnectedAccount[]>;
  deleteConnectedAccount(id: string): Promise<void>;
  executeTool(
    slug: string,
    input: {
      arguments: Record<string, unknown>;
      connectedAccountId?: string | null;
    },
  ): Promise<ComposioToolResult>;
};

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Composio's own words, so a misconfigured key reads "Invalid API key" rather
 * than "upstream failed". `suggested_fix` is appended when present because it
 * is the one field that tells the operator what to change.
 */
export function describeComposioError(data: unknown): string | null {
  const parsed = composioErrorSchema.safeParse(data);
  if (!parsed.success) return null;

  const { error, message, detail } = parsed.data;
  if (typeof error === "string" && error.trim() !== "") return error.trim();

  if (error && typeof error === "object") {
    const parts: string[] = [];
    const primary = error.message?.trim();
    if (primary) parts.push(primary);
    const fix = error.suggested_fix?.trim();
    if (fix) parts.push(fix);
    if (parts.length > 0) return parts.join(" ");
    if (error.slug) return error.slug;
  }

  const fallback = message?.trim() || detail?.trim();
  return fallback ? fallback : null;
}

/**
 * The bad-key case, by status or by slug, so neither alone is load-bearing.
 *
 * 403 is deliberately excluded: Composio uses it for plan and scope limits,
 * and telling the operator to fix a key that is fine would send them the
 * wrong way. Those fall through to the generic mapping, which still carries
 * Composio's own message.
 */
export function isComposioAuthFailure(status: number, data: unknown): boolean {
  if (status === 401) return true;
  const parsed = composioErrorSchema.safeParse(data);
  const error = parsed.success ? parsed.data.error : null;
  return (
    !!error &&
    typeof error === "object" &&
    error.slug === COMPOSIO_INVALID_KEY_SLUG
  );
}

function mapComposioError(args: {
  label: string;
  status: number;
  data: unknown;
  bodyText: string;
}) {
  const detail = describeComposioError(args.data);
  const suffix = detail ?? args.bodyText.slice(0, 300) ?? "";

  if (isComposioAuthFailure(args.status, args.data)) {
    // Never a bare 401: the only useful thing to say here is which env var to
    // fix. This is not retried — it is not 429 or 5xx.
    return unauthorized(
      `${COMPOSIO_MISSING_KEY_MESSAGE}${detail ? ` Composio said: ${detail}` : ""}`,
    );
  }
  if (args.status === 404) {
    return notFound(`Composio ${args.label} not found: ${suffix}`);
  }
  if (args.status === 400 || args.status === 422) {
    return badRequest(`Composio rejected ${args.label}: ${suffix}`, {
      status: args.status,
    });
  }
  return upstreamError(`Composio ${args.label} failed (${args.status}).`, {
    status: args.status,
    detail: suffix,
  });
}

// ---------------------------------------------------------------------------
// Value normalisation
// ---------------------------------------------------------------------------

/**
 * Expiries cross the wire as an ISO string or as epoch seconds/millis. This
 * repo stores and serves ISO-8601 UTC only, so everything funnels through here.
 */
export function toIsoTimestamp(
  value: string | number | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // Epoch seconds are ~1e9 today, millis ~1e12; the gap is unambiguous.
    const millis = value < 1e11 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function normalizeStatus(value: string | null | undefined) {
  const upper = (value ?? "").trim().toUpperCase();
  return (
    COMPOSIO_ACCOUNT_STATUSES.find((known) => known === upper) ?? "UNKNOWN"
  );
}

function toAuthConfig(
  raw: z.infer<typeof authConfigSchema>,
): ComposioAuthConfig {
  return {
    id: raw.id,
    toolkitSlug: raw.toolkit_slug ?? raw.toolkit?.slug ?? null,
    name: raw.name ?? null,
  };
}

function toConnectedAccount(
  raw: z.infer<typeof connectedAccountSchema>,
): ComposioConnectedAccount {
  return {
    id: raw.id,
    status: normalizeStatus(raw.status),
    statusReason: raw.status_reason ?? null,
    toolkitSlug: raw.toolkit_slug ?? raw.toolkit?.slug ?? null,
    authConfigId: raw.auth_config?.id ?? null,
    userId: raw.user_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Auth-config cache
// ---------------------------------------------------------------------------

/**
 * `ensureAuthConfig` runs on every connect, and the router builds a client per
 * request, so the cache has to outlive the instance to be worth anything.
 * Keyed by base URL as well as slug so a test client cannot poison a real one.
 */
const authConfigIds = new Map<string, string>();

export function clearComposioAuthConfigCache(): void {
  authConfigIds.clear();
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function createComposioClient(
  options: ComposioClientOptions = {},
): ComposioClient {
  const apiKey = (options.apiKey ?? process.env.COMPOSIO_API_KEY ?? "").trim();
  const baseUrl = (options.baseUrl ?? COMPOSIO_API_BASE).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const userId = (
    options.userId ??
    process.env.COMPOSIO_USER_ID ??
    "primary"
  ).trim();

  async function request<T extends z.ZodTypeAny>(args: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    label: string;
    query?: Record<string, string | undefined>;
    body?: unknown;
    schema: T;
    /** DELETE answers 204 with no body. */
    allowEmpty?: boolean;
  }): Promise<z.infer<T>> {
    if (apiKey === "") throw unauthorized(COMPOSIO_MISSING_KEY_MESSAGE);

    const url = new URL(`${baseUrl}${args.path}`);
    for (const [key, value] of Object.entries(args.query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, value);
    }

    const init: RequestInit = {
      method: args.method,
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
    };

    let response: Response;
    try {
      response = await fetchWithRetry(url.toString(), init, {
        fetchImpl,
        timeoutMs: COMPOSIO_HTTP_TIMEOUT_MS,
        maxAttempts: COMPOSIO_MAX_ATTEMPTS,
        label: `composio ${args.label}`,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw requestTimeout(
          `Composio ${args.label} timed out after ${COMPOSIO_HTTP_TIMEOUT_MS}ms.`,
        );
      }
      throw error;
    }

    const bodyText = await response.text().catch(() => "");
    let data: unknown = null;
    if (bodyText.trim() !== "") {
      try {
        data = JSON.parse(bodyText);
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      throw mapComposioError({
        label: args.label,
        status: response.status,
        data,
        bodyText,
      });
    }

    if (data === null && args.allowEmpty) return args.schema.parse({});

    const parsed = args.schema.safeParse(data);
    if (!parsed.success) {
      throw upstreamError(
        `Composio ${args.label} returned an unexpected payload.`,
        { issues: parsed.error.flatten(), body: bodyText.slice(0, 300) },
      );
    }
    return parsed.data;
  }

  const client: ComposioClient = {
    userId,
    baseUrl,

    async listAuthConfigs(toolkitSlug) {
      const payload = await request({
        method: "GET",
        path: "/auth_configs",
        label: "list auth configs",
        query: { toolkit_slug: toolkitSlug },
        schema: listOf(authConfigSchema),
      });
      return unwrapList(payload).map(toAuthConfig);
    },

    async createAuthConfig(toolkitSlug) {
      const payload = await request({
        method: "POST",
        path: "/auth_configs",
        label: "create auth config",
        // Composio-managed auth is the whole point: it uses Composio's own
        // OAuth app, so the user needs no Google Cloud project of their own.
        body: {
          toolkit: { slug: toolkitSlug },
          auth_config: { type: "use_composio_managed_auth" },
        },
        schema: z.union([
          authConfigSchema,
          z.object({ auth_config: authConfigSchema }),
        ]),
      });
      const raw = "auth_config" in payload ? payload.auth_config : payload;
      return toAuthConfig(raw);
    },

    async ensureAuthConfig(toolkitSlug) {
      const cacheKey = `${baseUrl}::${toolkitSlug}`;
      const cached = authConfigIds.get(cacheKey);
      if (cached) return cached;

      const existing = await client.listAuthConfigs(toolkitSlug);
      const reused = existing[0];
      if (reused) {
        authConfigIds.set(cacheKey, reused.id);
        return reused.id;
      }

      const created = await client.createAuthConfig(toolkitSlug);
      logger.info("Created a Composio auth config", {
        toolkitSlug,
        authConfigId: created.id,
      });
      authConfigIds.set(cacheKey, created.id);
      return created.id;
    },

    async createLink(args) {
      const payload = await request({
        method: "POST",
        path: "/connected_accounts/link",
        label: "create connect link",
        body: {
          auth_config_id: args.authConfigId,
          user_id: userId,
          ...(args.callbackUrl ? { callback_url: args.callbackUrl } : {}),
        },
        schema: linkSchema,
      });

      const connectedAccountId = payload.connected_account_id ?? payload.id;
      if (!connectedAccountId) {
        throw upstreamError(
          "Composio connect link came back without a connected account id, so its status could not be polled.",
        );
      }

      return {
        linkToken: payload.link_token ?? null,
        redirectUrl: payload.redirect_url,
        expiresAt:
          toIsoTimestamp(payload.expires_at) ??
          new Date(Date.now() + COMPOSIO_LINK_FALLBACK_TTL_MS).toISOString(),
        connectedAccountId,
      };
    },

    async getConnectedAccount(id) {
      const payload = await request({
        method: "GET",
        path: `/connected_accounts/${encodeURIComponent(id)}`,
        label: "get connected account",
        schema: connectedAccountSchema,
      });
      return toConnectedAccount(payload);
    },

    async listConnectedAccounts(toolkitSlug) {
      const payload = await request({
        method: "GET",
        path: "/connected_accounts",
        label: "list connected accounts",
        query: { user_ids: userId, toolkit_slugs: toolkitSlug },
        schema: listOf(connectedAccountSchema),
      });
      return unwrapList(payload).map(toConnectedAccount);
    },

    async deleteConnectedAccount(id) {
      await request({
        method: "DELETE",
        path: `/connected_accounts/${encodeURIComponent(id)}`,
        label: "delete connected account",
        schema: z.unknown(),
        allowEmpty: true,
      });
    },

    async executeTool(slug, input) {
      const payload = await request({
        method: "POST",
        path: `/tools/execute/${encodeURIComponent(slug)}`,
        label: `execute ${slug}`,
        body: {
          user_id: userId,
          arguments: input.arguments,
          // v3.1 requires an explicit toolkit version for manual execution.
          version: "latest",
          ...(input.connectedAccountId
            ? { connected_account_id: input.connectedAccountId }
            : {}),
        },
        schema: toolExecutionSchema,
      });

      // The single most important behaviour in this client: a tool call can
      // answer HTTP 200 and still have failed. Composio's own message is
      // surfaced verbatim, which is what makes an unknown tool slug or a
      // rejected argument diagnosable instead of mysterious.
      const failureMessage = toolErrorMessage(payload.error);
      if (payload.successful === false || failureMessage !== null) {
        throw upstreamError(
          `Composio tool ${slug} failed: ${failureMessage ?? "no reason given"}`,
          { slug, logId: payload.log_id ?? null },
        );
      }

      return { data: payload.data ?? null, logId: payload.log_id ?? null };
    },
  };

  return client;
}

/**
 * `error` is a string for most tool failures and an object for a few. Empty
 * string and empty object both mean "no error", so neither may be reported as
 * a failure — that would turn every successful call into an exception.
 */
function toolErrorMessage(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "object") {
    const described = describeComposioError({ error: value });
    if (described) return described;
    const serialized = JSON.stringify(value);
    return serialized === "{}" || serialized === undefined
      ? null
      : serialized.slice(0, 300);
  }
  return String(value);
}
