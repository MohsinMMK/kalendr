import "server-only";

import { sql } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";

import { ApiError, getPostgresConstraint, getPostgresErrorCode } from "./api-error";

/**
 * One login, many businesses. A person who works in two places keeps one email, one password and one second factor, and
 * each business only ever holds a membership for them: a role and a few settings of its own.
 *
 * What a business may do to a shared login is deliberately small. It can give them a role, take that role away and switch it
 * off, and it can see their name and email. It can NOT send them a password link, change their email, or see their other
 * businesses (only that they work elsewhere). Those belong to the person, who is the one place all their businesses meet.
 *
 * A business never adds an existing login by itself: it sends an invite the person accepts or declines after signing in
 * (`staff-login-invites.ts`).
 */

export const sharedLoginMessage = "This person also works in another business, so their sign-in can't be changed from here. They can change it from their own profile.";

/** Whether the person has an active membership in any business other than this one. */
export async function worksElsewhere(transaction: KalendrTransaction, tenantId: string, userId: string): Promise<boolean> {
  const rows = await transaction.execute<{ tenant_id: string }>(sql`select tenant_id from kalendr_resolve_staff_access(${userId})`);
  return rows.some((row) => row.tenant_id !== tenantId);
}

/**
 * Whether another business holds this login in any way: a membership there (switched on or off, in a business that is active or
 * suspended) or a platform operator account. Unlike `worksElsewhere`, which is for what the team screen shows, this is the
 * guard for anything that would change or end the login for everyone, so a person switched off elsewhere still counts.
 */
export async function loginHeldElsewhere(transaction: KalendrTransaction, tenantId: string, userId: string): Promise<boolean> {
  const [row] = await transaction.execute<{ held: boolean }>(sql`select kalendr_login_held_elsewhere(${userId}, ${tenantId}) as held`);
  return row?.held === true;
}

/** Refuses an action that would change a shared login for every business it belongs to. */
export async function assertLoginNotShared(transaction: KalendrTransaction, tenantId: string, userId: string): Promise<void> {
  if (await loginHeldElsewhere(transaction, tenantId, userId)) throw new ApiError(409, "shared_login", sharedLoginMessage);
}

export function alreadyOnTeamError(): ApiError {
  return new ApiError(409, "email_taken", "This person is already on your team.", { email: ["This person is already on your team."] });
}

/** Turns the database's "already a member" (two invites at once) into the same clear answer. */
export function rethrowIfAlreadyMember(error: unknown): never {
  if (getPostgresErrorCode(error) === "23505" && getPostgresConstraint(error) === "memberships_tenant_user_uq") throw alreadyOnTeamError();
  throw error;
}
