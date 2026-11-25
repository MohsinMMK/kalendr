export type FieldErrors = Record<string, string[]>;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fieldErrors?: FieldErrors;
  /** Extra response headers, such as Retry-After on a 429. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Structured facts for the screen, such as the plan that unlocks a refused feature (`plan_limit`). */
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    status: number,
    code: string,
    message: string,
    fieldErrors?: FieldErrors,
    headers?: Readonly<Record<string, string>>,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
    this.headers = headers;
    this.details = details;
    this.details = details;
  }
}

export function isPostgresError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null &&
    "code" in error && typeof error.code === "string";
}

export function getPostgresErrorCode(error: unknown): string | null {
  const seen = new Set<object>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && typeof current.code === "string" &&
        /^[0-9A-Z]{5}$/.test(current.code)) {
      return current.code;
    }
    current = "cause" in current ? current.cause : null;
  }
  return null;
}

export function getPostgresConstraint(error: unknown): string | null {
  const seen = new Set<object>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("constraint_name" in current && typeof current.constraint_name === "string") {
      return current.constraint_name;
    }
    if ("constraint" in current && typeof current.constraint === "string") {
      return current.constraint;
    }
    current = "cause" in current ? current.cause : null;
  }
  return null;
}

export function mapDatabaseError(error: unknown): ApiError | null {
  const code = getPostgresErrorCode(error);
  if (code === "23P01") {
    return new ApiError(
      409,
      "slot_unavailable",
      "That time is no longer available. Please choose another slot.",
    );
  }
  if (code === "40001" || code === "40P01") {
    return new ApiError(
      503,
      "temporarily_unavailable",
      "The request could not be completed. Please try again.",
    );
  }
  return null;
}
