/** Shared helpers for the adapter tests. Imported only by `*.test.ts`. */
import type { HttpRequest, HttpResponse, HttpTransport } from "./http";

export const NOW = new Date("2026-11-19T10:00:00.000Z");
export const WINDOW = { from: NOW, to: new Date("2027-02-17T10:00:00.000Z") };

export function json(status: number, body?: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, body };
}

export type Responder = (request: HttpRequest) => HttpResponse | undefined;

/**
 * A scripted HTTP transport: the first responder that answers wins. Every request is
 * recorded so tests can assert on URLs, headers and bodies. An unanswered request fails
 * the test loudly instead of hitting the network.
 */
export function scriptedTransport(...responders: Responder[]): { transport: HttpTransport; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = async (request) => {
    requests.push(request);
    for (const responder of responders) {
      const response = responder(request);
      if (response) return response;
    }
    throw new Error(`Unscripted request: ${request.method} ${request.url}`);
  };
  return { transport, requests };
}

/** Queue of responses consumed in order, regardless of URL. */
export function sequence(...responses: (HttpResponse | Error)[]): Responder {
  const queue = [...responses];
  return () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
}

/** Every key anywhere in a value, to prove no title or attendee field leaks out. */
export function allKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => allKeys(item, keys));
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      keys.add(key);
      allKeys(inner, keys);
    }
  }
  return keys;
}

export const FORBIDDEN_FIELDS = ["title", "summary", "subject", "description", "attendees", "attendee", "location", "body", "organizer"];
