import "server-only";

import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase, withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents, authAccounts, authUsers, authVerifications, verifiedDomains } from "@/db/schema";
import { secondFactorErrorCodes, stepUpIsFresh } from "@/lib/security-policy";
import { emailAuditActions, staffEmailSchema } from "@/lib/staff-email";

import { ApiError } from "./api-error";
import { assertEmailAvailable } from "./staff-credentials";
import { queueEmailNotice } from "./staff-email-notice";
import { getUserSecurity, signOutOtherDevices } from "./staff-security";

/**
 * A person changing their own sign-in email, on top of Better Auth's `user.changeEmail`. Better Auth sends a one-time link to the
 * NEW address and moves the email only when that link is opened; this file adds what it does not do: a fresh second-factor check
 * before the request, a clear "already used" answer, a heads-up to the OLD address, the audit rows, and signing the other
 * devices out once the change lands. `src/lib/auth.ts` calls these from its hooks, so the web route and a direct call to
 * `/api/auth/change-email` are held to the same rules. This file must not import `auth` (the hooks live in it).
 */

/** The tenants this person works in, through the same definer function the staff context uses. */
async function tenantIdsOf(userId: string): Promise<string[]> {
  const database = getDatabase();
  if (!database) return [];
  const rows = await database.execute<{ tenant_id: string }>(sql`select tenant_id from kalendr_resolve_staff_access(${userId})`);
  return rows.map((row) => row.tenant_id);
}

const domainOf = (email: string): string => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/**
 * Company sign-in (feature 53) is decided by the email's domain, so an email change could move a person into or out of it.
 * Until that is designed on purpose, a change from or to a domain that makes everyone use company sign-in is refused, for the
 * person themselves and for a manager, with the same words.
 */
export async function assertNoCompanySignInConflict(transaction: KalendrTransaction, tenantId: string, ...emails: string[]): Promise<void> {
  for (const email of emails) {
    const [domain] = await transaction.select({ id: verifiedDomains.id }).from(verifiedDomains)
      .where(and(eq(verifiedDomains.tenantId, tenantId), eq(verifiedDomains.domain, domainOf(email)), isNotNull(verifiedDomains.verifiedAt), eq(verifiedDomains.requireSso, true)))
      .limit(1);
    if (domain) throw new ApiError(409, "company_sign_in_email", "This email is tied to company sign-in, so it can't be changed here. Ask your company's administrator.");
  }
}

export interface OwnEmailChangeSession {
  userId: string;
  secondFactorAt: Date | null;
}

/**
 * Throws before anything is sent. A person with an authenticator app or a passkey must have used it in the last few minutes;
 * a person with neither is not asked for one. The new address must be free (the one helper, `assertEmailAvailable`).
 */
export async function assertOwnEmailChangeAllowed(session: OwnEmailChangeSession, rawNewEmail: string, now: Date = new Date()): Promise<string> {
  const parsed = staffEmailSchema.safeParse(rawNewEmail);
  if (!parsed.success) throw new ApiError(400, "invalid_email", "Enter a full email address, like name@example.com.", { newEmail: ["Enter a full email address, like name@example.com."] });
  const security = await getUserSecurity(session.userId);
  if ((security.twoFactorEnabled || security.passkeyCount > 0) && !stepUpIsFresh(session.secondFactorAt, now)) {
    throw new ApiError(403, secondFactorErrorCodes.stepUp, "Enter a code from your authenticator app to continue.");
  }
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "Sign-in is not available right now.");
  await assertEmailAvailable(database, parsed.data, session.userId);
  const [person] = await database.select({ email: authUsers.email }).from(authUsers).where(eq(authUsers.id, session.userId)).limit(1);
  for (const tenantId of await tenantIdsOf(session.userId)) {
    await withTenant(tenantId, (transaction) => assertNoCompanySignInConflict(transaction, tenantId, parsed.data, ...(person ? [person.email] : [])));
  }
  return parsed.data;
}

/** Writes one audit row in each business the person works in. The metadata is empty on purpose: it never holds an address. */
async function auditEverywhere(userId: string, action: string): Promise<string[]> {
  const tenantIds = await tenantIdsOf(userId);
  for (const tenantId of tenantIds) {
    await withTenant(tenantId, (transaction) => transaction.insert(auditEvents).values({ tenantId, actorUserId: userId, actorType: "staff", action, outcome: "success", metadata: {} }));
  }
  return tenantIds;
}

/** The new address is on its way a link: tell the OLD address that someone asked, while nothing has changed yet. */
export async function afterOwnEmailRequested(user: { id: string; email: string; name: string }): Promise<void> {
  const tenantIds = await auditEverywhere(user.id, emailAuditActions.ownRequested);
  const tenantId = tenantIds[0];
  if (!tenantId) return;
  await withTenant(tenantId, (transaction) => queueEmailNotice(transaction, tenantId, { kind: "requested", to: user.email, name: user.name, at: new Date() }));
}

const changeTokenSchema = z.object({
  email: z.string(),
  updateTo: z.string(),
  requestType: z.literal("change-email-verification"),
  userId: z.string(),
});

/**
 * What a confirmation link says it will do, read without checking its signature: Better Auth checks the signature itself, and
 * this is only used afterwards to tell whether that check led to a change. Null for any other link (a plain verification).
 */
export function readEmailChangeToken(token: string | undefined): z.infer<typeof changeTokenSchema> | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const parsed = changeTokenSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface PendingEmailChange {
  change: NonNullable<ReturnType<typeof readEmailChangeToken>>;
  /** The person's email when the link was opened. A replayed link finds the new one already in place and does nothing. */
  emailBefore: string | null;
}

/** Called before the link is handled. Null when it is not an email-change link. */
export async function beforeOwnEmailConfirmed(token: string | undefined): Promise<PendingEmailChange | null> {
  const change = readEmailChangeToken(token);
  const database = getDatabase();
  if (!change || !database) return null;
  const [user] = await database.select({ email: authUsers.email }).from(authUsers).where(eq(authUsers.id, change.userId)).limit(1);
  return { change, emailBefore: user?.email ?? null };
}

/**
 * Once the email is the new one, anything that could still open the account through the OLD address stops working: reset and
 * invite links already sent (stored against the user id). The change link itself is a signed token, not a stored row, so it is
 * already used up and nothing the flow still needs is deleted. Google and Microsoft sign-ins tied to the old address are
 * unlinked too, but only for someone who has a password of their own, so a person who only ever signed in with Google is not
 * locked out of their account.
 */
async function closeOldWaysIn(database: NonNullable<ReturnType<typeof getDatabase>>, userId: string): Promise<void> {
  await database.delete(authVerifications).where(eq(authVerifications.value, userId));
  const [user] = await database.select({ passwordSetAt: authUsers.passwordSetAt }).from(authUsers).where(eq(authUsers.id, userId)).limit(1);
  if (!user?.passwordSetAt) return;
  const [credential] = await database.select({ id: authAccounts.id }).from(authAccounts)
    .where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, "credential"), isNotNull(authAccounts.password)))
    .limit(1);
  if (!credential) return;
  await database.delete(authAccounts).where(and(eq(authAccounts.userId, userId), ne(authAccounts.providerId, "credential")));
}

/**
 * Called after the link was handled. Only when the person's email really became the new one (and was not already) does it tell
 * the old address, sign every other device out and write the audit rows, so a failed or replayed link does nothing.
 */
export async function afterOwnEmailConfirmed(pending: PendingEmailChange, keepSessionToken: string | null): Promise<void> {
  const { change } = pending;
  const database = getDatabase();
  if (!database) return;
  const newEmail = change.updateTo.toLowerCase();
  if (pending.emailBefore === newEmail) return;
  const [user] = await database.select({ email: authUsers.email, name: authUsers.name }).from(authUsers).where(eq(authUsers.id, change.userId)).limit(1);
  if (!user || user.email !== newEmail) return;
  await signOutOtherDevices(change.userId, keepSessionToken);
  await closeOldWaysIn(database, change.userId);
  const tenantIds = await auditEverywhere(change.userId, emailAuditActions.ownChanged);
  const tenantId = tenantIds[0];
  if (!tenantId) return;
  await withTenant(tenantId, (transaction) => queueEmailNotice(transaction, tenantId, { kind: "changed", to: change.email, name: user.name, at: new Date() }));
}
