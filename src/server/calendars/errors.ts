/**
 * One error type for every calendar adapter. The sync worker reads `kind` and never
 * has to know which provider's SDK threw. Messages never carry tokens, titles or
 * addresses: provider response bodies are not copied into them.
 */
import { z } from "zod";

export const failureKindSchema = z.enum(["revoked", "transient", "rate_limited"]);

/** How the worker should treat a failed call. `revoked` means the person must reconnect. */
export type FailureClass =
  | { kind: "revoked" }
  | { kind: "transient" }
  | { kind: "rate_limited"; retryAfterSeconds: number | null };

export type CalendarErrorKind =
  | "revoked" // the token is dead (invalid_grant, 401 after refresh, AADSTS, scope removed)
  | "transient" // network trouble or a 5xx; retry with backoff
  | "rate_limited" // 429 or a quota 403; wait `retryAfterSeconds`
  | "conflict" // If-Match failed: the event changed outside Kalendr
  | "not_found" // the event or calendar is gone
  | "invalid" // the request or the provider's answer was not what we expected
  | "unsupported" // e.g. watch on CalDAV
  | "not_configured"; // client id/secret env vars are empty

export class CalendarProviderError extends Error {
  readonly kind: CalendarErrorKind;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    kind: CalendarErrorKind,
    message: string,
    options: { status?: number | null; retryAfterSeconds?: number | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CalendarProviderError";
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

/** Maps any thrown value to what the worker should do next. Unknown errors are transient. */
export function classifyFailure(error: unknown): FailureClass {
  if (error instanceof CalendarProviderError) {
    if (error.kind === "revoked") return { kind: "revoked" };
    if (error.kind === "rate_limited") return { kind: "rate_limited", retryAfterSeconds: error.retryAfterSeconds };
  }
  return { kind: "transient" };
}

/** Parses a Retry-After header: delta seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now: Date): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now.getTime()) / 1000));
}

/** What an HTTP error status means for every provider; adapters add their own special cases first. */
export function errorFromStatus(
  status: number,
  context: string,
  retryAfterSeconds: number | null,
): CalendarProviderError {
  if (status === 401) return new CalendarProviderError("revoked", `${context}: unauthorised`, { status });
  if (status === 404) return new CalendarProviderError("not_found", `${context}: not found`, { status });
  if (status === 409 || status === 412) {
    return new CalendarProviderError("conflict", `${context}: changed elsewhere`, { status });
  }
  if (status === 429) {
    return new CalendarProviderError("rate_limited", `${context}: rate limited`, { status, retryAfterSeconds });
  }
  if (status >= 500) return new CalendarProviderError("transient", `${context}: provider error ${status}`, { status });
  return new CalendarProviderError("invalid", `${context}: rejected with ${status}`, { status });
}
