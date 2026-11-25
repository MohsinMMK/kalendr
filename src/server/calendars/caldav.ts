/**
 * Apple iCloud (and any CalDAV server) adapter.
 *
 * Sign-in is an app-specific password the person creates at appleid.apple.com; their
 * Apple ID password is never asked for or stored. CalDAV has no push, so the worker
 * polls every few minutes: `syncChanges` compares the calendar's change tag (sync-token,
 * else ctag) with the stored one and only re-reads events when it moved.
 *
 * The server answers a time-range query with whole objects. We read them with a
 * small iCalendar parser that keeps only ids, times and flags (see ical.ts), and expand
 * repeating events inside the window ourselves (see recurrence.ts).
 */
import { randomUUID } from "node:crypto";

import { createTsdavApi, type CalDavApi, type CalDavApiFactory, type CalDavObject } from "./caldav-api";
import { CalendarProviderError, classifyFailure } from "./errors";
import { buildEventIcs, icsTimeToIso, parseEvents, type IcsTime, type ParsedEvent } from "./ical";
import {
  idFromKey,
  type BusyEvent,
  type CalendarProvider,
  type EventInput,
  type EventWriteResult,
  type ProviderCredentials,
  type SyncRequest,
  type SyncResult,
  type WriteOptions,
} from "./provider";
import { expandOccurrences } from "./recurrence";
import { isValidTimeZone } from "./time";

export interface CalDavDeps {
  apiFactory?: CalDavApiFactory;
  now?: () => Date;
}

export function createCalDavProvider(deps: CalDavDeps = {}): CalendarProvider {
  const apiFactory = deps.apiFactory ?? createTsdavApi;
  const now = deps.now ?? (() => new Date());

  const apiFor = (credentials: ProviderCredentials): CalDavApi => {
    if (credentials.kind !== "caldav") throw new TypeError("Expected CalDAV credentials");
    return apiFactory(credentials);
  };

  async function readEtag(api: CalDavApi, url: string, etag: string | null): Promise<string | null> {
    if (etag) return etag;
    return (await api.getObject(url))?.etag ?? null;
  }

  const unsupported = (): never => {
    throw new CalendarProviderError("unsupported", "CalDAV calendars have no push notifications; poll instead");
  };

  return {
    id: "apple",
    supportsPush: false,

    async verifyAccount(credentials) {
      await apiFor(credentials).listCalendars();
      // The Apple ID is the account address; nothing more is read about the person.
      return { accountEmail: credentials.kind === "caldav" ? credentials.username : null };
    },

    async listCalendars(credentials) {
      const calendars = await apiFor(credentials).listCalendars();
      return calendars
        .filter((calendar) => calendar.supportsEvents)
        .map((calendar, index) => ({
          id: calendar.url,
          name: calendar.name,
          primary: index === 0,
          // CalDAV does not say cheaply; a read-only share fails at write time with a clear error.
          canWrite: true,
          timezone: null,
        }));
    },

    async syncChanges(credentials, calendarId, request): Promise<SyncResult> {
      const api = apiFor(credentials);
      const calendars = await api.listCalendars();
      const calendar = calendars.find((candidate) => sameUrl(candidate.url, calendarId));
      if (!calendar) throw new CalendarProviderError("not_found", "caldav.syncChanges: calendar not found", { status: 404 });
      const token = calendar.syncToken ?? calendar.ctag;
      if (request.syncToken && token && request.syncToken === token) {
        return { fullResyncRequired: false, mode: "delta", events: [], nextSyncToken: token, unsupportedRecurrences: 0 };
      }
      const objects = await api.fetchEvents(calendar.url, { start: request.from, end: request.to });
      const { events, unsupportedRecurrences } = busyFromObjects(objects, request);
      // Whatever changed, we re-read the whole window, so this is a snapshot, never a delta.
      return { fullResyncRequired: false, mode: "snapshot", events, nextSyncToken: token, unsupportedRecurrences };
    },

    async createEvent(credentials, calendarId, input) {
      const api = apiFor(credentials);
      const uid = input.idempotencyKey ? `kalendr-${idFromKey(input.idempotencyKey).slice(0, 32)}` : `kalendr-${randomUUID().replaceAll("-", "")}`;
      const url = objectUrl(calendarId, uid);
      try {
        const created = await api.createObject({
          calendarUrl: calendarId,
          filename: `${uid}.ics`,
          data: icsFor(uid, input, now()),
        });
        return { eventId: uid, etag: await readEtag(api, url, created.etag) };
      } catch (error) {
        // If-None-Match: * refused because the same key already created it: return that event.
        if (input.idempotencyKey && error instanceof CalendarProviderError && error.kind === "conflict") {
          const existing = await api.getObject(url);
          if (existing) return { eventId: uid, etag: existing.etag };
        }
        throw error;
      }
    },

    async updateEvent(credentials, calendarId, eventId, input, options: WriteOptions = {}): Promise<EventWriteResult> {
      const api = apiFor(credentials);
      const url = objectUrl(calendarId, eventId);
      const updated = await api.updateObject({ url, data: icsFor(eventId, input, now()), etag: options.etag ?? null });
      return { eventId, etag: await readEtag(api, url, updated.etag) };
    },

    async deleteEvent(credentials, calendarId, eventId, options: WriteOptions = {}) {
      await apiFor(credentials).deleteObject({ url: objectUrl(calendarId, eventId), etag: options.etag ?? null });
    },

    watch: async () => unsupported(),
    stopWatch: async () => unsupported(),
    renewWatch: async () => unsupported(),

    handleAuthFailure: classifyFailure,
  };
}

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

function objectUrl(calendarUrl: string, uid: string): string {
  return `${calendarUrl.replace(/\/+$/, "")}/${uid}.ics`;
}

function icsFor(uid: string, input: EventInput, stamp: Date): string {
  const start = new Date(input.start);
  const end = new Date(input.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new CalendarProviderError("invalid", "caldav: the event needs a start before its end");
  }
  return buildEventIcs({
    uid,
    title: input.title,
    description: input.description,
    location: input.location,
    start,
    end,
    // Every rewrite needs a higher sequence than the last; seconds since the epoch always grows.
    sequence: Math.floor(stamp.getTime() / 1000),
    stamp,
  });
}

interface Reduced {
  events: BusyEvent[];
  unsupportedRecurrences: number;
}

/** Turns fetched iCalendar objects into busy events for the window. Exported for tests. */
export function busyFromObjects(objects: CalDavObject[], request: Pick<SyncRequest, "from" | "to" | "timezone">): Reduced {
  const fallbackZone = request.timezone && isValidTimeZone(request.timezone) ? request.timezone : "UTC";
  const byId = new Map<string, BusyEvent>();
  let unsupportedRecurrences = 0;

  const byUid = new Map<string, ParsedEvent[]>();
  for (const object of objects) {
    for (const event of parseEvents(object.data)) {
      byUid.set(event.uid, [...(byUid.get(event.uid) ?? []), event]);
    }
  }

  for (const [uid, versions] of byUid) {
    const overrides = versions.filter((version) => version.recurrenceId);
    const masters = versions.filter((version) => !version.recurrenceId);
    const overriddenStarts = new Set(overrides.flatMap((override) => (override.recurrenceId ? [icsTimeToIso(override.recurrenceId, fallbackZone)] : [])));

    for (const master of masters) {
      const timing = timingOf(master, fallbackZone);
      if (!master.rrule) {
        add(byId, busyFrom(uid, master, timing, request));
        continue;
      }
      if (master.status === "CANCELLED") {
        byId.set(uid, { sourceEventId: uid, startsAt: null, endsAt: null, cancelled: true });
        continue;
      }
      const zone = master.start.utc ? "UTC" : (master.start.zone ?? fallbackZone);
      const { occurrences, unsupported } = expandOccurrences({
        start: master.start,
        zone,
        durationMs: timing.durationMs,
        rrule: master.rrule,
        exdates: master.exdates,
        windowStart: request.from,
        windowEnd: request.to,
      });
      if (unsupported) unsupportedRecurrences += 1;
      for (const occurrence of occurrences) {
        if (overriddenStarts.has(occurrence.startsAt)) continue;
        const startMs = Date.parse(occurrence.startsAt);
        add(byId, {
          sourceEventId: `${uid}#${occurrence.startsAt}`,
          startsAt: occurrence.startsAt,
          endsAt: new Date(startMs + timing.durationMs).toISOString(),
          cancelled: false,
          transparent: master.transparent,
          allDay: master.start.allDay,
        });
      }
    }

    // An edited or cancelled single occurrence: its own times replace the generated ones, and
    // it may have moved into the window from outside it.
    for (const override of overrides) {
      if (!override.recurrenceId) continue;
      const originalIso = icsTimeToIso(override.recurrenceId, fallbackZone);
      add(byId, busyFrom(`${uid}#${originalIso}`, override, timingOf(override, fallbackZone), request));
    }
  }
  return { events: [...byId.values()], unsupportedRecurrences };
}

function add(target: Map<string, BusyEvent>, event: BusyEvent | null): void {
  if (event) target.set(event.sourceEventId, event);
}

interface Timing {
  startsAt: string;
  endsAt: string;
  durationMs: number;
}

function timingOf(event: ParsedEvent, fallbackZone: string): Timing {
  const startsAt = icsTimeToIso(event.start, fallbackZone);
  let endsAt: string;
  if (event.end) endsAt = icsTimeToIso(event.end, fallbackZone);
  else if (event.durationMs !== null) endsAt = new Date(Date.parse(startsAt) + event.durationMs).toISOString();
  else if (event.start.allDay) endsAt = icsTimeToIso(nextDay(event.start), fallbackZone);
  else endsAt = startsAt;
  return { startsAt, endsAt, durationMs: Math.max(0, Date.parse(endsAt) - Date.parse(startsAt)) };
}

function nextDay(time: IcsTime): IcsTime {
  const date = new Date(Date.UTC(time.year, time.month - 1, time.day + 1));
  return { ...time, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function busyFrom(id: string, event: ParsedEvent, timing: Timing, request: Pick<SyncRequest, "from" | "to">): BusyEvent | null {
  const cancelled = event.status === "CANCELLED";
  const inWindow = Date.parse(timing.startsAt) < request.to.getTime() && Date.parse(timing.endsAt) > request.from.getTime();
  if (!cancelled && !inWindow) return null;
  return {
    sourceEventId: id,
    startsAt: timing.startsAt,
    endsAt: timing.endsAt,
    cancelled,
    transparent: event.transparent,
    allDay: event.start.allDay,
  };
}
