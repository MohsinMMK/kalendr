import "server-only";

import { withTenant } from "@/db/client";
import { emailIsConfigured, env } from "@/server/env";

import { can, requirePermission, type StaffContext } from "../staff-context";
import { loadRetentionSettings, type RetentionSettings } from "./retention-settings";
import { effectiveRetention, retentionKinds } from "./rules";

export interface CollectedItem {
  what: string;
  why: string;
  /** How long it is kept, in words, or where to change that. */
  keptFor: string;
}

export interface SharedWith {
  provider: string;
  /** What they receive. */
  receives: string;
  why: string;
  /** True when this business's setup uses them now; false when they only apply once the feature is switched on. */
  active: boolean;
}

export interface ProcessingSummary {
  collected: CollectedItem[];
  sharedWith: SharedWith[];
  retention: RetentionSettings;
}

/**
 * What the business collects, why, and who receives it. The list of services comes from the providers Kalendr is built
 * to use (docs/build-plan/LIBRARIES_AND_APIS.md); `active` reflects this server's settings. It is a starting point for
 * the owner's own privacy notice, not a finished legal document.
 */
export function buildProcessingSummary(settings: ReturnType<typeof env>, emailOn: boolean): Omit<ProcessingSummary, "retention"> {
  return {
    collected: [
      { what: "Name, phone, email, date of birth", why: "To book and run appointments and to reach the customer.", keptFor: "Until the customer asks for erasure or the business removes them." },
      { what: "Bookings: dates, services, who the customer saw, notes and reasons for visit", why: "To run appointments and keep a history of visits.", keptFor: "Notes on cancelled bookings follow the retention settings below." },
      { what: "Answers to booking forms", why: "So staff have what they need before the visit.", keptFor: "Until erasure is approved." },
      { what: "Visit notes, reports and prescriptions (if records are on)", why: "Care and legal record keeping.", keptFor: "The records period in the retention settings below." },
      { what: "Payments and refunds taken at the desk", why: "Accounts and tax records. Card or UPI details are never stored.", keptFor: "The billing period in the retention settings below." },
      { what: "Consent choices and when they were made", why: "To show that messages follow the customer's choices.", keptFor: "Kept as a record, with no name on it." },
      { what: "Activity log: who changed what and when", why: "Security and accountability.", keptFor: "Never deleted. Personal details inside old entries are replaced when a customer is erased." },
      { what: "Sign-in codes for the customer portal", why: "To let customers sign in.", keptFor: "Removed after 1 day." },
    ],
    sharedWith: [
      { provider: "Email delivery (Resend)", receives: "The customer's email address and the text of the message.", why: "To send confirmations, reminders and links by email.", active: emailOn },
      { provider: "Text message provider (MSG91 or Twilio)", receives: "The customer's phone number and the text of the message.", why: "To send reminders by text. Only after the customer agrees.", active: Boolean(settings.SMS_PROVIDER && settings.SMS_API_KEY) },
      { provider: "WhatsApp Business (Meta)", receives: "The customer's phone number and the text of the message.", why: "To send reminders on WhatsApp. Only after the customer agrees.", active: false },
      { provider: "Bot protection (Cloudflare Turnstile)", receives: "The visitor's network address and a browser check.", why: "To stop automated sign-ups on public forms.", active: Boolean(settings.TURNSTILE_SECRET_KEY) },
      { provider: "File storage (S3-compatible)", receives: "Record files and pictures, encrypted before they leave the server.", why: "To keep files safe and available.", active: settings.KALENDR_FILE_STORE === "s3" },
      { provider: "Virus scanning (ClamAV, run by Kalendr)", receives: "Uploaded files, in memory only.", why: "To block harmful files.", active: Boolean(settings.CLAMAV_HOST) },
      { provider: "Error reports (Sentry)", receives: "Technical error details with names, contacts and message text removed.", why: "To find and fix faults.", active: Boolean(settings.SENTRY_DSN) },
      { provider: "Online payments (Razorpay)", receives: "The amount and the customer's payment details, entered on Razorpay's own page.", why: "To take payments online. Not part of this version.", active: false },
    ],
  };
}

export async function getProcessingSummary(context: StaffContext): Promise<ProcessingSummary> {
  if (!can(context, "settings.manage")) requirePermission(context, "privacy.manage");
  const base = buildProcessingSummary(env(), emailIsConfigured());
  if (context.preview) return { ...base, retention: { policies: retentionKinds.map((dataKind) => ({ dataKind, ...effectiveRetention("healthcare", [])[dataKind] })) } };
  return withTenant(context.tenantId, async (transaction) => ({ ...base, retention: await loadRetentionSettings(transaction, context.tenantId) }));
}
