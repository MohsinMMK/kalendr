import { z } from "zod";

import { bookingBotFieldNames } from "./bot-check";
import { timePreferences } from "./waitlist";

/** The longest a person may wait for a time, so an entry cannot sit open for a year. */
export const WAITLIST_MAX_DAYS = 90;
/** Active entries one customer may have in one business at once. */
export const WAITLIST_MAX_ACTIVE_PER_CUSTOMER = 5;

const identifier = z.string().min(1).max(80);

/** A customer asking, from the booking page, to be told when a time opens. Checked again on the server. */
export const publicWaitlistSchema = z.strictObject({
  clinicSlug: z.string().min(2).max(80),
  serviceId: identifier,
  locationId: identifier,
  /** People they would see. Empty means anyone who offers the service. */
  practitionerIds: z.array(identifier).max(20).default([]),
  dateFrom: z.iso.date(),
  dateTo: z.iso.date(),
  timePreference: z.enum(timePreferences as [string, ...string[]]),
  firstName: z.string().trim().min(2).max(80),
  lastName: z.string().trim().max(80),
  phone: z.union([z.string().trim().min(8).max(24), z.literal("")]),
  email: z.union([z.email().max(254), z.literal("")]),
  preferredChannel: z.enum(["sms", "email", "whatsapp", "phone"]),
  /** Offers by text or WhatsApp. Without it an offer goes by email, so an email address is then needed. */
  messagingConsent: z.boolean().default(false),
  acceptedPrivacyNotice: z.literal(true),
  [bookingBotFieldNames.honeypot]: z.string().max(500).optional(),
  [bookingBotFieldNames.fillMs]: z.number().int().nonnegative().max(7 * 24 * 60 * 60 * 1_000).optional(),
}).refine((value) => value.dateTo >= value.dateFrom, { path: ["dateTo"], message: "The last day must be on or after the first day." })
  .refine((value) => Boolean(value.email) || (Boolean(value.phone) && value.messagingConsent), {
    path: ["email"], message: "Enter an email, or a phone number and agree to messages, so we can reach you.",
  });

export type PublicWaitlistInput = z.infer<typeof publicWaitlistSchema>;

export interface WaitlistJoinResult {
  entryId: string;
  /** True when the person already had an entry for this service and it was updated instead of a second one made. */
  updated: boolean;
}
