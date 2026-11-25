import "server-only";

import { ApiError } from "@/server/api-error";
import { requireFeature } from "@/server/entitlements";
import { can, requirePermission, requireRecentStepUp, type StaffContext } from "@/server/staff-context";

/**
 * The checks every organisation write shares (feature 53): the person may manage the organisation, the plan has the
 * enterprise features when `plan` is set, nothing is changed from a preview, and `stepUp` asks for a recent second-factor
 * check for the changes that decide who can sign in or what they can do.
 */
export function guardOrgWrite(context: StaffContext, options: { plan?: boolean; stepUp?: boolean } = {}): void {
  requirePermission(context, "org.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Organisation changes are unavailable in preview mode.");
  if (options.plan) requireFeature(context, "enterprise");
  if (options.stepUp) requireRecentStepUp(context);
}

/** Reading the lists the team screen needs is allowed to whoever manages the team or the organisation. */
export function guardOrgRead(context: StaffContext): void {
  if (can(context, "org.manage") || can(context, "team.manage")) return;
  requirePermission(context, "org.manage");
}

/** Turns a unique-name clash into a sentence. Postgres reports the constraint; the caller names it. */
export function duplicateError(subject: string): ApiError {
  return new ApiError(409, "duplicate", `There is already ${subject} with that name. Choose another.`);
}
