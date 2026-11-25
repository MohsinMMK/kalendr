/**
 * Shared Sentry settings for the server, the browser and the worker. Error reporting
 * stays off unless a DSN is set, and anything sent is stripped of personal data first:
 * no request bodies, cookies, headers or query strings, no user, no console output,
 * and messages scrubbed for phone numbers, emails and link tokens.
 */
import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";

import { redact, redactText } from "./redact";

export function scrubEvent(event: ErrorEvent): ErrorEvent | null {
  if (event.request) {
    const url = event.request.url ? redactText(event.request.url.split("?")[0] ?? "") : undefined;
    event.request = { ...(url ? { url } : {}), ...(event.request.method ? { method: event.request.method } : {}) };
  }
  delete event.user;
  delete event.server_name;
  if (event.message) event.message = redactText(event.message);
  if (event.transaction) event.transaction = redactText(event.transaction);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = redactText(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars;
      if (frame.pre_context) delete frame.pre_context;
      if (frame.context_line) delete frame.context_line;
      if (frame.post_context) delete frame.post_context;
    }
  }
  if (event.extra) event.extra = redact(event.extra);
  if (event.contexts) event.contexts = redact(event.contexts);
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.flatMap((crumb) => {
      const cleaned = scrubBreadcrumb(crumb);
      return cleaned ? [cleaned] : [];
    });
  }
  return event;
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  // Console lines and typed input can hold anything; they are never sent.
  if (breadcrumb.category === "console" || breadcrumb.category === "ui.input") return null;
  const cleaned: Breadcrumb = { ...breadcrumb };
  if (cleaned.message) cleaned.message = redactText(cleaned.message);
  if (cleaned.data) {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(cleaned.data)) {
      if (key === "url" || key === "from" || key === "to") {
        data[key] = typeof value === "string" ? redactText(value.split("?")[0] ?? "") : undefined;
      } else if (key === "method" || key === "status_code") {
        data[key] = value;
      }
    }
    cleaned.data = data;
  }
  return cleaned;
}

/** Options every Sentry.init in this app shares. */
export const sharedSentryOptions = {
  sendDefaultPii: false,
  // Traces go to OpenTelemetry; Sentry only receives errors, linked to the active trace.
  tracesSampleRate: undefined,
  maxBreadcrumbs: 30,
  beforeSend: scrubEvent,
  beforeBreadcrumb: scrubBreadcrumb,
} as const;
