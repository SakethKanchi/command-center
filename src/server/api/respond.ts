import { getConfig } from "@server/infra/config";
import { type AppError, toAppError, toPublicError } from "@server/infra/errors";
import { logger } from "@server/infra/logger";
import type { Context } from "hono";

/**
 * Envelope shared by every endpoint.
 *
 * A single discriminated shape means the client has exactly one branch to
 * write, and an error never arrives as a bare string the UI has to guess at.
 */
export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

export function ok<T>(c: Context, data: T, status = 200) {
  return c.json<ApiResponse<T>>({ ok: true, data }, status as 200);
}

export function failure(c: Context, error: AppError) {
  return c.json<ApiResponse<never>>(
    {
      ok: false,
      error: toPublicError(error, {
        redactInternal: getConfig().isProduction,
      }),
    },
    error.status as 400,
  );
}

/**
 * Convert any thrown value into the envelope.
 *
 * Registered once as Hono's `onError`, so a route body can throw `notFound(...)`
 * and get the right status without a try/catch in every handler.
 *
 * An `INTERNAL` is a bug rather than a rejected request, and production hides
 * its text from the client, so it is logged here with the message and stack
 * that the response no longer carries. Without this the redaction would turn a
 * crash into silence.
 */
export function respondWithError(error: unknown, c: Context) {
  const appError = toAppError(error);
  if (appError.code === "INTERNAL") {
    logger.error("Unhandled server error", {
      method: c.req.method,
      path: c.req.path,
      message: appError.message,
      stack: appError.stack,
    });
  }
  return failure(c, appError);
}
