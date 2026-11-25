import "server-only";

import { sql } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { getDatabase, withTenant } from "@/db/client";
import { demoClinic } from "@/lib/demo-data";
import { parsePreviewBusinessProfile, previewBusinessProfileCookie, previewClinicWith } from "@/lib/preview-business-profile";
import { auth, authIsConfigured } from "@/lib/auth";
import { auditEvents, tenants } from "@/db/schema";
import { parseSecurityPolicy, secondFactorErrorCodes, secondFactorRequired, stepUpIsFresh } from "@/lib/security-policy";
import { chooseMembership, readActiveBusinessSlug } from "@/lib/active-business";
import { resolvePermissions, permissionKeys, type Permission, type StaffRole } from "@/lib/permissions";

import type { ImpersonationBanner } from "@/lib/admin-contracts";
import { readOnlyImpersonationPermissions } from "@/lib/admin-access";

import { ApiError } from "./api-error";
import { loadEntitlements, previewEntitlements } from "./entitlements";
import type { Entitlements } from "@/lib/entitlements";
import { isPreviewMode } from "./preview-repository";
import { impersonatedStaffContext } from "./staff-impersonation";
import { loadCustomPermissions } from "./enterprise/role-permissions";
import { getUserSecurity } from "./staff-security";

export type { Permission, StaffRole } from "@/lib/permissions";

interface MembershipRow extends Record<string, unknown> {
  tenant_id: string;
  slug: string;
  name: string;
  membership_id: string;
  role: StaffRole;
  permission_overrides: unknown;
  /** Locations this membership is limited to; empty means every location. */
  location_ids: string[] | null;
}

export interface StaffContext {
  tenantId: string;
  clinicSlug: string;
  clinicName: string;
  role: StaffRole;
  /** What this person may do right now: the role preset plus their own overrides. */
  permissions: Permission[];
  /**
   * The locations this person is limited to, or null for every location. Left out in test fixtures, preview and support
   * sessions, which means every location. Owners are never limited. Read it through `src/server/location-scope.ts`.
   */
  locationIds?: string[] | null;
  membershipId: string | null;
  userId: string | null;
  userName: string;
  userEmail: string;
  /** Whether this person has an authenticator app or a passkey. Left out in test fixtures, which means no. */
  secondFactorEnrolled?: boolean;
  /** When this sign-in last passed a second factor, or null. Step-up checks read it. */
  secondFactorAt?: Date | null;
  /** Set only while a platform operator is "viewing as this business" (feature 15). Read-only unless `writeAccess`. */
  impersonation?: ImpersonationBanner;
  /** What the business's plan allows right now (feature 14). Left out in test fixtures, which means no limits. */
  entitlements?: Entitlements;
  preview: boolean;
  /** Set when an API key made this request (feature 34). Such a context has no userId; the audit trail names the key. */
  apiKeyId?: string;
  /** The key's visible prefix, for the audit trail. */
  apiKeyPrefix?: string;
}

export function can(context: Pick<StaffContext, "permissions">, permission: Permission): boolean {
  return context.permissions.includes(permission);
}

const refusals: Record<Permission, string> = {
  "appointments.book": "You don't have permission to book or change appointments.",
  "series.manage": "You don't have permission to book or change repeating appointments.",
  "classes.manage": "You don't have permission to run classes.",
  "waitlist.manage": "You don't have permission to run the waitlist offers.",
  "appointments.status": "You don't have permission to update appointments.",
  "records.view": "You don't have permission to open records.",
  "records.accessLog": "You don't have permission to see the record access log.",
  "profile.own": "You don't have permission to edit your profile.",
  "hours.own": "You don't have permission to change your working hours.",
  "hours.edit": "You don't have permission to change working hours or blocked time.",
  "schedule.read": "You don't have permission to see why a time is missing.",
  "settings.manage": "You don't have permission to change business settings.",
  "team.manage": "You don't have permission to manage the team.",
  "audit.view": "You don't have permission to see the activity log.",
  "messages.retry": "You don't have permission to resend messages.",
  "inbox.reply": "You don't have permission to use the Inbox.",
  "payments.collect": "You don't have permission to take payments.",
  "payments.refund": "You don't have permission to give refunds.",
  "payments.close_day": "You don't have permission to close the day.",
  "payments.settings": "You don't have permission to change how online payments are set up.",
  "invoices.issue": "You don't have permission to issue invoices or credit notes.",
  "calendars.own": "You don't have permission to connect calendars.",
  "calendars.manage": "You don't have permission to manage calendar sync.",
  "privacy.manage": "You don't have permission to handle privacy requests.",
  "billing.manage": "Only the owner can change the plan or billing. Ask them to do it.",
  "api.manage": "You don't have permission to manage API keys and webhooks.",
  "apps.manage": "You don't have permission to install or remove apps.",
  "brand.manage": "You don't have permission to change the logo or cover photo. Ask the owner.",
  "spam.manage": "You don't have permission to review spam reports or the blocklist.",
  "services.manage": "You don't have permission to manage service templates or special links.",
  "customers.manage": "You don't have permission to change customer profiles.",
  "customers.merge": "You don't have permission to merge customer profiles.",
  "campaigns.manage": "You don't have permission to run campaigns.",
  "org.manage": "You don't have permission to manage the organisation.",
  "routing.manage": "You don't have permission to build routing forms.",
  "routing.report": "You don't have permission to flag a wrongly routed booking.",
  "reports.view": "You don't have permission to see reports.",
  "reports.revenue": "You don't have permission to see revenue figures.",
  "reports.export": "You don't have permission to export reports.",
};

/**
 * "View as this business" without write access can look but never change anything. Called by `requirePermission` for
 * every permission that is not a plain read, and by write routes that have no permission of their own.
 */
export function assertNotReadOnlyImpersonation(context: Pick<StaffContext, "impersonation">): void {
  if (context.impersonation && !context.impersonation.writeAccess) {
    throw new ApiError(403, "read_only_support_session", "You are viewing this business as Kalendr support. This session is read-only, so nothing can be changed.");
  }
}

/**
 * For routes that take or hand out a secret or a way to sign in as someone (channel credentials, calendar links, password
 * and invite links, the security policy, privacy handling): refused during any support session, write access or not.
 */
export function assertNotImpersonating(context: Pick<StaffContext, "impersonation">): void {
  if (context.impersonation) {
    throw new ApiError(403, "support_session_restricted", "Kalendr support cannot do this while viewing as your business. Ask the business owner to do it.");
  }
}

/** Throws 403 and records the refused attempt in the activity log. */
export function requirePermission(context: StaffContext, permission: Permission): void {
  if (!readOnlyImpersonationPermissions.includes(permission)) assertNotReadOnlyImpersonation(context);
  if (can(context, permission)) return;
  if (!context.preview) {
    void withTenant(context.tenantId, (transaction) => transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action: "staff.permission.refused",
      outcome: "denied",
      metadata: { permission, role: context.role },
    })).catch(() => undefined);
  }
  throw new ApiError(403, "forbidden", refusals[permission]);
}

/**
 * Sensitive actions (changing roles and permissions, payment settings, API keys, data export,
 * deleting a customer) need a second-factor check from the last 10 minutes. Throws
 * `step_up_required`, which the screens answer by asking for a code and trying again.
 */
export function requireRecentStepUp(context: Pick<StaffContext, "preview" | "secondFactorEnrolled" | "secondFactorAt">, now: Date = new Date()): void {
  if (context.preview) return;
  if (!context.secondFactorEnrolled) {
    throw new ApiError(403, secondFactorErrorCodes.required, "Set up a second factor in Profile, Security before doing this.");
  }
  if (!stepUpIsFresh(context.secondFactorAt ?? null, now)) {
    throw new ApiError(403, secondFactorErrorCodes.stepUp, "Enter a code from your authenticator app to continue.");
  }
}

/** The preview business's name for the chosen type, such as "Indiranagar Salon". Read here, not from business-profile.ts, which imports this file. */
async function previewClinicName(): Promise<string> {
  try {
    const store = await cookies();
    return previewClinicWith(parsePreviewBusinessProfile(store.get(previewBusinessProfileCookie)?.value)).name;
  } catch {
    return demoClinic.name;
  }
}

export async function getStaffContext(requestHeaders: Headers, requestedSlug?: string): Promise<StaffContext> {
  if (isPreviewMode()) {
    return { tenantId: demoClinic.id, clinicSlug: demoClinic.slug, clinicName: await previewClinicName(), role: "owner", permissions: [...permissionKeys], membershipId: null, userId: null, userName: "Preview staff", userEmail: demoClinic.email, secondFactorEnrolled: false, secondFactorAt: null, entitlements: previewEntitlements(), preview: true };
  }
  if (!authIsConfigured) throw new ApiError(503, "auth_unavailable", "Staff sign-in is not configured.");
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) throw new ApiError(401, "unauthorized", "Sign in is required.");
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "Business data is unavailable.");
  const impersonated = await impersonatedStaffContext(requestHeaders, session, requestedSlug);
  if (impersonated) return impersonated;
  const memberships = await database.execute<MembershipRow>(sql`select * from kalendr_resolve_staff_access(${session.user.id})`);
  // One login can work in several businesses: a named slug, then the remembered business, then the first.
  const selected = chooseMembership(memberships, { requestedSlug, cookieSlug: readActiveBusinessSlug(requestHeaders.get("cookie")) });
  if (!selected) throw new ApiError(403, "forbidden", "No active business membership is available.");
  // The plan is read in the same scope as the security policy: one connection, no extra round trip per request.
  const [security, scoped] = await Promise.all([
    getUserSecurity(session.user.id),
    withTenant(selected.tenant_id, async (transaction) => ({
      policyRows: await transaction.select({ securityPolicy: tenants.securityPolicy }).from(tenants).where(sql`${tenants.id} = ${selected.tenant_id}`).limit(1),
      billing: await loadEntitlements(selected.tenant_id, transaction),
      customPermissions: await loadCustomPermissions(transaction, selected.tenant_id, selected.membership_id),
    })),
  ]);
  const policyRows = scoped.policyRows;
  const enrolled = security.twoFactorEnabled || security.passkeyCount > 0;
  const secondFactorAt = session.session.secondFactorAt ? new Date(session.session.secondFactorAt) : null;
  // Password sign-in with an authenticator app is challenged by Better Auth itself. Google, Microsoft,
  // magic links and passkey-only people are not, so every sign-in is checked here, not just the password ones.
  if (secondFactorRequired(selected.role, parseSecurityPolicy(policyRows[0]?.securityPolicy)) && !enrolled) {
    throw new ApiError(403, secondFactorErrorCodes.required, "Set up a second factor to open your workspace.");
  }
  if (enrolled && !secondFactorAt) {
    throw new ApiError(403, secondFactorErrorCodes.pending, "Enter your second-factor code to continue.");
  }
  return { tenantId: selected.tenant_id, clinicSlug: selected.slug, clinicName: selected.name, role: selected.role, permissions: resolvePermissions(selected.role, selected.permission_overrides, scoped.customPermissions), locationIds: selected.role === "owner" || !selected.location_ids?.length ? null : selected.location_ids, membershipId: selected.membership_id, userId: session.user.id, userName: session.user.name, userEmail: session.user.email, secondFactorEnrolled: enrolled, secondFactorAt, entitlements: scoped.billing.entitlements, preview: false };
}

/**
 * The signed-in staff member for this request, read once. A staff page asks for it in its metadata,
 * its layout and its own permission check; React's request cache makes those one session and database read.
 */
const cachedStaffContext = cache(async (requestedSlug: string): Promise<StaffContext> => getStaffContext(await headers(), requestedSlug || undefined));
// React's cache keys on the arguments as passed, so f() and f(undefined) would be two entries; always pass one string.
export function currentStaffContext(requestedSlug?: string): Promise<StaffContext> {
  return cachedStaffContext(requestedSlug ?? "");
}

export async function requireStaffPageContext(requestedSlug?: string): Promise<StaffContext> {
  try {
    return await currentStaffContext(requestedSlug);
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    if (error instanceof ApiError && error.code === secondFactorErrorCodes.required) redirect("/security/second-factor");
    if (error instanceof ApiError && error.code === secondFactorErrorCodes.pending) redirect("/sign-in/verify");
    if (error instanceof ApiError && error.status === 403) redirect("/access-denied");
    throw error;
  }
}
