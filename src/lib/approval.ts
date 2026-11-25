import { z } from "zod";

import freeMailDomains from "../server/data/free-mail-domains.json";

/**
 * Approval rules (feature 41): which bookings wait for staff, what a decline says, and the pure rule that decides
 * between "booked" and "requested". The editor, the booking page and the server share these shapes.
 */

export const approvalRules = ["never", "always", "short_notice", "free_mail"] as const;
export type ApprovalRule = (typeof approvalRules)[number];
export const approvalRuleLabels: Record<ApprovalRule, string> = {
  never: "Never, book straight away",
  always: "Always, I approve every booking",
  short_notice: "Only last-minute bookings",
  free_mail: "Only from free email addresses",
};
export const approvalRuleHints: Record<ApprovalRule, string> = {
  never: "Customers get a confirmed booking at once.",
  always: "Every booking waits until you approve it.",
  short_notice: "Bookings made close to the start wait for you. Later ones are confirmed at once.",
  free_mail: "Gmail, Yahoo and similar addresses wait for you, which helps against spam. Work addresses are confirmed at once.",
};

export const APPROVAL_NOTICE_MAX_HOURS = 720;
export const MAX_PROPOSED_TIMES = 10;

export const approvalSettingsSchema = z.object({
  rule: z.enum(approvalRules),
  /** Used by `short_notice`: a booking starting within this many hours waits for approval. */
  noticeHours: z.number().int().min(1).max(APPROVAL_NOTICE_MAX_HOURS),
  /** On: a waiting request keeps its slot. Off: the slot stays open and approving checks it is still free. */
  requestsHoldSlot: z.boolean(),
  /** Keep the address or call details out of confirmations until the booking is approved. */
  hideLocationUntilConfirmed: z.boolean(),
});
export type ApprovalSettings = z.infer<typeof approvalSettingsSchema>;
export const defaultApprovalSettings: ApprovalSettings = { rule: "never", noticeHours: 24, requestsHoldSlot: true, hideLocationUntilConfirmed: false };

/** Why staff turned a request down. Fixed codes, so no free text reaches the audit trail. */
export const declineReasons = ["fully_booked", "outside_services", "need_information", "other"] as const;
export type DeclineReason = (typeof declineReasons)[number];
export const declineReasonLabels: Record<DeclineReason, string> = {
  fully_booked: "We are fully booked",
  outside_services: "It is outside what we offer",
  need_information: "We need more information",
  other: "Another reason",
};
export function isDeclineReason(value: string | null | undefined): value is DeclineReason {
  return (declineReasons as readonly string[]).includes(value ?? "");
}

const freeMail: ReadonlySet<string> = new Set(freeMailDomains);

/** True when the address is on a free-mail provider's domain. An address that is not valid counts as free-mail: it is the riskier choice. */
export function isFreeMailAddress(email: string | null | undefined): boolean {
  const address = (email ?? "").trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at < 1 || at === address.length - 1) return true;
  return freeMail.has(address.slice(at + 1));
}

export interface ApprovalInput {
  settings: Pick<ApprovalSettings, "rule" | "noticeHours">;
  startsAt: Date;
  now: Date;
  /** What the customer typed. Empty when they gave a phone number only. */
  email: string | null | undefined;
}

/** The one rule that decides whether a new online booking is confirmed or waits for staff. */
export function decideApproval(input: ApprovalInput): "booked" | "requested" {
  switch (input.settings.rule) {
    case "never": return "booked";
    case "always": return "requested";
    case "short_notice": return input.startsAt.getTime() - input.now.getTime() <= input.settings.noticeHours * 3_600_000 ? "requested" : "booked";
    // No email at all (phone-only booking) cannot be checked, so it waits too.
    case "free_mail": return isFreeMailAddress(input.email) ? "requested" : "booked";
  }
}

/** The service's rule in a sentence, for the editor and the booking page. */
export function approvalSummary(settings: ApprovalSettings): string {
  switch (settings.rule) {
    case "never": return "Bookings are confirmed at once.";
    case "always": return "Every booking waits for your approval.";
    case "short_notice": return `Bookings starting within ${settings.noticeHours} hour${settings.noticeHours === 1 ? "" : "s"} wait for your approval.`;
    case "free_mail": return "Bookings from free email addresses wait for your approval.";
  }
}

/** Does this rule ever ask the customer to wait? The booking page shows "also works for me" times only then. */
export function mayNeedApproval(rule: ApprovalRule): boolean {
  return rule !== "never";
}
