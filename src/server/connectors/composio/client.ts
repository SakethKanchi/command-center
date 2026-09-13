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
import {
  type ComposioCredentialKind,
  originOf,
  resolveComposioCredential,
} from "./credentials";

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
  /** Which credential class is in play; the remedy differs per class. */
  readonly kind: ComposioCredentialKind;
  /** `environment` or `cli`, or null when no credential was found. */
  readonly credentialSource: "environment" | "cli" | null;
  readonly baseUrl: string;
  listAuthConfigs(toolkitSlug: string): Promise<ComposioAuthConfig[]>;
  createAuthConfig(toolkitSlug: string): Promise<ComposioAuthConfig>;
  ensureAuthConfig(toolkitSlug: string): Promise<string>;
  createLink(args: {
    authConfigId: string;
    callbackUrl?: string | null;
  }): Promise<ComposioLink>;
  getConnectedAccount(id: string): Promise<ComposioConnectedAccount>;
  /** Omit the slug to list every connected account for the entity. */
  listConnectedAccounts(
    toolkitSlug?: string,
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

/**
 * Resolve-once-per-process facts about a user-key account. Neither changes
 * for the life of a login, and both are needed on every later request, so a
 * ten-step agent run resolves them once rather than ten times.
 */
type ConsumerProject = { projectId: string; userId: string };
const consumerProjects = new Map<string, Promise<ConsumerProject>>();
const routerSessions = new Map<string, Promise<string>>();

/** Composio's slug when a session has expired or was never opened. */
export const COMPOSIO_SESSION_MISSING_SLUG = "ToolRouterV2_SessionNotFound";

export function clearComposioSessionCache(): void {
  consumerProjects.clear();
  routerSessions.clear();
}

const consumerProjectSchema = z.object({
  project_nano_id: z.string().min(1),
  consumer_user_id: z.string().min(1),
});

const routerSessionSchema = z.object({
  // The field is `session_id`. There is no `id`, and reading one yields
  // "Tool router session with ID undefined not found".
  session_id: z.string().min(1),
});

/**
 * Which accounts a session may act through, and which toolkits need the user
 * to reconnect.
 *
 * A toolkit can hold several accounts and a dead one outlives the working
 * one: this user's Composio holds a FAILED `notion` and an EXPIRED `gmail`
 * beside the ACTIVE pair. Binding by first-match would attach the corpse and
 * report a connected app that cannot execute a single tool, so only ACTIVE
 * accounts are ever bound.
 */
export function bindableAccounts(accounts: ComposioConnectedAccount[]): {
  connected: Record<string, string>;
  needsReconnect: { toolkitSlug: string; status: ComposioAccountStatus }[];
} {
  const byToolkit = new Map<string, ComposioConnectedAccount[]>();
  for (const account of accounts) {
    const slug = account.toolkitSlug ?? "";
    if (slug === "") continue;
    const bucket = byToolkit.get(slug);
    if (bucket) bucket.push(account);
    else byToolkit.set(slug, [account]);
  }

  const connected: Record<string, string> = {};
  const needsReconnect: {
    toolkitSlug: string;
    status: ComposioAccountStatus;
  }[] = [];
  for (const [toolkitSlug, bucket] of byToolkit) {
    const active = bucket.find((account) => account.status === "ACTIVE");
    if (active) {
      connected[toolkitSlug] = active.id;
      continue;
    }
    const first = bucket[0];
    if (first) needsReconnect.push({ toolkitSlug, status: first.status });
  }
  return { connected, needsReconnect };
}

/** A session that expired or never existed, by slug rather than by status. */
function isSessionMissing(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes(COMPOSIO_SESSION_MISSING_SLUG);
}

export function createComposioClient(
  options: ComposioClientOptions = {},
): ComposioClient {
  const credential = resolveComposioCredential({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  });
  const apiKey = credential?.apiKey ?? "";
  const baseUrl = (options.baseUrl ?? COMPOSIO_API_BASE).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const isUserKey = credential?.kind === "user";
  /**
   * The user path addresses a derived `consumer-<uuid>-<org>` entity, resolved
   * below; only the project path uses a configurable id.
   */
  const configuredUserId = (
    options.userId ??
    process.env.COMPOSIO_USER_ID ??
    "primary"
  ).trim();
  const cacheKey = `${baseUrl}::${apiKey}`;
  /** Populated on the user path once the project resolve has run. */
  let resolved: ConsumerProject | null = null;

  /**
   * Headers for one request, built in exactly one place.
   *
   * `x-project-id` is not optional on the user path: without it
   * `GET /connected_accounts` answers HTTP 200 with an EMPTY list instead of
   * an error, so a forgotten header reads as "you have no connected apps"
   * rather than as a bug. Centralising this is what makes that
   * unforgettable.
   */
  function authHeaders(): Record<string, string> {
    const common = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (!isUserKey) return { ...common, "x-api-key": apiKey };
    return {
      ...common,
      "x-user-api-key": apiKey,
      ...(credential?.orgId ? { "x-org-id": credential.orgId } : {}),
      ...(resolved ? { "x-project-id": resolved.projectId } : {}),
    };
  }

  async function request<T extends z.ZodTypeAny>(args: {
    method: "GET" | "POST" | "DELETE";
    /** Relative to the versioned base, or absolute when it starts with `http`. */
    path: string;
    label: string;
    query?: Record<string, string | undefined>;
    body?: unknown;
    schema: T;
    /** DELETE answers 204 with no body. */
    allowEmpty?: boolean;
  }): Promise<z.infer<T>> {
    if (apiKey === "") throw unauthorized(COMPOSIO_MISSING_KEY_MESSAGE);

    // Every user-path request needs `x-project-id`, and without it the API
    // answers 200-with-nothing or a bare "not found" rather than an auth
    // error. Resolving here rather than at each call site is what stops a new
    // endpoint from silently shipping without the header: the only request
    // exempt is the resolve itself, which is what produces the id.
    if (isUserKey && !resolved && !args.path.includes("/project/resolve")) {
      await ensureConsumerProject();
    }

    const url = new URL(
      args.path.startsWith("http") ? args.path : `${baseUrl}${args.path}`,
    );
    for (const [key, value] of Object.entries(args.query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, value);
    }

    const init: RequestInit = {
      method: args.method,
      headers: authHeaders(),
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

  /**
   * The project and entity a user key acts as. Cached per key for the life of
   * the process, and the in-flight promise is cached rather than the value so
   * concurrent callers share one resolve instead of racing.
   *
   * Note the path is `/api/v3/`, not v3.1 — this endpoint exists only on v3.
   */
  async function ensureConsumerProject(): Promise<ConsumerProject> {
    if (resolved) return resolved;
    const existing = consumerProjects.get(cacheKey);
    if (existing) {
      resolved = await existing;
      return resolved;
    }

    const pending = (async () => {
      const payload = await request({
        method: "POST",
        path: `${originOf(baseUrl)}/api/v3/org/consumer/project/resolve`,
        label: "resolve consumer project",
        body: {},
        schema: consumerProjectSchema,
      });
      return {
        projectId: payload.project_nano_id,
        userId: payload.consumer_user_id,
      };
    })();

    consumerProjects.set(cacheKey, pending);
    try {
      resolved = await pending;
      return resolved;
    } catch (error) {
      // A failed resolve must not poison every later call.
      consumerProjects.delete(cacheKey);
      throw error;
    }
  }

  /** The entity id to address: derived on the user path, configured otherwise. */
  async function currentUserId(): Promise<string> {
    if (!isUserKey) return configuredUserId;
    return (await ensureConsumerProject()).userId;
  }

  /**
   * A tool-router session, bound to the accounts it may act on. Reused across
   * tool calls: opening one per call would add a round trip to every step of
   * an agent run.
   */
  async function ensureSession(
    connectedAccountId?: string | null,
  ): Promise<string> {
    const project = await ensureConsumerProject();
    const key = `${cacheKey}::${connectedAccountId ?? "all"}`;
    const existing = routerSessions.get(key);
    if (existing) return existing;

    const pending = (async () => {
      const accounts = await client.listConnectedAccounts();
      const bindable = bindableAccounts(accounts);
      const payload = await request({
        method: "POST",
        path: "/tool_router/session",
        label: "open tool router session",
        body: {
          user_id: project.userId,
          connected_accounts: bindable.connected,
          manage_connections: { enable: true },
        },
        schema: routerSessionSchema,
      });
      return payload.session_id;
    })();

    routerSessions.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      routerSessions.delete(key);
      throw error;
    }
  }
  /**
   * Execute inside a tool-router session, reopening once if the session has
   * gone. One retry only: a second miss is a real failure, and retrying
   * forever would hide it behind a loop.
   */
  async function executeInSession(
    slug: string,
    input: {
      arguments: Record<string, unknown>;
      connectedAccountId?: string | null;
    },
  ): Promise<z.infer<typeof toolExecutionSchema>> {
    const key = `${cacheKey}::${input.connectedAccountId ?? "all"}`;
    const attempt = async (sessionId: string) =>
      request({
        method: "POST",
        path: `/tool_router/session/${encodeURIComponent(sessionId)}/execute`,
        label: `execute ${slug}`,
        body: { tool_slug: slug, arguments: input.arguments },
        schema: toolExecutionSchema,
      });

    try {
      return await attempt(await ensureSession(input.connectedAccountId));
    } catch (error) {
      if (!isSessionMissing(error)) throw error;
      routerSessions.delete(key);
      return attempt(await ensureSession(input.connectedAccountId));
    }
  }

  const client: ComposioClient = {
    userId: configuredUserId,
    kind: credential?.kind ?? "project",
    credentialSource: credential?.source ?? null,
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
          user_id: await currentUserId(),
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
        query: {
          user_ids: await currentUserId(),
          toolkit_slugs: toolkitSlug,
          limit: "100",
        },
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
      const payload = isUserKey
        ? await executeInSession(slug, input)
        : await request({
            method: "POST",
            path: `/tools/execute/${encodeURIComponent(slug)}`,
            label: `execute ${slug}`,
            body: {
              user_id: configuredUserId,
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
