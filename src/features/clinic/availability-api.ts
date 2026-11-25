import { z } from "zod";

import {
  scheduleSchema, timeOffSchema, travelPeriodSchema,
  type HolidayListing, type Schedule, type TimeOff, type TravelPeriod,
} from "@/lib/availability-setup";

/**
 * The availability routes, one small function each. Every failure carries the server's code and
 * plain sentence, so a screen can tell "someone else changed this" from an ordinary error.
 */

export class AvailabilityError extends Error {
  constructor(message: string, readonly code: string, readonly fieldErrors: Record<string, string[]>) {
    super(message);
  }
  get isConflict(): boolean {
    return this.code === "version_conflict";
  }
}

export function isConflict(cause: unknown): boolean {
  return cause instanceof AvailabilityError && cause.isConflict;
}

async function send(path: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, {
    method,
    cache: "no-store",
    signal,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result: unknown = await response.json().catch(() => null);
  if (response.ok && typeof result === "object" && result !== null && "data" in result) return (result as { data: unknown }).data;
  const error = typeof result === "object" && result !== null && "error" in result
    ? (result as { error: { code?: string; message?: string; fieldErrors?: Record<string, string[]> } }).error
    : {};
  throw new AvailabilityError(error?.message ?? "That could not be saved. Try again.", error?.code ?? "error", error?.fieldErrors ?? {});
}

const base = "/api/staff/availability";

export const listSchedules = async (practitionerId: string, signal?: AbortSignal): Promise<Schedule[]> =>
  z.array(scheduleSchema).parse(await send(`${base}/schedules?practitionerId=${encodeURIComponent(practitionerId)}`, "GET", undefined, signal));
export const createSchedule = async (body: unknown): Promise<Schedule> => scheduleSchema.parse(await send(`${base}/schedules`, "POST", body));
/** The route answers `{ schedule, timing }`; `timing` says which visits moved when the main hours changed. */
export const updateSchedule = async (id: string, body: unknown): Promise<Schedule> =>
  scheduleSchema.parse(((await send(`${base}/schedules/${id}`, "PATCH", body)) as { schedule: unknown }).schedule);
export const deleteSchedule = async (id: string): Promise<void> => { await send(`${base}/schedules/${id}`, "DELETE", {}); };
/** A copy for the same person is a new schedule that starts from this one's times. */
export const copySchedule = async (from: Schedule, name: string): Promise<Schedule> =>
  createSchedule({ practitionerId: from.practitionerId, name, copyFromScheduleId: from.id });
/** A copy of this schedule's times for another person. */
export const copyScheduleToPerson = async (id: string, body: { toPractitionerId: string; name?: string }): Promise<Schedule> =>
  scheduleSchema.parse(await send(`${base}/schedules/${id}/copy`, "POST", body));

export const listTravel = async (practitionerId: string, signal?: AbortSignal): Promise<TravelPeriod[]> =>
  z.array(travelPeriodSchema).parse(await send(`${base}/travel?practitionerId=${encodeURIComponent(practitionerId)}`, "GET", undefined, signal));
export const createTravel = async (body: unknown): Promise<TravelPeriod> => travelPeriodSchema.parse(await send(`${base}/travel`, "POST", body));
export const deleteTravel = async (id: string): Promise<void> => { await send(`${base}/travel/${id}`, "DELETE", {}); };

export const listTimeOff = async (practitionerId: string | null, signal?: AbortSignal): Promise<TimeOff[]> =>
  z.array(timeOffSchema).parse(await send(`${base}/time-off${practitionerId ? `?practitionerId=${encodeURIComponent(practitionerId)}` : ""}`, "GET", undefined, signal));
export const createTimeOff = async (body: unknown): Promise<TimeOff> => timeOffSchema.parse(await send(`${base}/time-off`, "POST", body));
export const updateTimeOff = async (id: string, body: unknown): Promise<TimeOff> => timeOffSchema.parse(await send(`${base}/time-off/${id}`, "PATCH", body));
export const deleteTimeOff = async (id: string): Promise<void> => { await send(`${base}/time-off/${id}`, "DELETE", {}); };

export const getHolidays = async (signal?: AbortSignal): Promise<HolidayListing> => (await send("/api/staff/holidays", "GET", undefined, signal)) as HolidayListing;
export const putHolidays = async (body: unknown): Promise<HolidayListing> => (await send("/api/staff/holidays", "PUT", body)) as HolidayListing;
