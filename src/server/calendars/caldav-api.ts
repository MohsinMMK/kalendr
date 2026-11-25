/**
 * The narrow slice of CalDAV that the adapter needs, and its `tsdav` implementation.
 * Tests replace this interface with an in-memory one; nothing else in the adapter
 * knows `tsdav` exists.
 */
import { CalendarProviderError, errorFromStatus } from "./errors";
import type { CalDavCredentials } from "./provider";

export interface CalDavCalendar {
  /** Absolute collection URL: this is the calendar id Kalendr stores. */
  url: string;
  name: string;
  /** Changes whenever anything in the calendar changes. Either may be missing. */
  ctag: string | null;
  syncToken: string | null;
  supportsEvents: boolean;
}

export interface CalDavObject {
  url: string;
  etag: string | null;
  data: string;
}

export interface CalDavApi {
  listCalendars(): Promise<CalDavCalendar[]>;
  fetchEvents(calendarUrl: string, range: { start: Date; end: Date }): Promise<CalDavObject[]>;
  /** Creates only when nothing exists at `filename` (If-None-Match: *). A clash throws `conflict`. */
  createObject(input: { calendarUrl: string; filename: string; data: string }): Promise<{ etag: string | null }>;
  updateObject(input: { url: string; data: string; etag: string | null }): Promise<{ etag: string | null }>;
  deleteObject(input: { url: string; etag: string | null }): Promise<void>;
  /** One object, or null when it is not there. */
  getObject(url: string): Promise<CalDavObject | null>;
}

export type CalDavApiFactory = (credentials: CalDavCredentials) => CalDavApi;

/** iCloud's well-known entry point; the client discovers the per-account host from it. */
export const ICLOUD_SERVER_URL = "https://caldav.icloud.com";

export const createTsdavApi: CalDavApiFactory = (credentials) => {
  const connect = async () => {
    const { createDAVClient } = await import("tsdav");
    return createDAVClient({
      serverUrl: credentials.serverUrl,
      credentials: { username: credentials.username, password: credentials.appPassword },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
  };

  // tsdav throws plain Errors for transport problems and returns Responses for HTTP statuses.
  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (cause) {
      if (cause instanceof CalendarProviderError) throw cause;
      const message = cause instanceof Error ? cause.message : "";
      if (/401|unauthori[sz]ed|authentication/i.test(message)) {
        throw new CalendarProviderError("revoked", "caldav: sign-in was refused", { status: 401, cause });
      }
      throw new CalendarProviderError("transient", "caldav: request failed", { cause });
    }
  };

  const check = (response: Response, context: string): void => {
    if (response.ok) return;
    throw errorFromStatus(response.status, context, null);
  };

  const etagOf = (response: Response): string | null => response.headers.get("etag");

  return {
    listCalendars: () =>
      guard(async () => {
        const client = await connect();
        const calendars = await client.fetchCalendars();
        return calendars.map((calendar) => ({
          url: calendar.url,
          name: typeof calendar.displayName === "string" && calendar.displayName ? calendar.displayName : calendar.url,
          ctag: calendar.ctag ?? null,
          syncToken: calendar.syncToken ?? null,
          supportsEvents: !calendar.components || calendar.components.includes("VEVENT"),
        }));
      }),

    fetchEvents: (calendarUrl, range) =>
      guard(async () => {
        const client = await connect();
        const objects = await client.fetchCalendarObjects({
          calendar: { url: calendarUrl },
          timeRange: { start: range.start.toISOString(), end: range.end.toISOString() },
        });
        return objects.flatMap((object) =>
          typeof object.data === "string" ? [{ url: object.url, etag: object.etag ?? null, data: object.data }] : [],
        );
      }),

    createObject: ({ calendarUrl, filename, data }) =>
      guard(async () => {
        const client = await connect();
        const response = await client.createCalendarObject({ calendar: { url: calendarUrl }, filename, iCalString: data });
        check(response, "caldav.create");
        return { etag: etagOf(response) };
      }),

    updateObject: ({ url, data, etag }) =>
      guard(async () => {
        const client = await connect();
        const response = await client.updateCalendarObject({ calendarObject: { url, data, etag: etag ?? undefined } });
        check(response, "caldav.update");
        return { etag: etagOf(response) };
      }),

    deleteObject: ({ url, etag }) =>
      guard(async () => {
        const client = await connect();
        const response = await client.deleteCalendarObject({ calendarObject: { url, etag: etag ?? undefined } });
        // Already gone is what the caller wanted.
        if (response.status === 404 || response.status === 410) return;
        check(response, "caldav.delete");
      }),

    getObject: (url) =>
      guard(async () => {
        const client = await connect();
        const objects = await client.fetchCalendarObjects({ calendar: { url: url.replace(/[^/]*$/, "") }, objectUrls: [url] });
        const found = objects.find((object) => typeof object.data === "string");
        return found && typeof found.data === "string" ? { url: found.url, etag: found.etag ?? null, data: found.data } : null;
      }),
  };
};
