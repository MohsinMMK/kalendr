/**
 * The pure rules of calendar sync: what text goes into someone's calendar, how a read becomes busy
 * rows, and when an outside change counts as "someone moved our event". No database and no network,
 * so each rule has a plain unit test.
 */
import { createHash } from "node:crypto";

import type { EventTextSetting } from "../../lib/calendar-sync";
import type { BusyEvent } from "./provider";

export interface EventContentInput {
  firstName: string;
  lastName: string;
  serviceName: string;
  locationName: string;
  /** A path-free absolute address back to the appointment in Kalendr; staff only. */
  appointmentUrl: string;
}

export interface EventContent {
  title: string;
  description?: string;
  location?: string;
}

/**
 * The usual text written into a staff calendar. Never includes a phone number, email, reason for the visit or notes,
 * whatever the setting: the setting only chooses how much of the name and service shows. A service's own wording
 * (feature 50, `src/lib/event-wording.ts`) may replace this when its owner sets a team title or "Busy only".
 */
export function eventContent(setting: EventTextSetting, input: EventContentInput): EventContent {
  if (setting === "busy_only") return { title: "Busy" };
  if (setting === "first_name_service") return { title: `${input.firstName} – ${input.serviceName}` };
  return {
    title: `${input.serviceName} – ${input.firstName} ${input.lastName}`.trim(),
    description: `Open in Kalendr: ${input.appointmentUrl}`,
    location: input.locationName,
  };
}

/** A fingerprint of everything we push, so an unchanged appointment never rewrites its event. */
export function fieldsHash(content: EventContent, startsAt: Date, endsAt: Date): string {
  return createHash("sha256")
    .update(JSON.stringify([content.title, content.description ?? "", content.location ?? "", startsAt.toISOString(), endsAt.toISOString()]))
    .digest("hex");
}

/** An appointment that should have an event in a calendar. Finished or cancelled ones should not. */
export function appointmentNeedsEvent(status: string): boolean {
  return status === "requested" || status === "booked" || status === "checked_in";
}

/** An appointment whose calendar event should be removed. A finished visit keeps its event as a record. */
export function appointmentEventShouldGo(status: string): boolean {
  return status === "cancelled" || status === "entered_in_error" || status === "no_show";
}

interface BusyRow {
  sourceEventId: string;
  startsAt: Date;
  endsAt: Date;
}

export interface BusyPlan {
  /** Rows to insert or update. */
  upsert: BusyRow[];
  /** Source event ids whose row must go. */
  remove: string[];
}

/**
 * Turns a provider read into cache changes. Cancelled events, events marked "free" and events whose
 * times are missing never block. Events Kalendr wrote itself (their ids are in `ownEventIds`) are
 * dropped so an appointment never blocks its own slot. A snapshot is the whole window, so anything
 * cached but not in it is removed; a delta only touches the events it names.
 */
export function planBusy(
  mode: "snapshot" | "delta",
  events: readonly BusyEvent[],
  ownEventIds: ReadonlySet<string>,
  cachedIds: readonly string[],
): BusyPlan {
  const upsert: BusyRow[] = [];
  const remove = new Set<string>();
  const seen = new Set<string>();
  for (const event of events) {
    seen.add(event.sourceEventId);
    const blocks = !event.cancelled && !event.transparent && event.startsAt !== null && event.endsAt !== null && !ownEventIds.has(event.sourceEventId);
    if (blocks && event.startsAt && event.endsAt && Date.parse(event.endsAt) > Date.parse(event.startsAt)) {
      upsert.push({ sourceEventId: event.sourceEventId, startsAt: new Date(event.startsAt), endsAt: new Date(event.endsAt) });
    } else {
      remove.add(event.sourceEventId);
    }
  }
  if (mode === "snapshot") {
    for (const id of cachedIds) if (!seen.has(id)) remove.add(id);
  }
  return { upsert, remove: [...remove] };
}

export interface LinkState {
  status: "active" | "deleted";
  pushedStartsAt: Date;
  pushedEndsAt: Date;
}

export interface AppointmentState {
  status: string;
  startsAt: Date;
  endsAt: Date;
}

export type ExternalChange =
  | { kind: "none" }
  /** The event is back where Kalendr put it: an open item about it no longer applies. */
  | { kind: "in_place" }
  | { kind: "moved"; eventStartsAt: Date; eventEndsAt: Date }
  | { kind: "deleted" };

/**
 * Decides whether a read of a linked event means a person changed it outside Kalendr. Never changes
 * the appointment; the caller only records a "needs a person" item. It stays quiet when Kalendr
 * itself is about to write (`writePending`), when Kalendr deleted the event, and when the appointment
 * is already finished or cancelled.
 */
export function classifyExternalChange(
  link: LinkState,
  event: Pick<BusyEvent, "cancelled" | "startsAt" | "endsAt">,
  appointment: AppointmentState,
  writePending: boolean,
): ExternalChange {
  if (link.status === "deleted" || !appointmentNeedsEvent(appointment.status) || writePending) return { kind: "none" };
  if (event.cancelled || event.startsAt === null || event.endsAt === null) return { kind: "deleted" };
  const starts = new Date(event.startsAt);
  const ends = new Date(event.endsAt);
  const samePlace = (a: Date, b: Date) => a.getTime() === b.getTime();
  if (samePlace(starts, link.pushedStartsAt) && samePlace(ends, link.pushedEndsAt)) return { kind: "in_place" };
  // Already matches the appointment: someone moved both, or Kalendr's own write is arriving.
  if (samePlace(starts, appointment.startsAt) && samePlace(ends, appointment.endsAt)) return { kind: "none" };
  return { kind: "moved", eventStartsAt: starts, eventEndsAt: ends };
}
