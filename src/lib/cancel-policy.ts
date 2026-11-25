import { z } from "zod";

/**
 * Cancel and reschedule policy (feature 42): what a customer may do from their manage link and how late, the
 * reasons they pick, and the reasons staff pick. Pure and shared, so the manage page's hint and the server's
 * refusal come from the same function.
 *
 * Seam for online payments (feature 23): the business's late-cancellation fee and refund rules read
 * `cancellationDeadline(policy, startsAt)` as "free until"; they must not keep a second copy of the cut-off.
 */

export const cancelPolicySchema = z.object({
  allowCustomerCancel: z.boolean(),
  allowCustomerReschedule: z.boolean(),
  /** Minutes before the start inside which the customer can no longer cancel. 0 is any time. */
  cancelCutoffMinutes: z.number().int().min(0).max(43_200),
  rescheduleCutoffMinutes: z.number().int().min(0).max(43_200),
  /** On: the customer sees only the same person's times when moving a booking. */
  rescheduleSamePerson: z.boolean(),
  /** Days the customer has to choose a time after staff ask them to. */
  rescheduleRequestDays: z.number().int().min(1).max(60),
});
export type CancelPolicy = z.infer<typeof cancelPolicySchema>;
export const defaultCancelPolicy: CancelPolicy = {
  allowCustomerCancel: true,
  allowCustomerReschedule: true,
  cancelCutoffMinutes: 0,
  rescheduleCutoffMinutes: 0,
  rescheduleSamePerson: true,
  rescheduleRequestDays: 7,
};

/** What a customer picks when they cancel. */
export const customerCancelReasons = ["cant_make_it", "booked_by_mistake", "found_another_time", "feeling_better", "other"] as const;
export type CustomerCancelReason = (typeof customerCancelReasons)[number];
export const customerCancelReasonLabels: Record<CustomerCancelReason, string> = {
  cant_make_it: "I can't make it",
  booked_by_mistake: "I booked by mistake",
  found_another_time: "I found another time",
  feeling_better: "I'm feeling better",
  other: "Something else",
};
/** Every code the database accepts on `appointments.cancel_reason_code`. */
export const cancelReasonCodes = [...customerCancelReasons, "staff_preset", "reschedule_expired"] as const;
export type CancelReasonCode = (typeof cancelReasonCodes)[number];
export const cancelReasonLabels: Record<CancelReasonCode, string> = {
  ...customerCancelReasonLabels,
  staff_preset: "Cancelled by the business",
  reschedule_expired: "No new time was chosen",
};
export function isCancelReasonCode(value: string | null | undefined): value is CancelReasonCode {
  return (cancelReasonCodes as readonly string[]).includes(value ?? "");
}

export const MAX_NOTE_LENGTH = 500;
export const CANCEL_PRESET_LABEL_MAX = 80;
export const MAX_CANCEL_PRESETS = 20;

export const cancelPresetInputSchema = z.object({
  label: z.string().trim().min(2).max(CANCEL_PRESET_LABEL_MAX),
});
export interface CancelPreset { id: string; label: string; sortOrder: number }

export type CancelledBy = "customer" | "staff" | "system";

export interface PolicyDecision {
  allowed: boolean;
  /** Why not: the business switched it off, or the start is too close. */
  reason: "disabled" | "inside_cutoff" | null;
  /** The last moment the action is allowed, or null when it is not limited by time. */
  cutoffAt: Date | null;
}

function cutoffAt(startsAt: Date, minutes: number): Date | null {
  return minutes > 0 ? new Date(startsAt.getTime() - minutes * 60_000) : null;
}

/** The last moment a customer may cancel for free. Late-cancellation fees (feature 23) read this. */
export function cancellationDeadline(policy: Pick<CancelPolicy, "cancelCutoffMinutes">, startsAt: Date): Date | null {
  return cutoffAt(startsAt, policy.cancelCutoffMinutes);
}

export function customerCancelDecision(policy: CancelPolicy, startsAt: Date, now: Date): PolicyDecision {
  const limit = cutoffAt(startsAt, policy.cancelCutoffMinutes);
  if (!policy.allowCustomerCancel) return { allowed: false, reason: "disabled", cutoffAt: limit };
  if (limit && now.getTime() > limit.getTime()) return { allowed: false, reason: "inside_cutoff", cutoffAt: limit };
  return { allowed: true, reason: null, cutoffAt: limit };
}

export function customerRescheduleDecision(policy: CancelPolicy, startsAt: Date, now: Date): PolicyDecision {
  const limit = cutoffAt(startsAt, policy.rescheduleCutoffMinutes);
  if (!policy.allowCustomerReschedule) return { allowed: false, reason: "disabled", cutoffAt: limit };
  if (limit && now.getTime() > limit.getTime()) return { allowed: false, reason: "inside_cutoff", cutoffAt: limit };
  return { allowed: true, reason: null, cutoffAt: limit };
}

/** "12 hours", "1 day", "90 minutes": the cut-off in words a customer reads. */
export function cutoffWords(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} ${minutes === 1440 ? "day" : "days"}`;
  if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
  return `${minutes} minutes`;
}

/** The sentence shown where a button would be, or the refusal's message. */
export function policyMessage(action: "cancel" | "reschedule", decision: PolicyDecision, policy: CancelPolicy, businessPhone?: string | null): string {
  const verb = action === "cancel" ? "cancelled" : "moved";
  const minutes = action === "cancel" ? policy.cancelCutoffMinutes : policy.rescheduleCutoffMinutes;
  const call = businessPhone ? ` Please call ${businessPhone}.` : " Please contact the business.";
  if (decision.reason === "disabled") return `This booking can't be ${verb} online.${call}`;
  if (decision.reason === "inside_cutoff") return `It can't be ${verb} online within ${cutoffWords(minutes)} of the start.${call}`;
  return "";
}
