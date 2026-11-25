/**
 * Sign-in rules, shared by the server and the screens. Owners and admins always need a second
 * factor; a business can ask for it from everyone. How recent a second-factor check must be for
 * the sensitive actions (step-up) lives here too, so the screens and the server agree.
 */
import { z } from "zod";

import type { StaffRole } from "@/lib/permissions";

/** Minutes a second-factor check stays good for the actions that ask for one again. */
export const stepUpWindowMinutes = 10;

const securityPolicySchema = z.object({
  requireSecondFactorForAll: z.boolean().catch(false),
});

export type SecurityPolicy = z.infer<typeof securityPolicySchema>;

/** Reads the stored jsonb. Anything missing or malformed means the default rules. */
export function parseSecurityPolicy(value: unknown): SecurityPolicy {
  const parsed = securityPolicySchema.safeParse(typeof value === "object" && value !== null ? value : {});
  return parsed.success ? parsed.data : { requireSecondFactorForAll: false };
}

export const securityPolicyInput = z.object({ requireSecondFactorForAll: z.boolean() }).strict();

/** Whether a person in this role must have a second factor before they see any data. */
export function secondFactorRequired(role: StaffRole, policy: SecurityPolicy): boolean {
  return role === "owner" || role === "admin" || policy.requireSecondFactorForAll;
}

/** True while a second-factor check made at `at` still counts for a step-up action. */
export function stepUpIsFresh(at: Date | null, now: Date = new Date()): boolean {
  return at !== null && now.getTime() - at.getTime() <= stepUpWindowMinutes * 60_000;
}

/** Error codes the screens route on. */
export const secondFactorErrorCodes = {
  /** The role needs a second factor and the person has none yet: send them to enrolment. */
  required: "second_factor_required",
  /** They have one but this sign-in hasn't used it: ask for the code. */
  pending: "second_factor_pending",
  /** A sensitive action needs a code from the last few minutes. */
  stepUp: "step_up_required",
} as const;
