import { z } from "zod";

import { bookingLocationChoiceSchema } from "@/lib/service-setup";

import { formAnswersSchema } from "./booking-forms";

export const appointmentStatusSchema = z.enum([
  "requested",
  "booked",
  "checked_in",
  "completed",
  "cancelled",
  "no_show",
  "entered_in_error",
  "declined",
  "expired",
  "reschedule_requested",
  "pending_payment",
]);

/** A real birth date: not in the future and not before 1900. */
export const dateOfBirthSchema = z.iso.date().refine(
  (value) => value >= "1900-01-01" && value <= new Date().toISOString().slice(0, 10),
  "Enter a real date of birth.",
);

export const reasonForVisitSchema = z.string().trim().max(500);

/**
 * Where an online booking came from. Only for reporting, so a malformed value is dropped
 * rather than failing the booking.
 */
export const bookingOriginSchema = z.object({
  channel: z.enum(["hosted", "widget", "iframe"]),
  referrerHost: z.string().trim().toLowerCase().max(253).regex(/^[a-z0-9.-]+(?::\d{1,5})?$/).optional().catch(undefined),
  utmSource: z.string().trim().max(100).optional().catch(undefined),
  utmMedium: z.string().trim().max(100).optional().catch(undefined),
  utmCampaign: z.string().trim().max(100).optional().catch(undefined),
}).optional().catch(undefined);

export const publicBookingFields = z.object({
  clinicSlug: z.string().min(2).max(80),
  patientType: z.enum(["new", "returning"]),
  bookingFor: z.enum(["self", "dependent"]),
  locationId: z.string().min(1),
  serviceId: z.string().min(1),
  practitionerId: z.string().min(1),
  slotId: z.string().min(1),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  firstName: z.string().trim().min(1).max(80),
  /** Empty for a one-word name: the booking form asks for one full name and splits it. */
  lastName: z.string().trim().max(80),
  /** Empty when the service takes email only. Checked against the service's contact mode on the server. */
  phone: z.union([z.string().trim().min(8).max(24), z.literal("")]),
  /** Empty when the service is phone-only. */
  email: z.union([z.email().max(254), z.literal("")]),
  preferredChannel: z.enum(["sms", "email", "whatsapp", "phone"]),
  accessibilityNeed: z.string().trim().max(300).optional(),
  dateOfBirth: dateOfBirthSchema.optional(),
  reasonForVisit: reasonForVisitSchema.optional(),
  acceptedPrivacyNotice: z.literal(true),
  /** Reminders by text or WhatsApp. Email confirmations are sent either way. */
  messagingConsent: z.boolean().default(false),
  origin: bookingOriginSchema,
  /** Answers to the business's booking form for this service, checked on the server against the stored form. */
  formAnswers: formAnswersSchema.optional(),
  /** How the customer chose to meet, when the service offers more than one way. */
  locationChoice: bookingLocationChoiceSchema.optional(),
  /** Guests, when the service allows them: they get the confirmation and updates but cannot manage the booking. */
  guests: z.array(z.email().max(254)).max(10).optional(),
  /** The one-use proof from the email check, when the service asks for one. */
  emailProof: z.string().trim().min(20).max(200).optional(),
  /** The hold the page took when the time was picked. It is turned into this booking. */
  holdToken: z.string().trim().min(20).max(200).optional(),
  /** Other times that suit the customer, offered when the booking may need approval (feature 41). */
  proposedStarts: z.array(z.iso.datetime({ offset: true })).max(10).optional(),
  /** The customer agreed to the payment policy shown before paying. Required by the server when the service takes payment online (feature 23). */
  acceptedPaymentPolicy: z.boolean().optional(),
  /** A discount code the customer typed (feature 25). Checked on the server inside the booking transaction. */
  couponCode: z.string().trim().min(1).max(40).optional(),
});

/** The joined first and last name must be at least two characters, as the booking form asks. */
export function requireFullName(value: { firstName: string; lastName: string }, context: z.RefinementCtx): void {
  if (`${value.firstName} ${value.lastName}`.trim().length < 2) {
    context.addIssue({ code: "custom", path: ["firstName"], message: "Enter your full name" });
  }
}

export const publicBookingSchema = publicBookingFields.superRefine(requireFullName);

export const appointmentTransitionSchema = z.object({
  status: appointmentStatusSchema,
  reason: z.string().trim().min(3).max(300).optional(),
  expectedVersion: z.number().int().nonnegative(),
});

export type PublicBookingInput = z.infer<typeof publicBookingSchema>;
export type BookingOriginInput = NonNullable<z.infer<typeof bookingOriginSchema>>;
export type AppointmentTransitionInput = z.infer<
  typeof appointmentTransitionSchema
>;
