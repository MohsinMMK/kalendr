import { z } from "zod";

/**
 * The shapes behind "Availability": named weekly schedules, date overrides, public holidays,
 * out of office, travel and the "Why no slot?" answer. The editor screens, the staff routes and
 * the slot engine's loader all read these, so a rule is written once here.
 */

const identifierSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");

/** `HH:MM`, 24-hour. An end of `24:00` means midnight at the end of the day. */
export const timeOfDaySchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, "Use a time like 09:00.");

export const timeRangeSchema = z.object({ start: timeOfDaySchema, end: timeOfDaySchema })
  .refine((range) => range.end > range.start, { message: "A range must end after it starts.", path: ["end"] });
export type TimeRange = z.infer<typeof timeRangeSchema>;

/** A day's ranges must not overlap, and are kept in order. */
export function rangesOverlap(ranges: readonly TimeRange[]): boolean {
  const sorted = [...ranges].sort((a, b) => a.start.localeCompare(b.start));
  return sorted.some((range, index) => index > 0 && range.start < sorted[index - 1]!.end);
}

export const dayRangesSchema = z.array(timeRangeSchema).max(8).refine((ranges) => !rangesOverlap(ranges), {
  message: "These times overlap. Change one so they sit one after the other.",
});

export const weekdays = ["1", "2", "3", "4", "5", "6", "7"] as const;
export type Weekday = (typeof weekdays)[number];
export const weekdayLabels: Record<Weekday, string> = { "1": "Monday", "2": "Tuesday", "3": "Wednesday", "4": "Thursday", "5": "Friday", "6": "Saturday", "7": "Sunday" };

/** Monday is `"1"` and Sunday `"7"`. A missing or empty day is a day off. */
export const weeklyHoursSchema = z.object({
  "1": dayRangesSchema, "2": dayRangesSchema, "3": dayRangesSchema, "4": dayRangesSchema,
  "5": dayRangesSchema, "6": dayRangesSchema, "7": dayRangesSchema,
});
export type WeeklyHours = z.infer<typeof weeklyHoursSchema>;

export const timezoneSchema = z.string().trim().min(1).max(64).refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Choose a timezone from the list.");

/** `ranges: null` closes the day. */
export const dateOverrideSchema = z.object({ date: dateOnlySchema, ranges: dayRangesSchema.nullable() });
export type DateOverride = z.infer<typeof dateOverrideSchema>;

export const scheduleSchema = z.object({
  id: identifierSchema,
  practitionerId: identifierSchema,
  name: z.string().trim().min(1).max(80),
  timezone: timezoneSchema,
  isDefault: z.boolean(),
  version: z.number().int().positive(),
  weekly: weeklyHoursSchema,
  overrides: z.array(dateOverrideSchema).max(400),
});
export type Schedule = z.infer<typeof scheduleSchema>;

export const scheduleCreateSchema = z.object({
  practitionerId: identifierSchema,
  name: z.string().trim().min(1).max(80),
  timezone: timezoneSchema.optional(),
  /** Start from another schedule's times. */
  copyFromScheduleId: identifierSchema.optional(),
});

/** Every field is optional. `expectedVersion` stops two managers overwriting each other. */
export const scheduleUpdateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  name: z.string().trim().min(1).max(80).optional(),
  timezone: timezoneSchema.optional(),
  isDefault: z.literal(true).optional(),
  weekly: weeklyHoursSchema.optional(),
  /** The dates given replace the stored overrides for those dates; `removeOverrideDates` deletes some. */
  overrides: z.array(dateOverrideSchema).max(100).optional(),
  removeOverrideDates: z.array(dateOnlySchema).max(100).optional(),
});
export type ScheduleUpdate = z.infer<typeof scheduleUpdateSchema>;

export const travelPeriodSchema = z.object({
  id: identifierSchema,
  practitionerId: identifierSchema,
  startsOn: dateOnlySchema,
  endsOn: dateOnlySchema,
  timezone: timezoneSchema,
});
export type TravelPeriod = z.infer<typeof travelPeriodSchema>;

export const travelPeriodCreateSchema = travelPeriodSchema.omit({ id: true }).refine((value) => value.endsOn >= value.startsOn, {
  message: "The last day must not be before the first.",
  path: ["endsOn"],
});

export const timeOffReasons = ["leave", "sick", "training", "holiday", "other"] as const;
export type TimeOffReason = (typeof timeOffReasons)[number];
export const timeOffReasonLabels: Record<TimeOffReason, string> = { leave: "Leave", sick: "Sick", training: "Training", holiday: "Holiday", other: "Other" };

/** Out of office, in whole days in the person's schedule timezone. `through` is the last day away. */
export const timeOffSchema = z.object({
  id: identifierSchema,
  practitionerId: identifierSchema,
  startsOn: dateOnlySchema,
  throughDate: dateOnlySchema,
  reason: z.enum(timeOffReasons),
  /** Shown on the booking page, for example "Back on 3 December". */
  publicNote: z.string().trim().max(200).nullable(),
  /** A teammate whose slots the booking page offers instead while this person is away. */
  coverPractitionerId: identifierSchema.nullable(),
  version: z.number().int().positive(),
});
export type TimeOff = z.infer<typeof timeOffSchema>;

export const timeOffCreateSchema = timeOffSchema.omit({ id: true, version: true }).refine((value) => value.throughDate >= value.startsOn, {
  message: "The last day must not be before the first.",
  path: ["throughDate"],
}).refine((value) => value.coverPractitionerId !== value.practitionerId, {
  message: "Choose someone else to cover.",
  path: ["coverPractitionerId"],
});
export const timeOffUpdateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  startsOn: dateOnlySchema.optional(),
  throughDate: dateOnlySchema.optional(),
  reason: z.enum(timeOffReasons).optional(),
  publicNote: z.string().trim().max(200).nullable().optional(),
  coverPractitionerId: identifierSchema.nullable().optional(),
});

export const holidayTypes = ["public", "bank", "optional", "observance", "custom"] as const;

/** One day in the holiday list. `closed` is whether the business is shut that day. */
export const holidayItemSchema = z.object({
  /** The library's rule for the day (`12-25`, `easter -2`), or `custom:YYYY-MM-DD`. Stable from year to year. */
  id: z.string().min(1).max(80),
  date: dateOnlySchema,
  name: z.string().max(120),
  type: z.enum(holidayTypes),
  closed: z.boolean(),
});
export type HolidayItem = z.infer<typeof holidayItemSchema>;

export const holidaySettingsSchema = z.object({
  country: z.string().length(2).regex(/^[A-Z]{2}$/),
  region: z.string().max(10).nullable(),
  /** `{ "2026": ["12-25"] }`: holidays the owner turned off, by year. */
  optedOut: z.record(z.string().regex(/^\d{4}$/), z.array(z.string().max(80)).max(60)),
  customDays: z.array(z.object({ date: dateOnlySchema, name: z.string().trim().min(1).max(120) })).max(60),
});
export type HolidaySettings = z.infer<typeof holidaySettingsSchema>;

export const holidaySettingsUpdateSchema = holidaySettingsSchema.extend({ expectedVersion: z.number().int().positive().optional() });

/** What `GET /api/staff/holidays` returns. `country: null` means holidays are not turned on. */
export interface HolidayListing {
  settings: (HolidaySettings & { version: number }) | null;
  /** The country suggested from the business's timezone, so the picker starts somewhere sensible. */
  suggestedCountry: string | null;
  countries: Array<{ code: string; name: string }>;
  regions: Array<{ code: string; name: string }>;
  /** The next 12 months. Empty when no country is chosen, or the holiday data for it is not available. */
  holidays: HolidayItem[];
  dataAvailable: boolean;
}

/** The reasons a start can be missing, as the "Why no slot?" sheet shows them. */
export const explainReasons = [
  "outside_hours", "holiday", "out_of_office", "blocked_off", "outside_restriction", "already_booked",
  "buffer_before", "buffer_after", "within_minimum_notice", "beyond_booking_window", "no_free_resource",
  "person_does_not_offer", "not_a_start_time", "daily_limit_reached", "period_limit_reached", "busy_in_calendar",
] as const;
export type ExplainReason = (typeof explainReasons)[number];

export const explainQuerySchema = z.object({
  practitionerId: identifierSchema,
  serviceId: identifierSchema,
  locationId: identifierSchema,
  date: dateOnlySchema,
  durationMinutes: z.coerce.number().int().min(5).max(480).optional(),
});
export type ExplainQuery = z.infer<typeof explainQuerySchema>;

export interface ExplainStep {
  /** `HH:MM` on the location's wall clock. */
  time: string;
  /** The first rule that removed this start, or `null` when it is offered. */
  reason: ExplainReason | null;
  /** A plain sentence: "Holiday: Diwali", "Buffer after the 11:00 visit". Empty when offered. */
  label: string;
}

export interface ExplainBand {
  from: string;
  to: string;
  reason: ExplainReason | null;
  label: string;
}

export interface ExplainResult {
  date: string;
  timezone: string;
  durationMinutes: number;
  /** One entry per 15 minutes from midnight to midnight. */
  steps: ExplainStep[];
  /** The same steps joined into stretches with the same answer. */
  bands: ExplainBand[];
  /** The out of office note, when the person is away that day. */
  outOfOfficeNote: string | null;
}
