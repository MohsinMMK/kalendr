import "server-only";

import { eq } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents, tenants } from "@/db/schema";
import { parseSecurityPolicy, secondFactorRequired, type SecurityPolicy } from "@/lib/security-policy";

import { getUserSecurity } from "./staff-security";
import { requirePermission, requireRecentStepUp, type StaffContext } from "./staff-context";

export interface SecuritySummary {
  twoFactorEnabled: boolean;
  passkeyCount: number;
  /** False for an invited person who has not chosen a password. The screens then skip asking for one. */
  passwordChosen: boolean;
  /** This person's role makes a second factor compulsory (owner, admin, or the business asks everyone). */
  secondFactorRequired: boolean;
  policy: SecurityPolicy;
  /** Whether the current sign-in has passed a second factor in the last 10 minutes. */
  recentlyVerified: boolean;
}

async function loadPolicy(tenantId: string): Promise<SecurityPolicy> {
  const [row] = await withTenant(tenantId, (transaction) => transaction.select({ value: tenants.securityPolicy }).from(tenants).where(eq(tenants.id, tenantId)).limit(1));
  return parseSecurityPolicy(row?.value);
}

export async function getSecuritySummary(context: StaffContext): Promise<SecuritySummary> {
  if (context.preview || !context.userId) {
    return { twoFactorEnabled: false, passkeyCount: 0, passwordChosen: true, secondFactorRequired: false, policy: { requireSecondFactorForAll: false }, recentlyVerified: false };
  }
  const [security, policy] = await Promise.all([getUserSecurity(context.userId), loadPolicy(context.tenantId)]);
  return {
    ...security,
    secondFactorRequired: secondFactorRequired(context.role, policy),
    policy,
    recentlyVerified: context.secondFactorAt ? Date.now() - context.secondFactorAt.getTime() <= 10 * 60_000 : false,
  };
}

/** The owner's choice to ask every teammate for a second factor. Changing it needs a fresh code. */
export async function setSecurityPolicy(context: StaffContext, input: SecurityPolicy): Promise<SecurityPolicy> {
  requirePermission(context, "settings.manage");
  requireRecentStepUp(context);
  const before = await loadPolicy(context.tenantId);
  await withTenant(context.tenantId, async (transaction) => {
    await transaction.update(tenants).set({ securityPolicy: input, updatedAt: new Date() }).where(eq(tenants.id, context.tenantId));
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action: "staff.security_policy.changed",
      outcome: "success",
      metadata: { requireSecondFactorForAll: { from: before.requireSecondFactorForAll, to: input.requireSecondFactorForAll } },
    });
  });
  return input;
}
