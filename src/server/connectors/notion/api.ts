/**
 * Typed Notion REST client for the command-center connector.
 *
 * Auth is an internal-integration token (never OAuth refresh), so there is no
 * token lifecycle here: the caller passes the bearer token from the connector
 * row on every call. Network access always goes through the injected
 * `fetchImpl` so the adapter is replayable against fixtures with no sockets.
 *
 * Notion rate-limits an integration at ~3 requests/second and answers with
 * `429` + `Retry-After` rather than dropping the request, so backpressure is
 * handled reactively: retry 429/5xx with the header as the delay floor.
 */

import { setTimeout as delay } from "node:timers/promises";
import type { ConnectorEntityKind } from "@domain";
import {
  notFound,
  requestTimeout,
  unauthorized,
  upstreamError,
} from "@server/infra/errors";
import { backoffDelayMs, parseRetryAfterMs } from "@server/infra/retry";
import { z } from "zod";

export const NOTION_API_BASE = "https://api.notion.com/v1";
export const NOTION_API_VERSION = "2022-06-28";
export const NOTION_HTTP_TIMEOUT_MS = 15_000;
export const NOTION_MAX_ATTEMPTS = 3;
/** Notion caps a paginated list response at 100 items. */
export const NOTION_PAGE_SIZE = 100;
/** Bound on `search` pagination so a huge workspace cannot stall a connect. */
export const NOTION_MAX_SEARCH_PAGES = 10;

export const notionCredentialsSchema = z.object({
  /** Internal integration secret, `secret_…` or `ntn_…`. */
  accessToken: z.string().min(1, "accessToken is required"),
});
export type NotionCredentials = z.infer<typeof notionCredentialsSchema>;

export const notionConfigSchema = z.object({
  /** Page the connector provisions missing lane databases under. */
  parentPageId: z.string().min(1).optional(),
  databaseIds: z
    .object({
      opportunity: z.string().min(1).optional(),
      application: z.string().min(1).optional(),
      interview: z.string().min(1).optional(),
      follow_up: z.string().min(1).optional(),
    })
    .optional(),
});
export type NotionConfig = z.infer<typeof notionConfigSchema>;
export type NotionDatabaseIds = Partial<Record<ConnectorEntityKind, string>>;

export type NotionRichTextItem = {
  plain_text?: string;
  text?: { content?: string } | null;
};

export type NotionObject = {
  object?: string;
  id: string;
  url?: string;
  title?: NotionRichTextItem[];
  properties?: Record<string, unknown>;
};

export type NotionList<T> = {
  results?: T[];
  has_more?: boolean;
  next_cursor?: string | null;
};

export type NotionSearchFilter = {
  property: "object";
  value: "database" | "page";
};

/** Notion's error envelope: `{ object: "error", status, code, message }`. */
type NotionErrorBody = {
  code?: unknown;
  message?: unknown;
};

export type NotionRequest = {
  token: string;
  fetchImpl: typeof fetch;
  method: "GET" | "POST" | "PATCH";
  /** Path below `/v1`, e.g. `search` or `databases/<id>/query`. */
  path: string;
  body?: unknown;
  timeoutMs?: number;
};

/** Plain text of a Notion rich-text array (database titles, title cells). */
export function plainText(
  items: NotionRichTextItem[] | undefined | null,
): string {
  if (!Array.isArray(items)) return "";
  return items
    .map((item) => item.plain_text ?? item.text?.content ?? "")
    .join("");
}

/**
 * Notion deep link for a page or database: the browser form is the id with
 * dashes stripped, which is what the dashboard and agent trace link to.
 */
export function notionUrlFromId(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, "")}`;
}

/**
 * Map a Notion failure onto our error taxonomy. `401`/`unauthorized` and
 * `404`/`object_not_found` stay distinguishable so `status()` can degrade to
 * `connected: false` instead of blowing up the request.
 */
function toNotionError(args: {
  status: number;
  path: string;
  method: string;
  body: NotionErrorBody | null;
}) {
  const rawCode = args.body?.code;
  const rawMessage = args.body?.message;
  const code =
    typeof rawCode === "string" && rawCode.trim() !== ""
      ? rawCode
      : `http_${args.status}`;
  const message =
    typeof rawMessage === "string" && rawMessage.trim() !== ""
      ? rawMessage
      : `Notion request failed (${args.status}).`;
  const summary = `Notion ${args.method} ${args.path} failed (${args.status} ${code}): ${message}`;

  if (args.status === 401 || code === "unauthorized") {
    return unauthorized(summary);
  }
  if (args.status === 404 || code === "object_not_found") {
    return notFound(summary);
  }
  return upstreamError(summary, { status: args.status, code });
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  args: { timeoutMs: number; init: RequestInit },
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);

  try {
    return await fetchImpl(url, { ...args.init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw requestTimeout(
        `Notion request timed out after ${args.timeoutMs}ms for ${url}.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function notionRequest<T>(request: NotionRequest): Promise<T> {
  const url = `${NOTION_API_BASE}/${request.path}`;
  const init: RequestInit = {
    method: request.method,
    headers: {
      Authorization: `Bearer ${request.token}`,
      "Notion-Version": NOTION_API_VERSION,
      "Content-Type": "application/json",
    },
    ...(request.body === undefined
      ? {}
      : { body: JSON.stringify(request.body) }),
  };

  let lastError: unknown;
  for (let attempt = 1; attempt <= NOTION_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetchWithTimeout(request.fetchImpl, url, {
      timeoutMs: request.timeoutMs ?? NOTION_HTTP_TIMEOUT_MS,
      init,
    });

    if (response.ok) {
      return (await response.json()) as T;
    }

    const body: NotionErrorBody | null = await response
      .json()
      .catch(() => null);
    lastError = toNotionError({
      status: response.status,
      path: request.path,
      method: request.method,
      body,
    });

    // Rate limits and server faults are the only retryable Notion failures.
    const retryable =
      response.status === 429 ||
      (response.status >= 500 && response.status <= 599);
    if (!retryable || attempt === NOTION_MAX_ATTEMPTS) {
      throw lastError;
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    await delay(backoffDelayMs(attempt, retryAfterMs));
  }

  throw lastError;
}

export async function search(
  token: string,
  fetchImpl: typeof fetch,
  query: string,
  filter?: NotionSearchFilter,
  startCursor?: string,
): Promise<NotionList<NotionObject>> {
  return notionRequest<NotionList<NotionObject>>({
    token,
    fetchImpl,
    method: "POST",
    path: "search",
    body: {
      query,
      page_size: NOTION_PAGE_SIZE,
      ...(filter ? { filter } : {}),
      ...(startCursor ? { start_cursor: startCursor } : {}),
    },
  });
}

/** Every database the integration can see, for title-based lane resolution. */
export async function searchDatabases(
  token: string,
  fetchImpl: typeof fetch,
  query = "",
): Promise<NotionObject[]> {
  const all: NotionObject[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < NOTION_MAX_SEARCH_PAGES; page += 1) {
    const response = await search(
      token,
      fetchImpl,
      query,
      { property: "object", value: "database" },
      cursor,
    );
    all.push(...(response.results ?? []));
    if (!response.has_more || !response.next_cursor) break;
    cursor = response.next_cursor;
  }

  return all;
}

export async function createDatabase(
  token: string,
  fetchImpl: typeof fetch,
  parentPageId: string,
  title: string,
  properties: Record<string, unknown>,
): Promise<NotionObject> {
  return notionRequest<NotionObject>({
    token,
    fetchImpl,
    method: "POST",
    path: "databases",
    body: {
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: title } }],
      properties,
    },
  });
}

export async function retrieveDatabase(
  token: string,
  fetchImpl: typeof fetch,
  databaseId: string,
): Promise<NotionObject> {
  return notionRequest<NotionObject>({
    token,
    fetchImpl,
    method: "GET",
    path: `databases/${databaseId}`,
  });
}

export async function queryDatabase(
  token: string,
  fetchImpl: typeof fetch,
  databaseId: string,
  filter?: Record<string, unknown>,
  startCursor?: string,
): Promise<NotionList<NotionObject>> {
  return notionRequest<NotionList<NotionObject>>({
    token,
    fetchImpl,
    method: "POST",
    path: `databases/${databaseId}/query`,
    body: {
      page_size: NOTION_PAGE_SIZE,
      ...(filter ? { filter } : {}),
      ...(startCursor ? { start_cursor: startCursor } : {}),
    },
  });
}

/** `queryDatabase` with the cursor loop drained. */
export async function queryAll(
  token: string,
  fetchImpl: typeof fetch,
  databaseId: string,
  filter?: Record<string, unknown>,
): Promise<NotionObject[]> {
  const all: NotionObject[] = [];
  let cursor: string | undefined;

  do {
    const response = await queryDatabase(
      token,
      fetchImpl,
      databaseId,
      filter,
      cursor,
    );
    all.push(...(response.results ?? []));
    cursor =
      response.has_more && response.next_cursor
        ? response.next_cursor
        : undefined;
  } while (cursor);

  return all;
}

export async function createPage(
  token: string,
  fetchImpl: typeof fetch,
  databaseId: string,
  properties: Record<string, unknown>,
): Promise<NotionObject> {
  return notionRequest<NotionObject>({
    token,
    fetchImpl,
    method: "POST",
    path: "pages",
    body: {
      parent: { type: "database_id", database_id: databaseId },
      properties,
    },
  });
}

export async function updatePage(
  token: string,
  fetchImpl: typeof fetch,
  pageId: string,
  properties: Record<string, unknown>,
): Promise<NotionObject> {
  return notionRequest<NotionObject>({
    token,
    fetchImpl,
    method: "PATCH",
    path: `pages/${pageId}`,
    body: { properties },
  });
}
