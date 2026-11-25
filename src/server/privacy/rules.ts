/**
 * The privacy centre's rules, with no database and no framework, so the web app, the worker and the
 * tests all read the same answers. Anything that decides "may we?" or "when?" lives here.
 *
 * No "server-only" import: the worker uses this file.
 */
import { isClinicalBusinessType, isBusinessTypeId } from "../../lib/business-types";

export const consentPurposes = ["appointment_messages", "marketing_messages", "reviews", "records_sharing"] as const;
export type ConsentPurpose = (typeof consentPurposes)[number];

export const consentSources = ["booking", "portal", "staff", "whatsapp_stop", "sms_stop", "import", "system", "unsubscribe_link"] as const;
export type ConsentSource = (typeof consentSources)[number];

export const consentActors = ["patient", "guardian", "staff", "system", "provider"] as const;
export type ConsentActor = (typeof consentActors)[number];

/**
 * What a customer who has said nothing has agreed to. Appointment messages, review requests and sharing a record
 * with the customer are part of the service they booked, so they run until the customer says stop. Marketing is
 * different: it never runs without a clear yes.
 */
export const consentDefaults: Record<ConsentPurpose, boolean> = {
  appointment_messages: true,
  marketing_messages: false,
  reviews: true,
  records_sharing: true,
};

/** The latest answer for a purpose: the newest consent row's `granted`, or undefined when there is none. */
export function evaluateConsent(purpose: ConsentPurpose, latestGranted: boolean | null | undefined): boolean {
  return typeof latestGranted === "boolean" ? latestGranted : consentDefaults[purpose];
}

export const ADULT_AGE_YEARS = 18;

/** True for a customer under 18, or one the business marked as a dependant. A customer with no birth date is judged by the dependant mark alone. */
export function isMinor(input: { dateOfBirth: string | null; isDependent: boolean }, now: Date = new Date()): boolean {
  if (input.isDependent) return true;
  if (!input.dateOfBirth) return false;
  const born = new Date(`${input.dateOfBirth}T00:00:00Z`);
  if (Number.isNaN(born.getTime())) return false;
  const eighteenth = new Date(Date.UTC(born.getUTCFullYear() + ADULT_AGE_YEARS, born.getUTCMonth(), born.getUTCDate()));
  return now.getTime() < eighteenth.getTime();
}

/**
 * The single rule behind "may this customer receive marketing?": they said yes, they are an adult, and they have not
 * withdrawn. Appointment messages never depend on it.
 */
export function marketingAllowed(input: { latestMarketingGranted: boolean | null | undefined; dateOfBirth: string | null; isDependent: boolean; erased: boolean }, now: Date = new Date()): boolean {
  if (input.erased || isMinor(input, now)) return false;
  return evaluateConsent("marketing_messages", input.latestMarketingGranted);
}

// ---- Requests -------------------------------------------------------------------------------

export const dataRequestTypes = ["export", "erasure", "correction"] as const;
export type DataRequestType = (typeof dataRequestTypes)[number];

export const dataRequestStatuses = ["requested", "approved", "refused", "processing", "completed", "failed"] as const;
export type DataRequestStatus = (typeof dataRequestStatuses)[number];

/** A request is due this many days after it is made. */
export const REQUEST_DUE_DAYS = 90;
export const EXPORT_VALID_DAYS = 7;
/** A customer must have entered their sign-in code this recently to ask for an export or an erasure. */
export const FRESH_CODE_MINUTES = 15;

const DAY_MS = 24 * 60 * 60 * 1_000;

export function requestDueAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + REQUEST_DUE_DAYS * DAY_MS);
}

/** Whole days left, rounded up so the last day still reads "1". Negative once overdue. */
export function daysRemaining(dueAt: Date, now: Date = new Date()): number {
  return Math.ceil((dueAt.getTime() - now.getTime()) / DAY_MS);
}

const openStatuses: readonly DataRequestStatus[] = ["requested", "approved", "processing"];

export function isOpenRequest(status: DataRequestStatus): boolean {
  return openStatuses.includes(status);
}

export function isOverdue(request: { status: DataRequestStatus; dueAt: Date }, now: Date = new Date()): boolean {
  return isOpenRequest(request.status) && request.dueAt.getTime() < now.getTime();
}

/** The fixed words a decision can give. The audit log stores only these, never what a person typed. */
export const decisionReasons = ["verified", "legal_retention", "identity_not_confirmed", "not_this_business", "duplicate", "unreasonable", "other"] as const;
export type DecisionReason = (typeof decisionReasons)[number];

/** What a refusal may say. Approving always uses "verified". */
export const refusalReasons: readonly DecisionReason[] = ["legal_retention", "identity_not_confirmed", "not_this_business", "duplicate", "unreasonable", "other"];

export const decisionReasonLabels: Record<DecisionReason, string> = {
  verified: "We checked it is you and went ahead.",
  legal_retention: "We are required to keep this information.",
  identity_not_confirmed: "We could not confirm it is you.",
  not_this_business: "We do not hold information about you.",
  duplicate: "This repeats an earlier request.",
  unreasonable: "We could not act on this request.",
  other: "See the note from the business.",
};

// ---- Retention ------------------------------------------------------------------------------

export const retentionKinds = [
  "login_codes",
  "message_log",
  "cancelled_booking_details",
  "finished_outbox",
  "medical_records",
  "billing_records",
] as const;
export type RetentionKind = (typeof retentionKinds)[number];
export type RetentionAction = "delete" | "anonymise";

export interface RetentionRule {
  keepDays: number;
  action: RetentionAction;
}

export const retentionKindInfo: Record<RetentionKind, { label: string; description: string; editable: boolean; minDays: number; maxDays: number }> = {
  login_codes: {
    label: "Customer sign-in codes",
    description: "Codes sent to customers to sign in to their portal. They stop working after 10 minutes; this removes the used and expired ones.",
    editable: false,
    minDays: 1,
    maxDays: 1,
  },
  message_log: {
    label: "Message log",
    description: "The record that a reminder or confirmation was sent: when, by which channel, and whether it arrived. Message text is not stored.",
    editable: true,
    minDays: 30,
    maxDays: 3650,
  },
  cancelled_booking_details: {
    label: "Cancelled booking details",
    description: "The notes, reason for visit and extra answers on cancelled and no-show bookings. The booking itself stays so your reports add up.",
    editable: true,
    minDays: 30,
    maxDays: 3650,
  },
  finished_outbox: {
    label: "Delivered system messages",
    description: "Internal hand-off records for messages that were already sent. The system removes them after 30 days at most; you can only shorten that.",
    editable: true,
    minDays: 7,
    maxDays: 30,
  },
  medical_records: {
    label: "Records and notes",
    description: "Visit notes, reports and prescriptions. These are kept for this long even when a customer asks for erasure, then removed for customers who asked.",
    editable: true,
    minDays: 365,
    maxDays: 36500,
  },
  billing_records: {
    label: "Payment and invoice records",
    description: "Payments and refunds. They are never edited, and are kept for this long even when a customer asks for erasure.",
    editable: true,
    minDays: 365,
    maxDays: 36500,
  },
};

/**
 * What a business keeps by default, by business type. These are starting points the owner can change, not legal advice:
 * the owner decides what their own rules require.
 */
export function defaultRetention(businessType: string): Record<RetentionKind, RetentionRule> {
  const clinical = isBusinessTypeId(businessType) && isClinicalBusinessType(businessType);
  return {
    login_codes: { keepDays: 1, action: "delete" },
    message_log: { keepDays: 365, action: "delete" },
    cancelled_booking_details: { keepDays: 730, action: "anonymise" },
    finished_outbox: { keepDays: 30, action: "delete" },
    medical_records: { keepDays: clinical ? 365 * 7 : 365 * 3, action: "delete" },
    billing_records: { keepDays: 365 * 8, action: "anonymise" },
  };
}

export function validateRetention(kind: RetentionKind, rule: RetentionRule): string | null {
  const info = retentionKindInfo[kind];
  if (!info.editable) return `${info.label} cannot be changed.`;
  if (!Number.isInteger(rule.keepDays) || rule.keepDays < info.minDays || rule.keepDays > info.maxDays) {
    return `${info.label} must be kept between ${info.minDays} and ${info.maxDays} days.`;
  }
  return null;
}

/** Combines the business's own settings with the defaults for its type. */
export function effectiveRetention(businessType: string, stored: readonly { dataKind: RetentionKind; keepDays: number; action: RetentionAction }[]): Record<RetentionKind, RetentionRule & { isDefault: boolean }> {
  const defaults = defaultRetention(businessType);
  const result = {} as Record<RetentionKind, RetentionRule & { isDefault: boolean }>;
  for (const kind of retentionKinds) {
    const own = retentionKindInfo[kind].editable ? stored.find((row) => row.dataKind === kind) : undefined;
    result[kind] = own ? { keepDays: own.keepDays, action: own.action, isDefault: false } : { ...defaults[kind], isDefault: true };
  }
  return result;
}

// ---- Erasure summary ------------------------------------------------------------------------

export interface ErasureFacts {
  /** Counts of what was removed or anonymised. */
  removedBookingDetails: number;
  removedFormAnswers: number;
  removedMessageLog: number;
  removedReviewNames: number;
  removedRecords: number;
  removedGuardian: boolean;
  /** What law and the business's own settings made us keep. */
  keptPayments: number;
  keptRecords: number;
  billingKeepDays: number;
  recordsKeepDays: number;
}

export interface ErasureSummary {
  removed: string[];
  kept: string[];
}

function years(days: number): string {
  const whole = Math.round(days / 365);
  return days >= 365 && whole >= 1 ? `${whole} ${whole === 1 ? "year" : "years"}` : `${days} days`;
}

/** The plain-language account of an erasure that the customer receives and the staff can read back. */
export function buildErasureSummary(facts: ErasureFacts): ErasureSummary {
  const removed = ["Your name, phone number, email address, date of birth and any access needs you gave."];
  if (facts.removedBookingDetails > 0) removed.push("Notes, reasons for visit and extra answers on your bookings. The booking dates stay, with no name on them.");
  if (facts.removedFormAnswers > 0) removed.push("The answers you gave on booking forms.");
  if (facts.removedMessageLog > 0) removed.push("The record of reminders and messages sent to you.");
  if (facts.removedReviewNames > 0) removed.push("Your name and comment on reviews you wrote. The star rating stays, with no name.");
  if (facts.removedRecords > 0) removed.push("Visit notes and reports that are past the period the business must keep them.");
  if (facts.removedGuardian) removed.push("The name and contact of the parent or guardian on file.");
  removed.push("Your name and contact inside the business's activity log. The log itself stays, so it still shows who did what and when.");
  const kept: string[] = [];
  if (facts.keptPayments > 0) {
    kept.push(`Payment and refund records (${facts.keptPayments}). The business must keep them for ${years(facts.billingKeepDays)}. They no longer show your name.`);
  }
  if (facts.keptRecords > 0) {
    kept.push(`Visit notes and reports (${facts.keptRecords}). The business keeps them for ${years(facts.recordsKeepDays)}, then removes them. They are not shown to staff as yours.`);
  }
  kept.push("A record that you agreed to or withdrew consent for messages, with no name on it. It shows the business followed your choice.");
  return { removed, kept };
}
