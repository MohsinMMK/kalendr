import { defaultBusinessProfile, profileWords, type TermWords } from "../../lib/terminology";

/** The business's own words that emails use: "client" instead of "patient", "booking" instead of "appointment". */
export type EmailWords = Pick<
  TermWords,
  "customer" | "customers" | "Customer" | "appointment" | "appointments" | "Appointment" | "provider" | "Provider" | "service" | "Service" | "business"
>;

/** Who the email is from, as the customer sees it. */
export interface EmailBrand {
  businessName: string;
  /** An absolute https address of the business logo, or null to show the name only. */
  logoUrl: string | null;
  /** A #rrggbb colour for the button and the top rule. */
  accentColor: string;
  /** False when the business's plan lets it hide the "using Kalendr" line and it chose to (feature 13). Missing means show it. */
  showBadge?: boolean;
  words: EmailWords;
}

/** The appointment as it reads in an email. Times are already in the business's time zone. */
export interface EmailAppointment {
  /** "Mon, 16 Nov 2026, 10:30 am IST" */
  when: string;
  serviceName: string;
  providerName: string;
  /** "Main branch, 12 MG Road, Pune" */
  place: string;
  /** The customer's private link to view, move or cancel, or null when there isn't one. */
  manageUrl: string | null;
  businessPhone: string | null;
}

export const DEFAULT_ACCENT = "#0f766e";

const ACCENT_PATTERN = /^#[0-9a-f]{6}$/i;

/** Falls back to the default for anything that isn't a plain #rrggbb colour, so a stored value can't inject CSS. */
export function safeAccent(value: string | null | undefined): string {
  return value && ACCENT_PATTERN.test(value) ? value : DEFAULT_ACCENT;
}

export const defaultEmailWords: EmailWords = profileWords(defaultBusinessProfile);

/** Sample data for `pnpm email:dev`. Never real people. */
export const previewBrand: EmailBrand = {
  businessName: "Sunrise Dental Care",
  logoUrl: null,
  accentColor: DEFAULT_ACCENT,
  words: defaultEmailWords,
};

export const previewAppointment: EmailAppointment = {
  when: "Mon, 16 Nov 2026, 10:30 am IST",
  serviceName: "Dental check-up",
  providerName: "Dr. Asha Rao",
  place: "Main branch, 12 MG Road, Pune",
  manageUrl: "https://kalendr.example/manage/sample-token",
  businessPhone: "+91 20 5555 0100",
};

/** Account emails (password reset, verification) come from Kalendr itself, not a business. */
export const kalendrBrand: Pick<EmailBrand, "businessName" | "logoUrl" | "accentColor"> = {
  businessName: "Kalendr",
  logoUrl: null,
  accentColor: DEFAULT_ACCENT,
};
