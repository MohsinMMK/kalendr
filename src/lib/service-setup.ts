import { z } from "zod";

import { approvalSettingsSchema } from "@/lib/approval";
import { cancelPolicySchema } from "@/lib/cancel-policy";
import { afterBookingSchema } from "@/lib/after-booking";
import { intakeSettingsSchema } from "@/lib/booking-intake";
import { bookingPageSettingsSchema } from "@/lib/booking-page";
import { resourceKinds } from "@/lib/business-types";

/**
 * The shapes behind "Service setup": how long a service takes and costs, when customers may
 * book it, where it happens and how it looks. The editor, the staff routes and the booking
 * page all read these, so a rule is written once here.
 */

const identifierSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export const locationOptionKinds = ["in_person", "we_call", "they_call", "video", "their_address"] as const;
export type LocationOptionKind = (typeof locationOptionKinds)[number];

export const windowKinds = ["rolling_days", "business_days", "date_range"] as const;
export type WindowKind = (typeof windowKinds)[number];

/** The slot spacings the editor offers. `null` means "same as the length". */
export const slotIntervalChoices = [5, 10, 15, 20, 30, 60] as const;

export const maxServiceLengths = 6;
export const maxNoticeMinutes = 90 * 24 * 60;

/** The names of the calendar palette (`src/components/kloq/lib/event-palette.ts`). */
export const serviceColors = ["blue", "violet", "emerald", "amber", "rose"] as const;
export type ServiceColor = (typeof serviceColors)[number];

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");

export const bookingWindowSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rolling_days"), days: z.number().int().min(1).max(365) }),
  z.object({ kind: z.literal("business_days"), days: z.number().int().min(1).max(260) }),
  z.object({ kind: z.literal("date_range"), from: dateOnlySchema, through: dateOnlySchema }),
]).refine((value) => value.kind !== "date_range" || value.through >= value.from, {
  message: "The last date must not be before the first.",
  path: ["through"],
});
export type BookingWindow = z.infer<typeof bookingWindowSchema>;

export const serviceTimingSchema = z.object({
  bufferBeforeMinutes: z.number().int().min(0).max(240),
  bufferAfterMinutes: z.number().int().min(0).max(240),
  /** Stored in minutes; the editor shows minutes, hours or days. */
  minimumNoticeMinutes: z.number().int().min(0).max(maxNoticeMinutes),
  window: bookingWindowSchema,
  /** `null` is "same as the length". */
  slotIntervalMinutes: z.number().int().min(5).max(240).nullable(),
  startOffsetMinutes: z.number().int().min(0).max(55),
});
export type ServiceTiming = z.infer<typeof serviceTimingSchema>;

export const serviceLengthSchema = z.object({
  minutes: z.number().int().min(5).max(480),
  /** In the currency's smallest unit. `null` when the price varies. */
  priceMinor: z.number().int().min(0).max(100_000_000).nullable(),
  isDefault: z.boolean(),
});
export type ServiceLength = z.infer<typeof serviceLengthSchema>;

export const serviceLengthsSchema = z.array(serviceLengthSchema).min(1).max(maxServiceLengths).superRefine((lengths, context) => {
  if (lengths.filter((length) => length.isDefault).length !== 1) {
    context.addIssue({ code: "custom", message: "Choose one length as the usual one." });
  }
  if (new Set(lengths.map((length) => length.minutes)).size !== lengths.length) {
    context.addIssue({ code: "custom", message: "Each length can only be listed once." });
  }
});

export const serviceLocationOptionSchema = z.object({
  kind: z.enum(locationOptionKinds),
  /** The branch, for `in_person` only. */
  locationId: identifierSchema.nullable(),
  note: z.string().trim().max(200).nullable(),
}).refine((value) => (value.kind === "in_person") === (value.locationId !== null), {
  message: "Choose a branch for in-person visits, and only for those.",
  path: ["locationId"],
});
export type ServiceLocationOption = z.infer<typeof serviceLocationOptionSchema>;

export const serviceLocationOptionsSchema = z.array(serviceLocationOptionSchema).min(1).max(12).refine(
  (options) => new Set(options.map((option) => `${option.kind}:${option.locationId ?? ""}`)).size === options.length,
  { message: "Each way of meeting can only be listed once." },
);

export const serviceLookSchema = z.object({
  colorLight: z.enum(serviceColors).nullable(),
  colorDark: z.enum(serviceColors).nullable(),
  bannerMediaId: identifierSchema.nullable(),
});
export type ServiceLook = z.infer<typeof serviceLookSchema>;

export const serviceSlugSchema = z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lower-case letters, numbers and dashes.");

export const serviceBasicsSchema = z.object({
  name: z.string().trim().min(2).max(160),
  /** Plain text with line breaks. No HTML. */
  description: z.string().trim().min(2).max(2000),
  category: z.string().trim().max(60).nullable(),
  bookingMode: z.enum(["instant", "request"]),
  requiredResourceKind: z.enum(resourceKinds).nullable(),
  isActive: z.boolean(),
  visibility: z.enum(["listed", "hidden"]),
  slug: serviceSlugSchema,
  /** Use this schedule's name instead of each person's default. `null` is the usual hours. */
  scheduleId: identifierSchema.nullable(),
  /** Narrows everyone's hours for this service to the overlap with this schedule. */
  restrictionScheduleId: identifierSchema.nullable(),
  locationIds: z.array(identifierSchema).min(1).max(20),
  practitionerIds: z.array(identifierSchema).max(40),
});
export type ServiceBasics = z.infer<typeof serviceBasicsSchema>;

/** What the calendar entries for this service say, and what they must leave out (feature 50). Empty text means the usual wording. */
export const calendarEntrySchema = z.object({
  customerTitle: z.string().trim().max(200).nullable(),
  staffTitle: z.string().trim().max(200).nullable(),
  description: z.string().trim().max(1000).nullable(),
  hideNotes: z.boolean(),
  hideDetails: z.boolean(),
});
export type CalendarEntry = z.infer<typeof calendarEntrySchema>;
export const defaultCalendarEntry: CalendarEntry = { customerTitle: null, staffTitle: null, description: null, hideNotes: false, hideDetails: false };

/** What `GET /api/staff/services/[id]` returns, and what the editor edits. */
export const serviceSetupSchema = z.object({
  id: identifierSchema,
  version: z.number().int().positive(),
  basics: serviceBasicsSchema,
  timing: serviceTimingSchema,
  lengths: serviceLengthsSchema,
  locationOptions: serviceLocationOptionsSchema,
  look: serviceLookSchema,
  /** Layouts, timezone lock and week start on the booking page (feature 39). */
  bookingPage: bookingPageSettingsSchema.optional(),
  /** Contact details, guests and the email check (feature 40). */
  intake: intakeSettingsSchema.optional(),
  /** Which bookings wait for staff, and what a waiting request does to the slot (feature 41). */
  approval: approvalSettingsSchema.optional(),
  /** What customers may do when cancelling or moving a booking, and how late (feature 42). */
  cancelPolicy: cancelPolicySchema.optional(),
  /** What happens once a booking is made: the confirmation, or the business's own thank-you page (feature 52). */
  afterBooking: afterBookingSchema.optional(),
  /** Calendar entry wording and privacy (feature 50). */
  calendarEntry: calendarEntrySchema.optional(),
  /** The template this service follows, with the fields only it may change (feature 48). Absent for a normal service. */
  template: z.object({ id: identifierSchema, name: z.string(), version: z.number().int().positive(), lockedFields: z.array(z.string()) }).nullable().optional(),
});
export type ServiceSetup = z.infer<typeof serviceSetupSchema>;

/** The checks that need two groups at once. The server and the editor both run them. */
export function serviceSetupIssues(setup: Pick<ServiceSetup, "timing" | "lengths">): string[] {
  const issues: string[] = [];
  const shortest = Math.min(...setup.lengths.map((length) => length.minutes));
  const interval = setup.timing.slotIntervalMinutes ?? shortest;
  if (setup.timing.startOffsetMinutes >= interval) issues.push("The start offset must be smaller than the slot interval.");
  return issues;
}

/**
 * Every field is optional, so one tab can save on its own. The groups replace the stored ones whole.
 * `expectedVersion` is required for anything beyond the plain on/off switch so two managers
 * editing at once get "someone else changed this" instead of silently overwriting each other.
 */
export const serviceSetupUpdateSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
  basics: serviceBasicsSchema.partial().optional(),
  timing: serviceTimingSchema.optional(),
  lengths: serviceLengthsSchema.optional(),
  locationOptions: serviceLocationOptionsSchema.optional(),
  look: serviceLookSchema.optional(),
  bookingPage: bookingPageSettingsSchema.optional(),
  intake: intakeSettingsSchema.optional(),
  approval: approvalSettingsSchema.optional(),
  cancelPolicy: cancelPolicySchema.optional(),
  calendarEntry: calendarEntrySchema.optional(),
  afterBooking: afterBookingSchema.optional(),
}).refine((value) => value.basics || value.timing || value.lengths || value.locationOptions || value.look || value.bookingPage || value.intake || value.approval || value.cancelPolicy || value.calendarEntry || value.afterBooking, {
  message: "Choose a service change to save.",
}).refine(
  (value) => value.expectedVersion !== undefined || !(value.timing || value.lengths || value.locationOptions || value.look || value.bookingPage || value.intake || value.approval || value.cancelPolicy || value.calendarEntry || value.afterBooking || (value.basics && Object.keys(value.basics).some((key) => key !== "isActive"))),
  { message: "Reload the service and try again.", path: ["expectedVersion"] },
);
export type ServiceSetupUpdate = z.infer<typeof serviceSetupUpdateSchema>;

/** A customer who picked "their address" or a phone-based option. */
export const bookingLocationChoiceSchema = z.object({
  kind: z.enum(locationOptionKinds),
  /** Their street address, for `their_address` only. Sealed before it is stored. */
  detail: z.string().trim().min(5).max(300).optional(),
});
export type BookingLocationChoice = z.infer<typeof bookingLocationChoiceSchema>;
