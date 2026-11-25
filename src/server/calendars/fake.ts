/**
 * An in-memory calendar provider for tests of the database layer, the worker and the
 * screens. It behaves like a real one where it matters: sync tokens, deltas that report
 * removed events as cancelled, a token that can go stale (full resync), If-Match
 * conflicts, watch channels that expire, a revoked login, and failures on demand.
 * Nothing here touches the network.
 */
import { randomUUID } from "node:crypto";

import { CalendarProviderError, classifyFailure } from "./errors";
import {
  idFromKey,
  type BusyEvent,
  type CalendarInfo,
  type EventInput,
  type EventWriteResult,
  type OAuthCalendarProvider,
  type OAuthExchangeResult,
  type ProviderCredentials,
  type ProviderId,
  type RefreshedTokens,
  type SyncRequest,
  type SyncResult,
  type WatchChannel,
  type WatchRequest,
  type WriteOptions,
} from "./provider";

export type FakeOperation =
  | "verifyAccount"
  | "listCalendars"
  | "syncChanges"
  | "createEvent"
  | "updateEvent"
  | "deleteEvent"
  | "watch"
  | "stopWatch"
  | "renewWatch"
  | "exchangeCode";

export interface FakeEvent {
  id: string;
  startsAt: string;
  endsAt: string;
  cancelled: boolean;
  transparent: boolean;
  allDay: boolean;
  etag: string;
  /** True when Kalendr wrote it through createEvent. */
  createdByKalendr: boolean;
  /** What createEvent was given. Never returned by syncChanges, like a real busy read. */
  writtenTitle: string | null;
  /** The rest of what createEvent or updateEvent was given, for tests that check nothing else was written (feature 50). */
  writtenDescription: string | null;
  writtenLocation: string | null;
  /** Version of its calendar when it last changed, for deltas. */
  changedAt: number;
}

interface FakeCalendar extends CalendarInfo {
  version: number;
  events: Map<string, FakeEvent>;
}

export interface FakeChannel extends WatchChannel {
  calendarId: string;
  callbackUrl: string;
  token: string;
}

export interface FakeOptions {
  id?: ProviderId;
  /** Set false to behave like CalDAV: no push, watch throws `unsupported`. */
  supportsPush?: boolean;
  now?: () => Date;
  onCredentialsRefreshed?: (tokens: RefreshedTokens) => void | Promise<void>;
  accountEmail?: string;
}

export class FakeCalendarProvider implements OAuthCalendarProvider {
  readonly id: ProviderId;
  readonly supportsPush: boolean;
  /** Every call made, in order, for assertions. Calendar ids only, never titles. */
  readonly calls: { operation: FakeOperation; calendarId: string | null }[] = [];
  readonly channels = new Map<string, FakeChannel>();

  private readonly calendars = new Map<string, FakeCalendar>();
  private readonly failures: { operation: FakeOperation | "any"; error: unknown; remaining: number }[] = [];
  private readonly keyed = new Map<string, string>();
  private readonly now: () => Date;
  private readonly accountEmail: string;
  private readonly onRefreshed: FakeOptions["onCredentialsRefreshed"];
  private generation = 1;
  private counter = 0;
  private revoked = false;
  private pendingRefresh: RefreshedTokens | null = null;

  constructor(options: FakeOptions = {}) {
    this.id = options.id ?? "google";
    this.supportsPush = options.supportsPush ?? true;
    this.now = options.now ?? (() => new Date());
    this.accountEmail = options.accountEmail ?? "staff@example.test";
    this.onRefreshed = options.onCredentialsRefreshed;
  }

  // ---- test controls ----------------------------------------------------------------

  addCalendar(id: string, name = id, options: { primary?: boolean; canWrite?: boolean } = {}): void {
    this.calendars.set(id, {
      id,
      name,
      primary: options.primary ?? this.calendars.size === 0,
      canWrite: options.canWrite ?? true,
      timezone: "UTC",
      version: 0,
      events: new Map(),
    });
  }

  /** An event made in the outside calendar, as if the person added it themselves. */
  addEvent(calendarId: string, event: { id?: string; startsAt: string; endsAt: string; transparent?: boolean; allDay?: boolean }): string {
    const calendar = this.calendar(calendarId);
    const id = event.id ?? `ext-${++this.counter}`;
    this.put(calendar, {
      id,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      cancelled: false,
      transparent: event.transparent ?? false,
      allDay: event.allDay ?? false,
      etag: this.nextEtag(),
      createdByKalendr: false,
      writtenTitle: null,
      writtenDescription: null,
      writtenLocation: null,
      changedAt: 0,
    });
    return id;
  }

  moveEvent(calendarId: string, id: string, startsAt: string, endsAt: string): void {
    const calendar = this.calendar(calendarId);
    const existing = calendar.events.get(id);
    if (!existing) throw new Error(`No fake event ${id}`);
    this.put(calendar, { ...existing, startsAt, endsAt, etag: this.nextEtag() });
  }

  /** Deleted outside Kalendr. A later delta reports it as cancelled. */
  removeEvent(calendarId: string, id: string): void {
    const calendar = this.calendar(calendarId);
    const existing = calendar.events.get(id);
    if (!existing) return;
    this.put(calendar, { ...existing, cancelled: true, etag: this.nextEtag() });
  }

  event(calendarId: string, id: string): FakeEvent | undefined {
    return this.calendar(calendarId).events.get(id);
  }

  /** Every call fails as a revoked login until `restore()`. */
  revoke(): void {
    this.revoked = true;
  }

  restore(): void {
    this.revoked = false;
  }

  /** Old sync tokens are now rejected, like Google's 410 or Graph's syncStateNotFound. */
  expireSyncTokens(): void {
    this.generation += 1;
  }

  /** The next call refreshes the access token and reports it to `onCredentialsRefreshed`. */
  refreshOnNextCall(tokens: RefreshedTokens): void {
    this.pendingRefresh = tokens;
  }

  failNext(operation: FakeOperation | "any", error: unknown = new CalendarProviderError("transient", "fake failure"), times = 1): void {
    this.failures.push({ operation, error, remaining: times });
  }

  rateLimitNext(operation: FakeOperation | "any", retryAfterSeconds: number, times = 1): void {
    this.failNext(operation, new CalendarProviderError("rate_limited", "fake rate limit", { status: 429, retryAfterSeconds }), times);
  }

  /** What the webhook route would receive when this calendar changes: the channels to notify. */
  channelsFor(calendarId: string): FakeChannel[] {
    return [...this.channels.values()].filter((channel) => channel.calendarId === calendarId);
  }

  /** Moves every channel's expiry, to test the renewal job. */
  setChannelExpiry(channelId: string, expiresAt: string): void {
    const channel = this.channels.get(channelId);
    if (channel) this.channels.set(channelId, { ...channel, expiresAt });
  }

  // ---- CalendarProvider --------------------------------------------------------------

  buildAuthUrl(state: string, redirectUri: string): string {
    const url = new URL("https://fake-calendar.example.test/authorize");
    url.search = new URLSearchParams({ state, redirect_uri: redirectUri }).toString();
    return url.toString();
  }

  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    this.enter("exchangeCode", null);
    if (code !== "good-code") throw new CalendarProviderError("invalid", "fake: the code was rejected");
    return {
      refreshToken: "fake-refresh-token",
      accessToken: "fake-access-token",
      expiresAt: new Date(this.now().getTime() + 3_600_000).toISOString(),
      accountEmail: this.accountEmail,
      grantedScopes: ["calendar"],
    };
  }

  async verifyAccount(): Promise<{ accountEmail: string | null }> {
    await this.guard("verifyAccount", null);
    return { accountEmail: this.accountEmail };
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    await this.guard("listCalendars", null);
    return [...this.calendars.values()].map(({ id, name, primary, canWrite, timezone }) => ({ id, name, primary, canWrite, timezone }));
  }

  async syncChanges(_credentials: ProviderCredentials, calendarId: string, request: SyncRequest): Promise<SyncResult> {
    await this.guard("syncChanges", calendarId);
    const calendar = this.calendar(calendarId);
    const nextSyncToken = `fake:${this.generation}:${calendar.version}`;
    const sent = request.syncToken ? /^fake:(\d+):(\d+)$/.exec(request.syncToken) : null;
    if (request.syncToken && (!sent || Number(sent[1]) !== this.generation)) return { fullResyncRequired: true };

    if (sent) {
      const since = Number(sent[2]);
      const events = [...calendar.events.values()].filter((event) => event.changedAt > since).map(toBusy);
      return { fullResyncRequired: false, mode: "delta", events, nextSyncToken, unsupportedRecurrences: 0 };
    }
    const events = [...calendar.events.values()]
      .filter((event) => !event.cancelled && Date.parse(event.startsAt) < request.to.getTime() && Date.parse(event.endsAt) > request.from.getTime())
      .map(toBusy);
    return { fullResyncRequired: false, mode: "snapshot", events, nextSyncToken, unsupportedRecurrences: 0 };
  }

  async createEvent(_credentials: ProviderCredentials, calendarId: string, input: EventInput): Promise<EventWriteResult> {
    await this.guard("createEvent", calendarId);
    const calendar = this.calendar(calendarId);
    const key = input.idempotencyKey ? `${calendarId}:${idFromKey(input.idempotencyKey)}` : null;
    const existingId = key ? this.keyed.get(key) : undefined;
    const existing = existingId ? calendar.events.get(existingId) : undefined;
    if (existing) return { eventId: existing.id, etag: existing.etag };
    const id = `kal-${++this.counter}`;
    const event: FakeEvent = {
      id,
      startsAt: new Date(input.start).toISOString(),
      endsAt: new Date(input.end).toISOString(),
      cancelled: false,
      transparent: false,
      allDay: false,
      etag: this.nextEtag(),
      createdByKalendr: true,
      writtenTitle: input.title,
      writtenDescription: input.description ?? null,
      writtenLocation: input.location ?? null,
      changedAt: 0,
    };
    this.put(calendar, event);
    if (key) this.keyed.set(key, id);
    return { eventId: id, etag: event.etag };
  }

  async updateEvent(_credentials: ProviderCredentials, calendarId: string, eventId: string, input: EventInput, options: WriteOptions = {}): Promise<EventWriteResult> {
    await this.guard("updateEvent", calendarId);
    const calendar = this.calendar(calendarId);
    const existing = calendar.events.get(eventId);
    if (!existing || existing.cancelled) throw new CalendarProviderError("not_found", "fake: event not found", { status: 404 });
    if (options.etag && options.etag !== existing.etag) throw new CalendarProviderError("conflict", "fake: changed elsewhere", { status: 412 });
    const updated: FakeEvent = {
      ...existing,
      startsAt: new Date(input.start).toISOString(),
      endsAt: new Date(input.end).toISOString(),
      writtenTitle: input.title,
      writtenDescription: input.description ?? null,
      writtenLocation: input.location ?? null,
      etag: this.nextEtag(),
    };
    this.put(calendar, updated);
    return { eventId, etag: updated.etag };
  }

  async deleteEvent(_credentials: ProviderCredentials, calendarId: string, eventId: string, options: WriteOptions = {}): Promise<void> {
    await this.guard("deleteEvent", calendarId);
    const calendar = this.calendar(calendarId);
    const existing = calendar.events.get(eventId);
    if (!existing || existing.cancelled) return;
    if (options.etag && options.etag !== existing.etag) throw new CalendarProviderError("conflict", "fake: changed elsewhere", { status: 412 });
    this.put(calendar, { ...existing, cancelled: true, etag: this.nextEtag() });
  }

  async watch(_credentials: ProviderCredentials, calendarId: string, request: WatchRequest): Promise<WatchChannel> {
    await this.guard("watch", calendarId);
    return this.openChannel(calendarId, request);
  }

  async stopWatch(_credentials: ProviderCredentials, channel: Pick<WatchChannel, "channelId" | "resourceId">): Promise<void> {
    await this.guard("stopWatch", null);
    this.channels.delete(channel.channelId);
  }

  async renewWatch(_credentials: ProviderCredentials, calendarId: string, channel: WatchChannel, request: WatchRequest): Promise<WatchChannel> {
    await this.guard("renewWatch", calendarId);
    const fresh = this.openChannel(calendarId, request);
    this.channels.delete(channel.channelId);
    return fresh;
  }

  handleAuthFailure = classifyFailure;

  // ---- internals -----------------------------------------------------------------

  private openChannel(calendarId: string, request: WatchRequest): WatchChannel {
    if (!this.supportsPush) throw new CalendarProviderError("unsupported", "fake: no push on this provider");
    this.calendar(calendarId);
    const channel: FakeChannel = {
      channelId: `fake-channel-${randomUUID()}`,
      resourceId: `fake-resource-${++this.counter}`,
      expiresAt: new Date(this.now().getTime() + 7 * 86_400_000).toISOString(),
      calendarId,
      callbackUrl: request.callbackUrl,
      token: request.token,
    };
    this.channels.set(channel.channelId, channel);
    return { channelId: channel.channelId, resourceId: channel.resourceId, expiresAt: channel.expiresAt };
  }

  private calendar(id: string): FakeCalendar {
    const calendar = this.calendars.get(id);
    if (!calendar) throw new CalendarProviderError("not_found", "fake: calendar not found", { status: 404 });
    return calendar;
  }

  private put(calendar: FakeCalendar, event: FakeEvent): void {
    calendar.version += 1;
    calendar.events.set(event.id, { ...event, changedAt: calendar.version });
  }

  private nextEtag(): string {
    return `"fake-etag-${++this.counter}"`;
  }

  private enter(operation: FakeOperation, calendarId: string | null): void {
    this.calls.push({ operation, calendarId });
    const index = this.failures.findIndex((failure) => failure.remaining > 0 && (failure.operation === "any" || failure.operation === operation));
    const failure = this.failures[index];
    if (failure) {
      failure.remaining -= 1;
      throw failure.error;
    }
  }

  private async guard(operation: FakeOperation, calendarId: string | null): Promise<void> {
    this.enter(operation, calendarId);
    if (this.revoked) throw new CalendarProviderError("revoked", "fake: the login was revoked", { status: 401 });
    if (this.pendingRefresh) {
      const tokens = this.pendingRefresh;
      this.pendingRefresh = null;
      await this.onRefreshed?.(tokens);
    }
  }
}

function toBusy(event: FakeEvent): BusyEvent {
  // Mirrors a real adapter: no title, ever. `writtenTitle` stays inside the fake.
  return event.cancelled
    ? { sourceEventId: event.id, startsAt: null, endsAt: null, cancelled: true }
    : { sourceEventId: event.id, startsAt: event.startsAt, endsAt: event.endsAt, cancelled: false, transparent: event.transparent, allDay: event.allDay };
}
