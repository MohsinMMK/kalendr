import type { ZodType } from "zod";

import { ApiError, type FieldErrors } from "@/server/api-error";
import { reportServerError } from "@/server/error-reporting";
import { clientAddress, hitRateLimit, recordRefusal, type RateLimitResult } from "@/server/rate-limit";
import { rateLimitRules, type RateLimitRuleName } from "@/server/rate-limit-rules";
import { errorTenant } from "@/server/request-context";

const MAX_JSON_BODY_BYTES = 16 * 1_024;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/;

export async function parseJsonBody<T>(
  request: Request,
  schema: ZodType<T>,
  options?: { maxBytes?: number },
): Promise<T> {
  const maxBytes = options?.maxBytes ?? MAX_JSON_BODY_BYTES;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== "application/json") {
    throw new ApiError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json.",
    );
  }

  const declaredLength = Number.parseInt(
    request.headers.get("content-length") ?? "0",
    10,
  );
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ApiError(413, "request_too_large", "The request is too large.");
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > maxBytes) {
    throw new ApiError(413, "request_too_large", "The request is too large.");
  }

  let value: unknown;
  try {
    value = JSON.parse(rawBody) as unknown;
  } catch {
    throw new ApiError(400, "invalid_json", "The request body is not valid JSON.");
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(
      400,
      "validation_error",
      "Please check the highlighted fields.",
      toFieldErrors(result.error.flatten().fieldErrors),
    );
  }
  return result.data;
}

/** Reads a request's query string with a schema; a bad one is a 400 with field errors, not a server fault. */
export function parseQuery<T>(request: Request, schema: ZodType<T>): T {
  const result = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!result.success) {
    throw new ApiError(400, "validation_error", "Please check the highlighted fields.", toFieldErrors(result.error.flatten().fieldErrors));
  }
  return result.data;
}

export function getIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ApiError(
      400,
      "invalid_idempotency_key",
      "A valid Idempotency-Key header is required.",
    );
  }
  return key;
}

export function dataResponse<T>(data: T, status = 200): Response {
  return Response.json(
    { data },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export function routeErrorResponse(
  error: unknown,
  context: string,
  requestId: string,
): Response {
  if (error instanceof ApiError) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
          ...(error.details ? { details: error.details } : {}),
        },
      },
      {
        status: error.status,
        headers: {
          ...error.headers,
          "Cache-Control": "no-store",
          "X-Request-Id": requestId,
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }

  // Server-caused failures only. The logger and the error report carry the request id,
  // tenant and route, never the request body, contact details or the database message.
  reportServerError(error, { requestId, route: context, tenantId: errorTenant(error) });

  return Response.json(
    {
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
      },
    },
    {
      status: 500,
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function toFieldErrors(
  errors: Record<string, string[] | undefined>,
): FieldErrors {
  return Object.fromEntries(
    Object.entries(errors).flatMap(([field, messages]) =>
      messages?.length ? [[field, messages]] : [],
    ),
  );
}

/**
 * Counts this request against a rule (src/server/rate-limit-rules.ts) and throws a 429 with
 * Retry-After once the limit is passed. `key` defaults to the client's IP address; pass a
 * contact, email or token for the per-key rules. Returns the count so a route can ask for a
 * bot check when the request looks risky.
 */
export async function enforceLimit(
  request: Request,
  rule: RateLimitRuleName,
  key: string = clientAddress(request.headers),
): Promise<RateLimitResult> {
  const result = await hitRateLimit(rule, key);
  if (!result.allowed) {
    recordRefusal(rule);
    throw new ApiError(429, "rate_limited", rateLimitRules[rule].message, undefined, {
      "Retry-After": String(result.retryAfterSeconds),
    });
  }
  return result;
}
