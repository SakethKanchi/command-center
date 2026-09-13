/**
 * Gmail send connector: the outbound half of the multi-app agent.
 *
 * Every network call goes through `ctx.fetchImpl`, never the global `fetch`,
 * so the whole send path — token refresh, retry, MIME assembly — is
 * exercisable offline against a stub.
 */

import { setTimeout as sleep } from "node:timers/promises";
import type {
  ConnectorAdapterContext,
  ConnectorHealth,
  OutboundEmailAdapter,
  OutboundEmailRequest,
  OutboundEmailResult,
} from "@domain";
import { nowIso } from "@server/db";
import type { AppError } from "@server/infra/errors";
import {
  badRequest,
  notFound,
  requestTimeout,
  serviceUnavailable,
  toAppError,
  unauthorized,
  upstreamError,
} from "@server/infra/errors";
import { logger } from "@server/infra/logger";
import { backoffDelayMs, parseRetryAfterMs } from "@server/infra/retry";
import { z } from "zod";
import { resolveGmailSendTransport } from "../composio/transport";
import {
  buildMimeMessage,
  formatAddress,
  readAttachments,
  toBase64Url,
} from "./mime";

/** Scope the consent URL must request for `messages.send` to be authorized. */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

const GMAIL_PROFILE_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const GMAIL_SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SENT_MAILBOX_URL = "https://mail.google.com/mail/u/0/#sent";

const MAX_ATTEMPTS = 3;
const GMAIL_HTTP_TIMEOUT_MS = 15_000;
/** Refresh a little early so a token cannot expire mid-flight. */
const ACCESS_TOKEN_SKEW_MS = 60_000;
const DEFAULT_TOKEN_TTL_SECONDS = 3600;

const credentialsSchema = z.object({
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().min(1),
  refreshToken: z.string().trim().min(1),
  accessToken: z.string().trim().min(1).nullish(),
  accessTokenExpiresAt: z.number().finite().nullish(),
});

const configSchema = z.object({
  fromAddress: z.string().trim().email(),
  displayName: z.string().trim().min(1).nullish(),
});

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().finite().optional(),
});

const profileResponseSchema = z.object({
  emailAddress: z.string().min(1),
});

const sendResponseSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1).optional(),
});

const googleErrorSchema = z.object({
  error: z.union([
    z.string(),
    z.object({
      message: z.string().optional(),
      status: z.string().optional(),
    }),
  ]),
  error_description: z.string().optional(),
});

export type GmailSendCredentials = z.infer<typeof credentialsSchema>;
export type GmailSendConfig = z.infer<typeof configSchema>;

type HttpAttempt = {
  ok: boolean;
  status: number;
  bodyText: string;
  json: unknown;
};

export const gmailSendAdapter: OutboundEmailAdapter = {
  key: "gmail_send",

  async connect(ctx: ConnectorAdapterContext): Promise<ConnectorHealth> {
    const config = parseConfig(ctx);
    const accessToken = await authorize(ctx);
    const mailbox = await fetchMailboxAddress(ctx, accessToken);
    assertSenderMatchesMailbox(config.fromAddress, mailbox);

    logger.info("gmail send connector connected", {
      accountKey: ctx.connector.accountKey,
      mailbox,
    });

    return {
      provider: "gmail_send",
      accountKey: ctx.connector.accountKey,
      connected: true,
      status: "connected",
      target: mailbox,
      destinationUrl: SENT_MAILBOX_URL,
      lastSyncedAt: ctx.connector.lastSyncedAt,
      lastError: null,
    };
  },

  async status(ctx: ConnectorAdapterContext): Promise<ConnectorHealth> {
    try {
      const config = parseConfig(ctx);
      const accessToken = await authorize(ctx);
      const mailbox = await fetchMailboxAddress(ctx, accessToken);
      assertSenderMatchesMailbox(config.fromAddress, mailbox);

      return {
        provider: "gmail_send",
        accountKey: ctx.connector.accountKey,
        connected: true,
        status: "connected",
        target: mailbox,
        destinationUrl: SENT_MAILBOX_URL,
        lastSyncedAt: ctx.connector.lastSyncedAt,
        lastError: null,
      };
    } catch (error) {
      // A health probe reports; it never throws, or the dashboard cannot
      // render a broken connector.
      const appError = toAppError(error);
      logger.warn("gmail send connector status probe failed", {
        accountKey: ctx.connector.accountKey,
        code: appError.code,
        message: appError.message,
      });

      return {
        provider: "gmail_send",
        accountKey: ctx.connector.accountKey,
        connected: false,
        status: "error",
        target: configuredFromAddress(ctx),
        destinationUrl: SENT_MAILBOX_URL,
        lastSyncedAt: ctx.connector.lastSyncedAt,
        lastError: appError.message,
      };
    }
  },

  /**
   * One line of dispatch, then the same implementation as before. The direct
   * transport is preferred whenever this connector row holds OAuth
   * credentials; Composio is the fallback that needs no Google Cloud project.
   */
  async send(
    ctx: ConnectorAdapterContext,
    request: OutboundEmailRequest,
  ): Promise<OutboundEmailResult> {
    return resolveGmailSendTransport({
      connector: ctx.connector,
      fetchImpl: ctx.fetchImpl,
      hasDirectCredentials: credentialsSchema.safeParse(
        ctx.connector.credentials ?? {},
      ).success,
      direct: { mode: "direct", send: (input) => sendDirect(ctx, input) },
    }).send(request);
  },

  async disconnect(ctx: ConnectorAdapterContext): Promise<ConnectorHealth> {
    const credentials = credentialsSchema.safeParse(
      ctx.connector.credentials ?? {},
    );

    if (credentials.success) {
      try {
        // Revocation is best effort and never retried: an already-revoked or
        // unknown token answers 4xx, and the connector is locally
        // disconnected either way.
        const attempt = await requestWithRetry(ctx, {
          url: `${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(credentials.data.refreshToken)}`,
          label: "token revoke",
          maxAttempts: 1,
          init: {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
          },
        });
        if (!attempt.ok) {
          logger.warn("gmail send token revoke returned non-2xx", {
            accountKey: ctx.connector.accountKey,
            status: attempt.status,
          });
        }
      } catch (error) {
        logger.warn("gmail send token revoke failed", {
          accountKey: ctx.connector.accountKey,
          message: toAppError(error).message,
        });
      }
    }

    return {
      provider: "gmail_send",
      accountKey: ctx.connector.accountKey,
      connected: false,
      status: "disconnected",
      target: configuredFromAddress(ctx),
      destinationUrl: null,
      lastSyncedAt: ctx.connector.lastSyncedAt,
      lastError: null,
    };
  },
};

/**
 * The direct Gmail transport, unchanged: MIME assembled locally, token
 * refreshed from the connector row, `users.messages.send` called through the
 * injected fetch. Lifted out of the adapter only so the Composio fallback can
 * sit behind the same interface.
 */
async function sendDirect(
  ctx: ConnectorAdapterContext,
  request: OutboundEmailRequest,
): Promise<OutboundEmailResult> {
  const config = parseConfig(ctx);

  // Everything that can fail locally fails before the first network call:
  // a bad attachment path or an injected header must never leave a
  // half-sent message behind.
  const attachments = await readAttachments(request);
  const mime = buildMimeMessage(
    request,
    formatAddress(config.fromAddress, config.displayName),
    { attachments },
  );
  const raw = toBase64Url(mime);

  const accessToken = await authorize(ctx);
  const threadId = trimmedOrNull(request.threadId);
  const attempt = await requestWithRetry(ctx, {
    url: GMAIL_SEND_URL,
    label: "message send",
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
    },
  });
  if (!attempt.ok) throw mapGmailError("Gmail message send", attempt);

  const parsed = sendResponseSchema.safeParse(attempt.json);
  if (!parsed.success) {
    throw upstreamError(
      "Gmail send response did not include a message id.",
      attempt.bodyText.slice(0, 500),
    );
  }

  const sentAt = nowIso();
  logger.info("gmail send delivered", {
    accountKey: ctx.connector.accountKey,
    messageId: parsed.data.id,
    threadId: parsed.data.threadId ?? threadId,
    attachments: attachments.length,
  });

  return {
    messageId: parsed.data.id,
    threadId: parsed.data.threadId ?? threadId ?? parsed.data.id,
    to: request.to.trim(),
    subject: request.subject,
    sentAt,
    webUrl: `https://mail.google.com/mail/u/0/#all/${parsed.data.id}`,
  };
}

/**
 * Mirrors `resolveGmailAccessToken` from the inbound ingestion module rather
 * than reusing it, for two reasons that make reuse impossible: that helper
 * reads the OAuth client from `process.env` (a connector's client lives on the
 * connector row, never in code or env), and it calls the global `fetch`, while
 * an adapter must issue every request through the injected implementation.
 */
export async function resolveSendAccessToken(
  credentials: GmailSendCredentials,
  fetchImpl: typeof fetch,
): Promise<{ credentials: GmailSendCredentials; refreshed: boolean }> {
  if (
    credentials.accessToken &&
    credentials.accessTokenExpiresAt &&
    credentials.accessTokenExpiresAt > Date.now() + ACCESS_TOKEN_SKEW_MS
  ) {
    return { credentials, refreshed: false };
  }

  const attempt = await requestWithRetry(
    { fetchImpl },
    {
      url: GOOGLE_TOKEN_URL,
      label: "token refresh",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken,
        }).toString(),
      },
    },
  );

  if (!attempt.ok) {
    if (attempt.status >= 400 && attempt.status < 500) {
      throw unauthorized(
        `Gmail token refresh was rejected: ${describeGoogleError(attempt)}. Re-authorize the connector.`,
      );
    }
    throw mapGmailError("Gmail token refresh", attempt);
  }

  const parsed = tokenResponseSchema.safeParse(attempt.json);
  if (!parsed.success) {
    throw upstreamError(
      "Gmail token refresh response did not include access_token.",
    );
  }

  const ttlSeconds = parsed.data.expires_in ?? DEFAULT_TOKEN_TTL_SECONDS;
  return {
    credentials: {
      ...credentials,
      accessToken: parsed.data.access_token,
      accessTokenExpiresAt: Date.now() + ttlSeconds * 1000,
    },
    refreshed: true,
  };
}

async function authorize(ctx: ConnectorAdapterContext): Promise<string> {
  const parsed = credentialsSchema.safeParse(ctx.connector.credentials ?? {});
  if (!parsed.success) {
    throw badRequest(
      "Gmail send connector credentials are missing or malformed.",
      parsed.error.flatten().fieldErrors,
    );
  }

  const resolved = await resolveSendAccessToken(parsed.data, ctx.fetchImpl);
  if (resolved.refreshed) {
    // Hand the fresh token back so the next call skips the refresh round trip.
    ctx.onCredentialsRefreshed?.({ ...resolved.credentials });
  }

  const accessToken = resolved.credentials.accessToken;
  if (!accessToken) {
    throw unauthorized("Gmail send connector has no usable access token.");
  }
  return accessToken;
}

function parseConfig(ctx: ConnectorAdapterContext): GmailSendConfig {
  const parsed = configSchema.safeParse(ctx.connector.config ?? {});
  if (!parsed.success) {
    throw badRequest(
      "Gmail send connector config must provide a valid fromAddress.",
      parsed.error.flatten().fieldErrors,
    );
  }
  return parsed.data;
}

async function fetchMailboxAddress(
  ctx: ConnectorAdapterContext,
  accessToken: string,
): Promise<string> {
  const attempt = await requestWithRetry(ctx, {
    url: GMAIL_PROFILE_URL,
    label: "profile lookup",
    init: {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  });
  if (!attempt.ok) throw mapGmailError("Gmail profile lookup", attempt);

  const parsed = profileResponseSchema.safeParse(attempt.json);
  if (!parsed.success) {
    throw upstreamError(
      "Gmail profile response did not include an emailAddress.",
    );
  }
  return parsed.data.emailAddress;
}

/**
 * Sending as an address the token does not own is the worst failure mode in
 * this connector: Gmail would silently rewrite the sender, and the recruiter
 * would see a mismatch the user never approved. Fail loudly instead.
 */
function assertSenderMatchesMailbox(
  fromAddress: string,
  mailbox: string,
): void {
  if (bareAddress(fromAddress) !== bareAddress(mailbox)) {
    throw badRequest(
      `Gmail send connector is configured to send as "${fromAddress}" but the authenticated mailbox is "${mailbox}". Re-authorize with the intended account or fix fromAddress.`,
    );
  }
}

function bareAddress(value: string): string {
  const angled = /<([^>]+)>/.exec(value);
  return (angled?.[1] ?? value).trim().toLowerCase();
}

function configuredFromAddress(ctx: ConnectorAdapterContext): string | null {
  const parsed = configSchema.safeParse(ctx.connector.config ?? {});
  return parsed.success ? parsed.data.fromAddress : null;
}

/**
 * One HTTP call with a timeout and bounded retries.
 *
 * Only 429 and 5xx are retried: those are definitive non-deliveries. A 4xx is
 * a validation failure that a retry cannot fix, and a timeout or transport
 * error may have already delivered the message, so neither is re-sent.
 */
async function requestWithRetry(
  ctx: Pick<ConnectorAdapterContext, "fetchImpl">,
  args: {
    url: string;
    label: string;
    init: RequestInit;
    maxAttempts?: number;
  },
): Promise<HttpAttempt> {
  const maxAttempts = args.maxAttempts ?? MAX_ATTEMPTS;
  let attemptNumber = 0;

  for (;;) {
    attemptNumber += 1;
    const response = await fetchWithTimeout(ctx.fetchImpl, args.url, args.init);
    const bodyText = await response.text().catch(() => "");
    const attempt: HttpAttempt = {
      ok: response.ok,
      status: response.status,
      bodyText,
      json: parseJsonOrNull(bodyText),
    };

    const retryable = attempt.status === 429 || attempt.status >= 500;
    if (attempt.ok || !retryable || attemptNumber >= maxAttempts) {
      return attempt;
    }

    const waitMs = backoffDelayMs(
      attemptNumber,
      parseRetryAfterMs(response.headers.get("Retry-After")),
    );
    logger.warn("gmail send request retrying", {
      label: args.label,
      status: attempt.status,
      attempt: attemptNumber,
      waitMs,
    });
    await sleep(waitMs);
  }
}

/**
 * A deadline around the injected `fetchImpl`. Gmail occasionally holds a send
 * open far longer than it will ever succeed in, and an agent step that hangs
 * is worse than one that fails: the run stalls with no recorded outcome.
 */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GMAIL_HTTP_TIMEOUT_MS);

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    const aborted =
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError";
    if (aborted) {
      throw requestTimeout(
        `Gmail request timed out after ${GMAIL_HTTP_TIMEOUT_MS}ms for ${url}.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function mapGmailError(label: string, attempt: HttpAttempt): AppError {
  const message = `${label} failed: ${describeGoogleError(attempt)}`;
  if (attempt.status === 401) return unauthorized(message);
  if (attempt.status === 403) {
    return unauthorized(`${message}. Missing the ${GMAIL_SEND_SCOPE} scope?`);
  }
  if (attempt.status === 404) return notFound(message);
  if (attempt.status === 429) {
    return serviceUnavailable(
      `${message}. Gmail rate limited the request after ${MAX_ATTEMPTS} attempts.`,
    );
  }
  if (attempt.status >= 400 && attempt.status < 500) return badRequest(message);
  return upstreamError(message);
}

function describeGoogleError(attempt: HttpAttempt): string {
  const parsed = googleErrorSchema.safeParse(attempt.json);
  if (parsed.success) {
    const { error, error_description } = parsed.data;
    const detail =
      typeof error === "string" ? (error_description ?? error) : error.message;
    if (detail) return `${detail} (HTTP ${attempt.status})`;
  }
  const snippet = attempt.bodyText.trim().slice(0, 200);
  return snippet === ""
    ? `HTTP ${attempt.status}`
    : `${snippet} (HTTP ${attempt.status})`;
}

function parseJsonOrNull(bodyText: string): unknown {
  if (bodyText.trim() === "") return null;
  try {
    return JSON.parse(bodyText);
  } catch {
    return null;
  }
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}
