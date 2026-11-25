import type { Appointment, AppointmentStatus, Patient } from "@/lib/domain";

import { inactiveStatuses } from "./clinic-calendar-events";
import { addClinicDays, clinicDateKey, clinicWeekday } from "./schedule-availability";
import type { ListRange, ScheduleView } from "./schedule-view";

/** Every status the filter offers. A record entered in error is never shown. */
export type FilterStatus = Exclude<AppointmentStatus, "entered_in_error" | "declined" | "expired" | "reschedule_requested" | "pending_payment">;
export type StatusFilter = "all" | FilterStatus;

export interface ScheduleFilters {
  locationId: string;
  /** Empty for every staff member. */
  practitionerId: string;
  /** Empty for every room. */
  resourceId: string;
  status: StatusFilter;
  /** Part of a name or phone number, already trimmed and lower-cased. */
  needle: string;
}

/** Which visits the schedule shows: this location, these filters, and not cancelled ones unless the filter asks. */
export function filterAppointments(
  appointments: readonly Appointment[],
  patients: ReadonlyMap<string, Patient>,
  filters: ScheduleFilters,
  allowedPractitionerIds: ReadonlySet<string>,
): Appointment[] {
  return appointments.filter((appointment) => {
    if (appointment.locationId !== filters.locationId || !allowedPractitionerIds.has(appointment.practitionerId)) return false;
    if (filters.resourceId && !appointment.resourceIds.includes(filters.resourceId)) return false;
    if (filters.status === "all" ? inactiveStatuses.includes(appointment.status) : appointment.status !== filters.status) return false;
    if (!filters.needle) return true;
    const patient = patients.get(appointment.patientId);
    return [patient?.firstName, patient?.lastName, patient?.phone].join(" ").toLocaleLowerCase("en-IN").includes(filters.needle);
  });
}

/** The Monday on or before a day. The schedule's weeks start on Monday. */
export function weekStartKey(dateKey: string): string {
  const sinceMonday = (clinicWeekday(dateKey) + 6) % 7; // clinicWeekday: 0 = Sunday … 6 = Saturday
  return addClinicDays(dateKey, -sinceMonday);
}

/** The days a view shows, as date keys. A day view is one day; a week or a week-long list is seven. */
export function visibleDays(dateKey: string, view: ScheduleView, range: ListRange): string[] {
  const weekWide = view === "week" || (view === "list" && range === "week");
  if (!weekWide) return [dateKey];
  const start = weekStartKey(dateKey);
  return Array.from({ length: 7 }, (_, index) => addClinicDays(start, index));
}

/** One step back or forward: a day for the day views, a week for the week views. */
export function stepDateKey(dateKey: string, view: ScheduleView, range: ListRange, direction: -1 | 1): string {
  const weekWide = view === "week" || (view === "list" && range === "week");
  return addClinicDays(dateKey, direction * (weekWide ? 7 : 1));
}

/** Visits on the given days, in time order, then by who they are with so ties never reorder between renders. */
export function visitsOnDays(appointments: readonly Appointment[], days: readonly string[]): Appointment[] {
  const wanted = new Set(days);
  return appointments
    .filter((appointment) => wanted.has(clinicDateKey(appointment.startsAt)))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.practitionerId.localeCompare(b.practitionerId) || a.id.localeCompare(b.id));
}

/** "Mon, 16 Nov" for a date key, in the business's time zone. */
export function dayLabel(dateKey: string, options: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }): string {
  return new Intl.DateTimeFormat("en-IN", { ...options, timeZone: "Asia/Kolkata" }).format(new Date(`${dateKey}T12:00:00+05:30`));
}
