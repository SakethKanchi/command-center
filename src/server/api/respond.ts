import { type AppError, toAppError } from "@server/infra/errors";
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
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    },
    error.status as 400,
  );
}

/**
 * Convert any thrown value into the envelope.
 *
 * Registered once as Hono's `onError`, so a route body can throw `notFound(...)`
 * and get the right status without a try/catch in every handler.
 */
export function respondWithError(error: unknown, c: Context) {
  return failure(c, toAppError(error));
}
