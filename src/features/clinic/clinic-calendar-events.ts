import type { CalEvent, Lane } from "@/components/kloq";
import type { Appointment, AppointmentStatus, Practitioner } from "@/lib/domain";

import { appointmentTime, statusLabel } from "./clinic-format";
import { clinicDateKey, clinicDateTime, clinicTimeMinutes, clinicWeekday, timeMinutes, type ScheduleAvailability, type ScheduleBlock } from "./schedule-availability";

/*
 * What the calendars show, without the calendar itself. Pages that only build events or lanes
 * import from here, so they don't load the calendar library until they draw one.
 */

export const clinicTimeZone = "Asia/Kolkata";
export const timelineStartMinute = 8 * 60;
const timelineSpanMinutes = 11 * 60;
export const timelineSlotMinutes = 15;
export const pixelsPerSlot = 48;
export const timelineWindow = { startOffsetMinutes: timelineStartMinute, spanMinutes: timelineSpanMinutes, slotMinutes: timelineSlotMinutes, pxPerSlot: pixelsPerSlot };

export type ClinicEvent = CalEvent & { practitionerId: string; kind: "appointment" | "block" | "opening"; /** The room, for the day-by-room view. */ roomId?: string };

const statusColor: Record<AppointmentStatus, NonNullable<CalEvent["color"]>> = {
  requested: "amber",
  booked: "blue",
  checked_in: "emerald",
  completed: "violet",
  cancelled: "rose",
  no_show: "rose",
  entered_in_error: "rose",
  declined: "rose",
  expired: "rose",
  reschedule_requested: "amber",
  pending_payment: "amber",
};

/** Visits that no longer hold the time. They stay hidden until a status filter asks for them. */
export const inactiveStatuses: readonly AppointmentStatus[] = ["cancelled", "no_show", "entered_in_error", "declined", "expired", "reschedule_requested", "pending_payment"];

export function appointmentEvent(appointment: Appointment, details: { patientName: string; serviceName: string; practitionerName: string; roomName?: string; movable?: boolean }): ClinicEvent {
  return {
    id: appointment.id,
    kind: "appointment",
    // Colour alone can't carry status, so anything other than a plain booking says so in its title.
    title: `${appointment.status === "booked" ? details.patientName : `${details.patientName} · ${statusLabel(appointment.status)}`}${appointment.seriesId ? " ↻" : ""}`,
    description: appointment.seriesId ? `${details.serviceName} · Repeating` : details.serviceName,
    location: [details.practitionerName, details.roomName].filter(Boolean).join(" · "),
    start: appointment.startsAt,
    end: appointment.endsAt,
    color: statusColor[appointment.status],
    readOnly: !details.movable,
    practitionerId: appointment.practitionerId,
  } as ClinicEvent;
}

export function blockEvent(block: ScheduleBlock): ClinicEvent {
  return { id: block.id, kind: "block", title: block.reason, start: block.startsAt, end: block.endsAt, color: "rose", readOnly: true, practitionerId: block.targetType === "practitioner" ? block.targetId : "" } as ClinicEvent;
}

export interface LaneShading {
  /** Minutes from the start of the timeline that this practitioner isn't working. */
  off: { start: number; end: number }[];
  /** Where to draw the clinic clock when the browser's own clock is on another day, as in the preview. */
  now?: number;
}

/** One timeline row per practitioner, carrying the hours to shade on the given day. */
export function practitionerLanes(practitioners: readonly Pick<Practitioner, "id" | "name">[], dateKey: string, availability: ScheduleAvailability, clockIso?: string): Lane[] {
  const weekday = clinicWeekday(dateKey);
  const showClock = clockIso && clinicDateKey(clockIso) === dateKey && clinicDateKey(new Date().toISOString()) !== dateKey;
  return practitioners.map((person) => {
    const hours = availability.workingHours[person.id];
    const open = hours?.days.includes(weekday) ? { start: timeMinutes(hours.start) - timelineStartMinute, end: timeMinutes(hours.end) - timelineStartMinute } : null;
    const lunch = open && hours?.breakStart && hours.breakEnd ? [{ start: timeMinutes(hours.breakStart) - timelineStartMinute, end: timeMinutes(hours.breakEnd) - timelineStartMinute }] : [];
    const off = open ? [{ start: 0, end: open.start }, ...lunch, { start: open.end, end: timelineSpanMinutes }].filter((band) => band.end > band.start) : [{ start: 0, end: timelineSpanMinutes }];
    const data: LaneShading = { off, now: showClock ? clinicTimeMinutes(clockIso) - timelineStartMinute : undefined };
    const label = open && hours ? `${formatHour(hours.start)} – ${formatHour(hours.end)}` : "Off today";
    return { id: person.id, label: person.name, sublabel: label, data };
  });
}

function formatHour(time: string): string {
  return appointmentTime(clinicDateTime("2026-08-31", time));
}

/** Times nobody is working, hatched by the week and day grids. The timeline shades each practitioner instead. */
export function closedTimeConstraint(availability: ScheduleAvailability, practitionerIds: readonly string[]) {
  return (slot: { start: Date; end: Date; allDay: boolean }): boolean => {
    if (slot.allDay) return false;
    const iso = slot.start.toISOString();
    const dateKey = clinicDateKey(iso);
    const weekday = clinicWeekday(dateKey);
    const start = clinicTimeMinutes(iso);
    const end = start + (slot.end.getTime() - slot.start.getTime()) / 60_000;
    return !practitionerIds.some((id) => {
      const hours = availability.workingHours[id];
      if (!hours?.days.includes(weekday) || start >= timeMinutes(hours.end) || end <= timeMinutes(hours.start)) return false;
      return !(hours.breakStart && hours.breakEnd && start >= timeMinutes(hours.breakStart) && end <= timeMinutes(hours.breakEnd));
    });
  };
}
