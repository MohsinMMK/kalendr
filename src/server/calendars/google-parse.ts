/** Parsing and error mapping for the Google adapter: pure functions over provider responses. */
import { z } from "zod";

import { CalendarProviderError, errorFromStatus, parseRetryAfter } from "./errors";
import { parseBody, type HttpResponse } from "./http";
import type { BusyEvent, EventInput, EventWriteResult } from "./provider";
import { dateOnlyToIso, isValidTimeZone, normaliseInstant } from "./time";

export const dateTimeSchema = z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() });
export const eventSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  start: dateTimeSchema.optional(),
  end: dateTimeSchema.optional(),
  transparency: z.string().optional(),
  eventType: z.string().optional(),
  attendees: z.array(z.object({ self: z.boolean().optional(), responseStatus: z.string().optional() })).optional(),
});
export const eventsPageSchema = z.object({
  items: z.array(eventSchema).default([]),
  nextPageToken: z.string().optional(),
  nextSyncToken: z.string().optional(),
  timeZone: z.string().optional(),
});
export const calendarListSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        summary: z.string().optional(),
        summaryOverride: z.string().optional(),
        primary: z.boolean().optional(),
        accessRole: z.string().optional(),
        timeZone: z.string().optional(),
      }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
});
export const writtenEventSchema = z.object({ id: z.string(), etag: z.string().optional() });
export const watchSchema = z.object({
  id: z.string(),
  resourceId: z.string().optional(),
  expiration: z.union([z.string(), z.number()]).optional(),
});
export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).nullish(),
  expiry_date: z.number().nullish(),
  scope: z.string().default(""),
  id_token: z.string().nullish(),
});
export const idTokenPayloadSchema = z.object({ email: z.string().optional() });

export function withQuery(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

export function toWriteResult(body: unknown, context: string): EventWriteResult {
  const parsed = parseBody(writtenEventSchema, body, context);
  return { eventId: parsed.id, etag: parsed.etag ?? null };
}

export function eventBody(input: EventInput): Record<string, unknown> {
  return {
    summary: input.title,
    description: input.description,
    location: input.location,
    start: { dateTime: input.start, timeZone: input.timezone },
    end: { dateTime: input.end, timeZone: input.timezone },
    transparency: "opaque",
  };
}

/** Reduces a Google event to busy-time fields. Returns null for events with no usable time. */
export function toBusyEvent(item: z.infer<typeof eventSchema>, calendarZone: string): BusyEvent | null {
  const cancelled = item.status === "cancelled";
  const startZone = validZone(item.start?.timeZone) ?? validZone(calendarZone) ?? "UTC";
  const endZone = validZone(item.end?.timeZone) ?? startZone;
  const allDay = Boolean(item.start?.date && !item.start.dateTime);
  const startsAt = item.start?.dateTime ? normaliseInstant(item.start.dateTime) : item.start?.date ? dateOnlyToIso(item.start.date, startZone) : null;
  const endsAt = item.end?.dateTime ? normaliseInstant(item.end.dateTime) : item.end?.date ? dateOnlyToIso(item.end.date, endZone) : null;
  if (!cancelled && (!startsAt || !endsAt)) return null;
  const declined = item.attendees?.some((attendee) => attendee.self === true && attendee.responseStatus === "declined") === true;
  const free = item.transparency === "transparent" || item.eventType === "workingLocation" || declined;
  return {
    sourceEventId: item.id,
    startsAt,
    endsAt,
    cancelled,
    transparent: free,
    allDay,
  };
}

export function validZone(zone: string | undefined): string | null {
  return zone && isValidTimeZone(zone) ? zone : null;
}

export function emailFromIdToken(idToken: string | null | undefined): string | null {
  if (!idToken) return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const json: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const parsed = idTokenPayloadSchema.safeParse(json);
    // The token came straight from Google's token endpoint over TLS, so its payload is trusted here.
    return parsed.success ? (parsed.data.email ?? null) : null;
  } catch {
    return null;
  }
}

const googleErrorBodySchema = z.object({
  error: z.union([z.string(), z.object({ errors: z.array(z.object({ reason: z.string().optional() })).optional() })]).optional(),
});

/** Turns a non-2xx Google response into a typed error. */
export function googleStatusError(response: HttpResponse, context: string, now: Date): CalendarProviderError {
  const retryAfter = parseRetryAfter(response.headers["retry-after"], now);
  const parsed = googleErrorBodySchema.safeParse(response.body);
  const reason = parsed.success && typeof parsed.data.error === "object" ? parsed.data.error.errors?.[0]?.reason : undefined;
  if (response.status === 410) return new CalendarProviderError("not_found", `${context}: gone`, { status: 410 });
  if (response.status === 403) {
    if (reason && /ratelimit|quota/i.test(reason)) {
      return new CalendarProviderError("rate_limited", `${context}: rate limited`, { status: 403, retryAfterSeconds: retryAfter ?? 60 });
    }
    if (reason === "insufficientPermissions" || reason === "forbidden" || reason === "authError") {
      return new CalendarProviderError("revoked", `${context}: permission missing`, { status: 403 });
    }
    return new CalendarProviderError("invalid", `${context}: forbidden`, { status: 403 });
  }
  return errorFromStatus(response.status, context, retryAfter);
}

/** Errors thrown by the OAuth client (refresh failures, network) into our taxonomy. */
export function mapThrown(error: unknown, context: string, fallback: "transient" | "invalid" = "transient"): CalendarProviderError {
  if (error instanceof CalendarProviderError) return error;
  const text = describeThrown(error);
  // A wrong client id or secret is this server's setup, not the person's grant: checked first, because Google answers it
  // with a 401 too, and marking every connection revoked for it would make everyone reconnect for nothing.
  if (/invalid_client|unauthorized_client/i.test(text.bodyError ?? text.message)) {
    return new CalendarProviderError("invalid", `${context}: the Google app credentials were rejected`, { status: text.status, cause: error });
  }
  if (/invalid_grant|revoked/i.test(text.bodyError ?? text.message)) {
    return new CalendarProviderError("revoked", `${context}: the Google grant is no longer valid`, { status: text.status, cause: error });
  }
  if (text.status === 401) return new CalendarProviderError("revoked", `${context}: unauthorised`, { status: 401, cause: error });
  if (text.status === 429) return new CalendarProviderError("rate_limited", `${context}: rate limited`, { status: 429, cause: error });
  if (fallback === "invalid" && text.status !== null && text.status < 500) {
    return new CalendarProviderError("invalid", `${context}: rejected`, { status: text.status, cause: error });
  }
  return new CalendarProviderError("transient", `${context}: request failed`, { status: text.status, cause: error });
}

const thrownSchema = z.object({
  message: z.string().optional(),
  status: z.number().optional(),
  response: z.object({ status: z.number().optional(), data: z.unknown().optional() }).optional(),
});

export function describeThrown(error: unknown): { message: string; status: number | null; bodyError: string | null } {
  const parsed = thrownSchema.safeParse(error);
  if (!parsed.success) return { message: "", status: null, bodyError: null };
  const data = z.object({ error: z.string().optional() }).safeParse(parsed.data.response?.data);
  return {
    message: parsed.data.message ?? "",
    status: parsed.data.status ?? parsed.data.response?.status ?? null,
    bodyError: data.success ? (data.data.error ?? null) : null,
  };
}
