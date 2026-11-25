import { z } from "zod";

/**
 * Booking questions 2.0 (feature 40): how a service takes contact details, guests and the email check.
 * The shapes the editor, the booking page and the server share.
 */

export const contactModes = ["email_or_phone", "email_required", "phone_only"] as const;
export type ContactMode = (typeof contactModes)[number];
export const contactModeLabels: Record<ContactMode, string> = {
  email_or_phone: "Email or phone, whichever they have",
  email_required: "Email is required",
  phone_only: "Phone only (we message them by text or WhatsApp)",
};

export const GUESTS_MAX = 10;

export const intakeSettingsSchema = z.object({
  contactMode: z.enum(contactModes),
  allowGuests: z.boolean(),
  maxGuests: z.number().int().min(1).max(GUESTS_MAX),
  /** Confirm the customer's email with a 6-digit code before the booking is taken. Ignored for phone-only services. */
  verifyEmail: z.boolean(),
}).refine((value) => !(value.verifyEmail && value.contactMode === "phone_only"), {
  message: "A phone-only service has no email to check.",
  path: ["verifyEmail"],
});
export type IntakeSettings = z.infer<typeof intakeSettingsSchema>;

export const defaultIntakeSettings: IntakeSettings = { contactMode: "email_or_phone", allowGuests: false, maxGuests: 3, verifyEmail: false };

export const EMAIL_CODE_MINUTES = 10;
export const EMAIL_CODE_ATTEMPTS = 5;

const slugSchema = z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const emailCheckSendSchema = z.object({
  clinicSlug: slugSchema,
  serviceId: z.string().trim().min(1).max(160),
  email: z.email().max(254),
});
export const emailCheckVerifySchema = z.object({
  clinicSlug: slugSchema,
  email: z.email().max(254),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6 digits from the email."),
});
export const emailCheckBodySchema = z.discriminatedUnion("action", [
  emailCheckSendSchema.extend({ action: z.literal("send") }),
  emailCheckVerifySchema.extend({ action: z.literal("verify") }),
]);
export type EmailCheckBody = z.infer<typeof emailCheckBodySchema>;

/** What a person sees once the booking cannot go ahead without a checked email. */
export const emailProofSchema = z.string().trim().min(20).max(200);

/** Does this service need a checked email, given what the customer typed? Phone-only services never do. */
export function needsEmailCheck(settings: Pick<IntakeSettings, "verifyEmail" | "contactMode">, email: string | null | undefined): boolean {
  return settings.verifyEmail && settings.contactMode !== "phone_only" && Boolean(email?.trim());
}

/** Which of email and phone the customer must give, as words for the form. */
export function contactRequirements(mode: ContactMode): { email: "required" | "optional" | "hidden"; phone: "required" | "optional"; atLeastOne: boolean } {
  switch (mode) {
    case "phone_only": return { email: "hidden", phone: "required", atLeastOne: false };
    case "email_required": return { email: "required", phone: "optional", atLeastOne: false };
    case "email_or_phone": return { email: "optional", phone: "optional", atLeastOne: true };
  }
}

/** A message for the form when the contact details do not meet the mode. Null when they do. */
export function contactProblem(mode: ContactMode, contact: { email?: string | null; phone?: string | null }): { field: "email" | "phone"; message: string } | null {
  const email = contact.email?.trim() ?? "";
  const phone = contact.phone?.trim() ?? "";
  switch (mode) {
    case "phone_only": return phone ? null : { field: "phone", message: "Enter your phone number." };
    case "email_required": return email ? null : { field: "email", message: "Enter your email address." };
    case "email_or_phone": return email || phone ? null : { field: "email", message: "Enter an email address or a phone number." };
  }
}
