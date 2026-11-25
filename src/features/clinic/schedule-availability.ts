import { demoResources, demoServices } from "@/lib/demo-data";
import type { Appointment, Service, TimeSlot } from "@/lib/domain";
import { practitionerOffersService, previewDoctors } from "@/lib/preview-doctors";
import type { TermWords } from "@/lib/terminology";
import { draftFromRules, draftToRules, type AvailabilityRuleSlice, type HoursDraft } from "@/lib/working-hours";

export interface WorkingHours {
  start: string;
  end: string;
  days: number[];
  breakStart?: string;
  breakEnd?: string;
}

export interface ScheduleBlock {
  id: string;
  targetType: "practitioner" | "resource";
  targetId: string;
  startsAt: string;
  endsAt: string;
  reason: string;
}

export interface RecurringSeries {
  id: string;
  appointmentIds: string[];
  patientId: string;
  serviceId: string;
  weeks: number;
}

export interface ScheduleAvailability {
  workingHours: Record<string, WorkingHours>;
  blocks: ScheduleBlock[];
  recurringSeries: RecurringSeries[];
}

export const defaultScheduleAvailability: ScheduleAvailability = {
  workingHours: {
    practitioner_asha: { start: "08:30", end: "17:30", days: [1, 2, 3, 4, 5, 6] },
    practitioner_rohan: { start: "09:00", end: "17:30", days: [1, 3, 5] },
    practitioner_mira: { start: "08:30", end: "14:30", days: [1, 2, 3, 4, 5, 6] },
  },
  blocks: [],
  recurringSeries: [],
};

const dateFormatter = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Kolkata" });
const timeFormatter = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Kolkata" });
const dateCache = new Map<string, string>();
const timeCache = new Map<string, number>();
const weekdayCache = new Map<string, number>();

export function clinicDateKey(iso: string): string {
  const cached = dateCache.get(iso);
  if (cached) return cached;
  const parts = dateFormatter.formatToParts(new Date(iso));
  const read = (type: "year" | "month" | "day") => parts.find((part) => part.type === type)?.value ?? "00";
  const key = `${read("year")}-${read("month")}-${read("day")}`;
  if (dateCache.size > 10_000) dateCache.clear();
  dateCache.set(iso, key);
  return key;
}

export function clinicDateTime(dateKey: string, time: string): string {
  return `${dateKey}T${time}:00+05:30`;
}

export function isClinicDateKey(dateKey: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return false;
  const date = new Date(`${dateKey}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === dateKey;
}

export function addClinicDays(dateKey: string, days: number): string {
  if (!isClinicDateKey(dateKey) || !Number.isInteger(days)) throw new RangeError("A valid clinic date and whole-day offset are required.");
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function clinicWeekday(dateKey: string): number {
  const cached = weekdayCache.get(dateKey);
  if (cached !== undefined) return cached;
  if (!isClinicDateKey(dateKey)) throw new RangeError("A valid clinic date is required.");
  const day = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  weekdayCache.set(dateKey, day);
  return day;
}

export function timeMinutes(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

export function clinicTimeMinutes(iso: string): number {
  const cached = timeCache.get(iso);
  if (cached !== undefined) return cached;
  const parts = timeFormatter.formatToParts(new Date(iso));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const total = hour * 60 + minute;
  if (timeCache.size > 10_000) timeCache.clear();
  timeCache.set(iso, total);
  return total;
}

export function minutesTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function overlaps(start: number, end: number, otherStart: number, otherEnd: number): boolean {
  return start < otherEnd && end > otherStart;
}

export function scheduleBlockAffectsAppointment(block: ScheduleBlock, appointment: Appointment): boolean {
  if (block.targetType === "practitioner" && appointment.practitionerId !== block.targetId) return false;
  if (block.targetType === "resource" && !appointment.resourceIds.includes(block.targetId)) return false;
  const service = demoServices.find((item) => item.id === appointment.serviceId);
  return overlaps(Date.parse(block.startsAt), Date.parse(block.endsAt), Date.parse(appointment.startsAt) - (service?.bufferBeforeMinutes ?? 0) * 60_000, Date.parse(appointment.endsAt) + (service?.bufferAfterMinutes ?? 0) * 60_000);
}

function overlapsBreak(hours: WorkingHours, dateKey: string, start: number, end: number): boolean {
  if (!hours.breakStart || !hours.breakEnd) return false;
  return overlaps(start, end, Date.parse(clinicDateTime(dateKey, hours.breakStart)), Date.parse(clinicDateTime(dateKey, hours.breakEnd)));
}

/** Preview hours use JavaScript weekdays (0 is Sunday). Everything shared with the server uses ISO (7 is Sunday). */
export function workingHoursToDraft(hours: WorkingHours): HoursDraft {
  return { days: hours.days.map((day) => day === 0 ? 7 : day).sort((first, second) => first - second), start: hours.start, end: hours.end, breakStart: hours.breakStart ?? null, breakEnd: hours.breakEnd ?? null };
}

export function draftToWorkingHours(draft: HoursDraft): WorkingHours {
  return { days: draft.days.map((day) => day % 7), start: draft.start, end: draft.end, ...(draft.breakStart && draft.breakEnd ? { breakStart: draft.breakStart, breakEnd: draft.breakEnd } : {}) };
}

/** Saved availability rules as one working-hours entry per doctor, keyed by practitioner id. */
export function workingHoursFromRules(rules: readonly AvailabilityRuleSlice[]): Record<string, WorkingHours> {
  const byPractitioner = new Map<string, AvailabilityRuleSlice[]>();
  for (const rule of rules) byPractitioner.set(rule.practitionerId, [...(byPractitioner.get(rule.practitionerId) ?? []), rule]);
  return Object.fromEntries([...byPractitioner].map(([id, list]) => [id, draftToWorkingHours(draftFromRules(list).draft)]));
}

export function workingHoursToRules(practitionerId: string, hours: WorkingHours): AvailabilityRuleSlice[] {
  return draftToRules(practitionerId, workingHoursToDraft(hours));
}

/** The same test the server runs before it moves a booking: the whole visit sits inside one working window. */
export function visitFitsRules(appointment: Pick<Appointment, "practitionerId" | "startsAt" | "endsAt">, rules: readonly AvailabilityRuleSlice[]): boolean {
  const weekday = clinicWeekday(clinicDateKey(appointment.startsAt)) || 7;
  const start = clinicTimeMinutes(appointment.startsAt);
  const end = clinicTimeMinutes(appointment.endsAt);
  return rules.some((rule) => rule.practitionerId === appointment.practitionerId && rule.dayOfWeek === weekday && start >= timeMinutes(rule.startsAtLocal) && end <= timeMinutes(rule.endsAtLocal));
}

/** Why a slot cannot be booked, or null. `t` words the reason for this business; it defaults to the healthcare word. */
export function slotAvailabilityIssue(slot: TimeSlot, service: Service, availability: ScheduleAvailability, t?: Pick<TermWords, "practitioner">): string | null {
  const practitioner = t?.practitioner ?? "practitioner";
  const hours = availability.workingHours[slot.practitionerId];
  if (!hours) return `No working hours are set for this ${practitioner}.`;
  const dateKey = clinicDateKey(slot.startsAt);
  if (!hours.days.includes(clinicWeekday(dateKey))) return `The ${practitioner} is not working on this day.`;
  const start = Date.parse(slot.startsAt) - service.bufferBeforeMinutes * 60_000;
  const end = Date.parse(slot.startsAt) + (service.durationMinutes + service.bufferAfterMinutes) * 60_000;
  if (start < Date.parse(clinicDateTime(dateKey, hours.start)) || end > Date.parse(clinicDateTime(dateKey, hours.end)) || overlapsBreak(hours, dateKey, start, end)) return "The service and buffer do not fit working hours.";
  const block = availability.blocks.find((item) =>
    (item.targetType === "practitioner" && item.targetId === slot.practitionerId || item.targetType === "resource" && item.targetId === slot.resourceId) &&
    overlaps(start, end, Date.parse(item.startsAt), Date.parse(item.endsAt))
  );
  return block ? `Blocked: ${block.reason}` : null;
}

export function staffSlotsForDate(dateKey: string, service: Service, locationId: string, availability: ScheduleAvailability): TimeSlot[] {
  const resources = demoResources.filter((item) => item.locationId === locationId && (!service.resourceKind || item.kind === service.resourceKind));
  const slots: TimeSlot[] = [];
  for (const practitioner of previewDoctors()) {
    if (practitioner.isActive === false || !practitionerOffersService(practitioner.id, service) || !practitioner.locationIds.includes(locationId)) continue;
    const hours = availability.workingHours[practitioner.id];
    if (!hours || !hours.days.includes(clinicWeekday(dateKey))) continue;
    for (let start = timeMinutes(hours.start); start + service.durationMinutes + service.bufferAfterMinutes <= timeMinutes(hours.end); start += 15) {
      const startsAt = clinicDateTime(dateKey, minutesTime(start));
      const endsAt = clinicDateTime(dateKey, minutesTime(start + service.durationMinutes));
      for (const resource of resources) {
        slots.push({ id: `staff_${dateKey}_${minutesTime(start).replace(":", "")}_${practitioner.id}_${resource.id}`, startsAt, endsAt, practitionerId: practitioner.id, resourceId: resource.id });
      }
    }
  }
  return slots;
}
