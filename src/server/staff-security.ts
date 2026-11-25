import "server-only";

import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";
import { auditEvents, authAccounts, authKnownDevices, authPasskeys, authSessions, authUsers } from "@/db/schema";
import { deviceLabel } from "@/lib/device-label";
import { logger } from "@/server/logger";

import { lookupPlatformRole } from "./admin/role";
import { sendNewDeviceNotice, sendSecurityChangeNotice } from "./auth-email";

/**
 * Everything about a staff sign-in that is not Better Auth itself: who may have a session at
 * all, which second factors a person has, the audit trail for sign-ins and factor changes, and
 * the notices emailed when a new device signs in or a factor changes.
 */

interface AccessRow extends Record<string, unknown> {
  tenant_id: string;
}

/** Tenants where this person has an active membership, through the same definer function the staff context uses. */
async function activeTenantIds(userId: string): Promise<string[]> {
  const database = getDatabase();
  if (!database) return [];
  const rows = await database.execute<AccessRow>(sql`select tenant_id from kalendr_resolve_staff_access(${userId})`);
  return rows.map((row) => row.tenant_id);
}

/**
 * Staff sign-in never creates access by itself. A session may only exist for a person who has an
 * active membership (an accepted or pending invite both create one). Google, Microsoft, magic
 * links, passkeys and passwords all pass through here, so the rule has one home.
 */
export async function hasActiveMembership(userId: string): Promise<boolean> {
  if ((await activeTenantIds(userId)).length > 0) return true;
  // A platform operator (feature 15) may have no business of their own. Signing in gives them no business data:
  // getStaffContext still refuses them without a membership, and the console asks for a second factor.
  return (await lookupPlatformRole(userId)) !== null;
}

export interface UserSecurity {
  twoFactorEnabled: boolean;
  passkeyCount: number;
  /** False for an invited person who has not chosen a password yet. */
  passwordChosen: boolean;
}

export async function getUserSecurity(userId: string): Promise<UserSecurity> {
  const database = getDatabase();
  if (!database) return { twoFactorEnabled: false, passkeyCount: 0, passwordChosen: false };
  const [user] = await database
    .select({ twoFactorEnabled: authUsers.twoFactorEnabled, passwordSetAt: authUsers.passwordSetAt })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .limit(1);
  const [passkeys] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(authPasskeys)
    .where(eq(authPasskeys.userId, userId));
  return {
    twoFactorEnabled: user?.twoFactorEnabled ?? false,
    passkeyCount: passkeys?.count ?? 0,
    passwordChosen: Boolean(user?.passwordSetAt),
  };
}

/** Marks this sign-in as having passed a second factor now. */
export async function markSecondFactor(sessionToken: string): Promise<void> {
  const database = getDatabase();
  if (!database) return;
  await database.update(authSessions).set({ secondFactorAt: new Date() }).where(eq(authSessions.token, sessionToken));
}

/**
 * An invited person's account starts with a random placeholder password nobody knows. Once they
 * sign in another way, remove it so no unknown credential is left lying around; "Forgot password"
 * can still set a real one.
 */
export async function dropPlaceholderPassword(userId: string): Promise<void> {
  const database = getDatabase();
  if (!database) return;
  const [user] = await database.select({ passwordSetAt: authUsers.passwordSetAt }).from(authUsers).where(eq(authUsers.id, userId)).limit(1);
  if (!user || user.passwordSetAt) return;
  await database.delete(authAccounts).where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, "credential")));
}

/**
 * Notes that this person signed in, whichever way: password, Google, company sign-in, passkey or magic link. The team list
 * reads it for "last signed in" and to tell a person who has joined from one whose invite is still waiting. A password
 * sign-in that still owes a second factor makes a short-lived session that is deleted at once; it does not count.
 */
export async function recordSignInTime(userId: string, path: string): Promise<void> {
  const database = getDatabase();
  if (!database) return;
  await database.update(authUsers).set({ lastSignInAt: new Date() }).where(and(
    eq(authUsers.id, userId),
    path === "/sign-in/email" ? eq(authUsers.twoFactorEnabled, false) : undefined,
  ));
}

export type AuthAuditAction =
  | "staff.sign_in"
  | "staff.sign_in.failed"
  | "staff.sign_in.refused"
  | "staff.sso.sign_in"
  | "staff.sso.sign_in.failed"
  | "staff.second_factor.enabled"
  | "staff.second_factor.disabled"
  | "staff.second_factor.verified"
  | "staff.second_factor.failed"
  | "staff.second_factor.backup_codes_regenerated"
  | "staff.passkey.added"
  | "staff.passkey.removed"
  | "staff.device.removed"
  | "staff.devices.removed_all"
  | "staff.step_up.verified"
  | "staff.security_policy.changed";

/**
 * Writes one audit row in each business the person works in. `method` is a short word such as
 * "password" or "google"; never an address, code or user agent.
 */
export async function recordAuthEvent(
  userId: string,
  action: AuthAuditAction,
  outcome: "success" | "denied" | "failed",
  metadata: Record<string, string | number | boolean> = {},
): Promise<void> {
  try {
    for (const tenantId of await activeTenantIds(userId)) {
      await withTenant(tenantId, (transaction) => transaction.insert(auditEvents).values({
        tenantId,
        actorUserId: userId,
        actorType: "staff",
        action,
        outcome,
        metadata,
      }));
    }
  } catch (error: unknown) {
    logger().error({ errorName: error instanceof Error ? error.name : "unknown", action }, "Could not record a sign-in audit event");
  }
}

function formatWhen(now: Date): string {
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(now);
}

/**
 * Tells the person when a browser they have not used before signs in. The very first browser is
 * not announced: there is nothing to compare it with.
 */
export async function noteDeviceSignIn(user: { id: string; email: string; name: string }, userAgent: string | null): Promise<void> {
  const database = getDatabase();
  if (!database) return;
  const fingerprintHash = createHash("sha256").update(userAgent ?? "unknown").digest("hex");
  const existing = await database.select({ id: authKnownDevices.id, fingerprintHash: authKnownDevices.fingerprintHash }).from(authKnownDevices).where(eq(authKnownDevices.userId, user.id));
  const seen = existing.some((row) => row.fingerprintHash === fingerprintHash);
  await database
    .insert(authKnownDevices)
    .values({ userId: user.id, fingerprintHash })
    .onConflictDoUpdate({ target: [authKnownDevices.userId, authKnownDevices.fingerprintHash], set: { lastSeenAt: new Date() } });
  if (seen || existing.length === 0) return;
  const now = new Date();
  await sendNewDeviceNotice(user.email, { name: user.name, device: deviceLabel(userAgent), when: formatWhen(now) }, `device:${user.id}:${fingerprintHash}`);
}

/** Emails the person that one of their security settings changed. */
export async function noticeSecurityChange(user: { id: string; email: string; name: string }, change: string): Promise<void> {
  const now = new Date();
  await sendSecurityChangeNotice(user.email, { name: user.name, change, when: formatWhen(now) }, `change:${user.id}:${change}:${Math.floor(now.getTime() / 60_000)}`);
}

/** Ends every session of this person except the one named. */
export async function signOutOtherDevices(userId: string, keepToken: string | null): Promise<void> {
  const database = getDatabase();
  if (!database) return;
  await database.delete(authSessions).where(keepToken
    ? and(eq(authSessions.userId, userId), sql`${authSessions.token} <> ${keepToken}`)
    : eq(authSessions.userId, userId));
}
