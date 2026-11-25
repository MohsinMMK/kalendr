import "server-only";

import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { adminCapabilities, adminClientIp, adminHostAllowed, adminIpAllowed, adminSecondFactorIsFresh, parseIpAllowlist, roleCan, type AdminCapability } from "@/lib/admin-access";
import type { PlatformRole } from "@/lib/admin-contracts";
import { auth, authIsConfigured } from "@/lib/auth";
import { secondFactorErrorCodes } from "@/lib/security-policy";

import { lookupPlatformRole } from "./admin/role";
import { ApiError } from "./api-error";
import { env } from "./env";
import { isPreviewMode } from "./preview-repository";
import { requireRecentStepUp } from "./staff-context";
import { getUserSecurity } from "./staff-security";

/**
 * Who is asking, for the platform admin console. Separate from `getStaffContext`: an operator's session is not a staff
 * session and a staff session is never an operator's. Every refusal for someone who is not an operator is the same
 * 404 `not_found` a missing page gives, so the console cannot be told apart from nothing.
 */
export interface AdminContext {
  userId: string;
  role: PlatformRole;
  secondFactorEnrolled: true;
  secondFactorAt: Date;
  /** Always false: the console does not exist in preview mode. Lets `requireRecentStepUp` take this context. */
  preview: false;
}

const notFoundError = () => new ApiError(404, "not_found", "That page could not be found.");

export type AdminResolution =
  | { kind: "ok"; context: AdminContext }
  | { kind: "no_session" }
  | { kind: "refused" }
  | { kind: "second_factor_required" }
  | { kind: "second_factor_pending" };

/** Where the request comes from must match the optional host and IP limits before anything else is looked at. */
function placeAllowed(requestHeaders: Headers): boolean {
  const settings = env();
  if (!adminHostAllowed(requestHeaders.get("host"), settings.KALENDR_ADMIN_HOST)) return false;
  return adminIpAllowed(adminClientIp(requestHeaders, settings.TRUSTED_PROXY_HOPS ?? 0), parseIpAllowlist(settings.KALENDR_ADMIN_IP_ALLOWLIST));
}

export async function resolveAdmin(requestHeaders: Headers): Promise<AdminResolution> {
  if (isPreviewMode() || !authIsConfigured) return { kind: "refused" };
  if (!placeAllowed(requestHeaders)) return { kind: "refused" };
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return { kind: "no_session" };
  const role = await lookupPlatformRole(session.user.id);
  if (!role) return { kind: "refused" };
  // From here on the person is a known operator, so naming the missing second factor reveals nothing.
  const security = await getUserSecurity(session.user.id);
  if (!security.twoFactorEnabled && security.passkeyCount === 0) return { kind: "second_factor_required" };
  const secondFactorAt = session.session.secondFactorAt ? new Date(session.session.secondFactorAt) : null;
  if (!secondFactorAt || !adminSecondFactorIsFresh(secondFactorAt)) return { kind: "second_factor_pending" };
  return { kind: "ok", context: { userId: session.user.id, role, secondFactorEnrolled: true, secondFactorAt, preview: false } };
}

/** For API routes. Throws 404 for everyone who is not a working operator; 403 codes only for an operator who still owes a second factor. */
export async function getAdminContext(requestHeaders: Headers): Promise<AdminContext> {
  const resolution = await resolveAdmin(requestHeaders);
  switch (resolution.kind) {
    case "ok": return resolution.context;
    case "second_factor_required": throw new ApiError(403, secondFactorErrorCodes.required, "Set up a second factor to open the console.");
    case "second_factor_pending": throw new ApiError(403, secondFactorErrorCodes.pending, "Enter your second-factor code to continue.");
    default: throw notFoundError();
  }
}

/** For server components. 404 page for refusals, sign-in only when there is no session at all. */
export async function requireAdminPageContext(): Promise<AdminContext> {
  const resolution = await resolveAdmin(await headers());
  switch (resolution.kind) {
    case "ok": return resolution.context;
    case "no_session": return redirect("/sign-in");
    case "second_factor_required": return redirect("/security/second-factor");
    case "second_factor_pending": return redirect("/sign-in/verify");
    default: return notFound();
  }
}

/** A known operator whose role lacks this capability. 403 (not 404): they already know the console exists. */
export function requireAdminCapability(context: Pick<AdminContext, "role">, capability: AdminCapability): void {
  if (roleCan(context.role, capability)) return;
  throw new ApiError(403, "forbidden", `Your platform role (${context.role}) cannot do this. It needs ${adminCapabilities[capability].join(" or ")}.`);
}

/** Impersonation with write, rollouts and operator changes also need a code from the last 10 minutes. */
export function requireAdminStepUp(context: AdminContext, now: Date = new Date()): void {
  requireRecentStepUp(context, now);
}

export { lookupPlatformRole };
