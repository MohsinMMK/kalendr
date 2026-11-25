import "server-only";

import { sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { adminSecondFactorIsFresh, readOnlyImpersonationPermissions, roleCan, writeImpersonationExcluded } from "@/lib/admin-access";
import { impersonationCookieName } from "@/lib/admin-contracts";
import { permissionKeys, type Permission } from "@/lib/permissions";

import { loadEntitlements } from "./entitlements";
import { lookupPlatformRole } from "./admin/role";
import { recordImpersonationView, resolveImpersonation } from "./admin/impersonation";
import { getUserSecurity } from "./staff-security";
import type { StaffContext } from "./staff-context";

/** Reads one cookie from a raw Cookie header, so this works on `request.headers` as well as `await headers()`. */
export function cookieValue(requestHeaders: Headers, name: string): string | null {
  for (const part of (requestHeaders.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

/** The permissions a "View as this business" session carries. Read-only unless the session was granted write access. */
export function impersonationPermissions(writeAccess: boolean): Permission[] {
  if (!writeAccess) return [...readOnlyImpersonationPermissions];
  return permissionKeys.filter((key) => !writeImpersonationExcluded.includes(key));
}

/** The page the operator is on: the proxy's x-pathname for documents, else the page that made an API call. Never a query string. */
function viewedPath(requestHeaders: Headers): string {
  const direct = requestHeaders.get("x-pathname");
  if (direct) return direct;
  const referer = requestHeaders.get("referer");
  if (referer && URL.canParse(referer)) return `via ${new URL(referer).pathname}`;
  return "unknown";
}

interface SessionIdentity {
  user: { id: string; name: string };
  session: { secondFactorAt?: Date | string | null };
}

/**
 * When the signed-in person is a platform operator holding a live "View as this business" cookie, the business's staff
 * context as an owner limited to what the session allows. Returns null in every other case (no cookie, expired or ended
 * session, not an operator who may impersonate, second factor not fresh, or a different business asked for), so the
 * ordinary membership rules then apply, which for an operator without a membership means a plain refusal.
 */
export async function impersonatedStaffContext(requestHeaders: Headers, identity: SessionIdentity, requestedSlug?: string): Promise<StaffContext | null> {
  const token = cookieValue(requestHeaders, impersonationCookieName);
  if (!token) return null;
  const role = await lookupPlatformRole(identity.user.id);
  if (!role || !roleCan(role, "impersonate")) return null;
  const security = await getUserSecurity(identity.user.id);
  const secondFactorAt = identity.session.secondFactorAt ? new Date(identity.session.secondFactorAt) : null;
  if ((!security.twoFactorEnabled && security.passkeyCount === 0) || !adminSecondFactorIsFresh(secondFactorAt)) return null;
  const live = await resolveImpersonation(identity.user.id, token);
  if (!live) return null;
  // Write access was fixed when the session started; a role that has since dropped to support cannot keep it.
  const writeAccess = live.writeAccess && roleCan(role, "impersonateWrite");
  // The plan is read in the same scope as the business row so plan limits apply in a write-access session too.
  const scoped = await withTenant(live.tenantId, async (transaction) => ({
    tenantRows: await transaction.execute<{ slug: string; name: string }>(sql`select slug, name from tenants where id = ${live.tenantId}`),
    billing: await loadEntitlements(live.tenantId, transaction),
  }));
  const [tenant] = scoped.tenantRows;
  if (!tenant || (requestedSlug && requestedSlug !== tenant.slug)) return null;
  recordImpersonationView(identity.user.id, live.sessionId, viewedPath(requestHeaders));
  return {
    tenantId: live.tenantId,
    clinicSlug: tenant.slug,
    clinicName: tenant.name,
    role: "owner",
    permissions: impersonationPermissions(writeAccess),
    membershipId: null,
    userId: identity.user.id,
    userName: "Kalendr support",
    // Never the operator's own address: it must not end up on the business's rows.
    userEmail: "support@kalendr.invalid",
    secondFactorEnrolled: true,
    secondFactorAt,
    entitlements: scoped.billing.entitlements,
    preview: false,
    impersonation: { sessionId: live.sessionId, endsAt: live.endsAt.toISOString(), writeAccess, businessName: tenant.name },
  };
}
