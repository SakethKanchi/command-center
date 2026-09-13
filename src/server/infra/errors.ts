/**
 * One error type for the whole server.
 *
 * Every failure that crosses a module boundary carries a stable `code` and an
 * HTTP `status`, so the API layer can serialize any thrown error without a
 * per-route translation table, and the agent trace can record a machine-readable
 * reason next to the human one.
 */

export const ERROR_CODES = [
  "INVALID_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "UNPROCESSABLE",
  "RATE_LIMITED",
  "TIMEOUT",
  "UPSTREAM_ERROR",
  "UNAVAILABLE",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  TIMEOUT: 504,
  UPSTREAM_ERROR: 502,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError("INVALID_REQUEST", message, details);
export const unauthorized = (message = "Unauthorized") =>
  new AppError("UNAUTHORIZED", message);
export const forbidden = (message = "Forbidden") =>
  new AppError("FORBIDDEN", message);
export const notFound = (message = "Not found") =>
  new AppError("NOT_FOUND", message);
export const conflict = (message: string, details?: unknown) =>
  new AppError("CONFLICT", message, details);
export const unprocessable = (message: string, details?: unknown) =>
  new AppError("UNPROCESSABLE", message, details);
export const rateLimited = (message: string, details?: unknown) =>
  new AppError("RATE_LIMITED", message, details);
export const requestTimeout = (message = "Request timed out") =>
  new AppError("TIMEOUT", message);
export const upstreamError = (message: string, details?: unknown) =>
  new AppError("UPSTREAM_ERROR", message, details);
export const serviceUnavailable = (message: string, details?: unknown) =>
  new AppError("UNAVAILABLE", message, details);

/**
 * Coerce anything thrown into an `AppError`.
 *
 * An `AbortError` becomes a TIMEOUT rather than an opaque INTERNAL: every
 * outbound call in this codebase aborts on a deadline, so that mapping is the
 * difference between "the upstream is slow" and "we have a bug".
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return requestTimeout(error.message || "Request timed out");
    }
    return new AppError("INTERNAL", error.message, { name: error.name });
  }
  return new AppError("INTERNAL", String(error));
}
