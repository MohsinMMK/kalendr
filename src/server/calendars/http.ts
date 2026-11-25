/**
 * The only way adapters touch the network. Tests hand in a scripted transport, so no
 * test calls a real provider. Response bodies come back as `unknown` and every adapter
 * parses them with zod before using a single field.
 */
import { CalendarProviderError } from "./errors";

export interface HttpRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  /** Sent as JSON unless `form` is set. */
  json?: unknown;
  form?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** Parsed JSON, or undefined when the body was empty or not JSON. */
  body: unknown;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

const REQUEST_TIMEOUT_MS = 15_000;

/** Default transport on the platform `fetch`. Network failures become `transient` errors. */
export function createFetchTransport(fetchImpl: typeof fetch = fetch): HttpTransport {
  return async (request) => {
    const headers = new Headers(request.headers);
    let body: string | undefined;
    if (request.form) {
      body = new URLSearchParams(request.form).toString();
      headers.set("content-type", "application/x-www-form-urlencoded");
    } else if (request.json !== undefined) {
      body = JSON.stringify(request.json);
      headers.set("content-type", "application/json");
    }
    let response: Response;
    try {
      // A provider that never answers must not hold a worker job (and its database transaction) open.
      response = await fetchImpl(request.url, { method: request.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (cause) {
      throw new CalendarProviderError("transient", "Network request to the calendar provider failed", { cause });
    }
    const text = await response.text().catch(() => "");
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });
    return { status: response.status, headers: responseHeaders, body: parsed };
  };
}

/** Parses a provider body; a body of the wrong shape is an `invalid` error, never a crash later. */
export function parseBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, body: unknown, context: string): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new CalendarProviderError("invalid", `${context}: unexpected response shape`);
  }
  return result.data;
}
