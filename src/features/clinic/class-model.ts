/**
 * What the class screens share (feature 18): week arithmetic, how a session is written on screen, the query keys and the
 * calls to the staff routes. Kept apart from the components so it can be tested without rendering.
 */
import type { CreateSessionsResult, SessionDetail, SessionView } from "@/lib/classes-contracts";

import { readApiError, StaffApiError } from "./queries/http";
import { staffKeys } from "./queries/keys";
import { staffMutation, staffQuery } from "./staff-snapshot-provider";

/** The zone a business without a known place reads times in. */
export const fallbackZone = "Asia/Kolkata";
const fallbackOffset = "+05:30";

export const classKeys = {
  all: [...staffKeys.all, "classes"] as const,
  range: (from: string, to: string) => [...staffKeys.all, "classes", "range", from, to] as const,
  detail: (id: string) => [...staffKeys.all, "classes", "detail", id] as const,
  types: [...staffKeys.all, "classes", "types"] as const,
};

export interface ClassTypeView {
  serviceId: string;
  name: string;
  durationMinutes: number;
  capacity: number;
  locationIds: string[];
  practitionerIds: string[];
  priceMinor: number | null;
}

const dayKeyFormat = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: fallbackZone });

/** Today as `YYYY-MM-DD` in the business's zone. */
export function todayKey(now: Date = new Date()): string {
  return dayKeyFormat.format(now);
}

function shiftKey(key: string, days: number): string {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The Monday of the week that holds a day. */
export function weekStartOf(key: string): string {
  const weekday = (new Date(`${key}T12:00:00Z`).getUTCDay() + 6) % 7;
  return shiftKey(key, -weekday);
}

export const addDays = shiftKey;

/** The instants a week covers, as the range the list route takes. */
export function weekRange(weekStart: string): { from: string; to: string } {
  return { from: `${weekStart}T00:00:00${fallbackOffset}`, to: `${shiftKey(weekStart, 7)}T00:00:00${fallbackOffset}` };
}

export function dayRange(day: string): { from: string; to: string } {
  return { from: `${day}T00:00:00${fallbackOffset}`, to: `${shiftKey(day, 1)}T00:00:00${fallbackOffset}` };
}

export function weekTitle(weekStart: string): string {
  const fmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${fmt.format(new Date(`${weekStart}T12:00:00Z`))} to ${fmt.format(new Date(`${shiftKey(weekStart, 6)}T12:00:00Z`))}`;
}

export function dayHeading(key: string): string {
  return new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${key}T12:00:00Z`));
}

export function clockText(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
}

export function dateKeyIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(new Date(iso));
}

export function timeRange(session: Pick<SessionView, "startsAt" | "endsAt">, timeZone: string): string {
  return `${clockText(session.startsAt, timeZone)} to ${clockText(session.endsAt, timeZone)}`;
}

/** Sessions grouped by the day they start, in order. */
export function groupByDay<T extends SessionView>(sessions: readonly T[], zoneOf: (session: T) => string): Array<{ day: string; sessions: T[] }> {
  const groups = new Map<string, T[]>();
  for (const session of [...sessions].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
    const day = dateKeyIn(session.startsAt, zoneOf(session));
    groups.set(day, [...(groups.get(day) ?? []), session]);
  }
  return [...groups.entries()].map(([day, list]) => ({ day, sessions: list }));
}

export const seatsText = (session: Pick<SessionView, "seatsTaken" | "capacity">): string => `${session.seatsTaken} of ${session.capacity} taken`;

export function fetchSessions(from: string, to: string, signal?: AbortSignal): Promise<SessionView[]> {
  return staffQuery<SessionView[]>(`/api/staff/classes?${new URLSearchParams({ from, to }).toString()}`, signal);
}

export const fetchSession = (id: string, signal?: AbortSignal) => staffQuery<SessionDetail>(`/api/staff/classes/${id}`, signal);
export const fetchClassTypes = (signal?: AbortSignal) => staffQuery<ClassTypeView[]>("/api/staff/classes/types", signal);

export const markAttendance = (id: string, body: { enrolmentId: string; expectedVersion: number; outcome: "attended" | "no_show" | "booked" }) =>
  staffMutation<SessionDetail>(`/api/staff/classes/${id}/attendance`, "POST", body);

export const addWalkIn = (id: string, body: { patientId?: string; firstName?: string; lastName?: string; phone?: string; email?: string }) =>
  staffMutation<SessionDetail>(`/api/staff/classes/${id}/walk-in`, "POST", body);

export const changeSeats = (id: string, body: { expectedVersion: number; capacity: number }) =>
  staffMutation<SessionDetail>(`/api/staff/classes/${id}`, "PATCH", body);

export const cancelSession = (id: string, body: { expectedVersion: number; note?: string }) =>
  staffMutation<{ cancelled: number; notified: number }>(`/api/staff/classes/${id}/cancel`, "POST", body);

export const messageSession = (id: string, body: { message: string; audience: "booked" | "booked_and_waiting" }, idempotencyKey: string) =>
  staffMutation<{ queued: number }>(`/api/staff/classes/${id}/message`, "POST", body, { idempotencyKey });

/**
 * Creates a session or a timetable. The route answers 409 with the same shape when dates clash, so that answer is
 * read here instead of being thrown away as an error. Nothing is created when any date clashes.
 */
export async function createSessions(body: unknown): Promise<CreateSessionsResult> {
  const response = await fetch("/api/staff/classes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result: unknown = await response.json().catch(() => null);
  if (typeof result === "object" && result !== null && "data" in result && response.status < 500 && (response.ok || response.status === 409)) return result.data as CreateSessionsResult;
  throw new StaffApiError(readApiError(result, "The session could not be saved."), response.status, "request_failed");
}

export const createClassType = (body: unknown) => staffMutation<{ serviceId: string }>("/api/staff/classes/types", "POST", body);
