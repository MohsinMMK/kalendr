import "server-only";

import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import { requireDatabase, withTenant, type KalendrTransaction } from "@/db/client";
import {
  auditEvents,
  authUsers,
  authVerifications,
  customRoles,
  locations,
  membershipLocations,
  memberships,
  practitioners,
  staffLoginInvites,
} from "@/db/schema";
import { auth } from "@/lib/auth";
import { cleanOverrides, type PermissionOverrides, type StaffRole } from "@/lib/permissions";

import { ApiError, getPostgresConstraint, getPostgresErrorCode } from "./api-error";
import { checkMembershipLocations } from "./membership-locations";
import type { StaffContext } from "./staff-context";
import { inviteLifetimeMs } from "./staff-invites";
import { alreadyOnTeamError, rethrowIfAlreadyMember } from "./staff-shared-login";

/**
 * One login, many businesses: consent. When a business invites an email that already has a login, nothing is granted yet.
 * The invite waits in `staff_login_invites` until the person signs in and accepts it (or declines, or it expires); only then
 * is a membership made, with the settings the business chose. Until then the business can't see them as active, can't use
 * their login (no sessions to end, no password links, no email change) and learns nothing about the login: its answers and
 * its team list look exactly like an invite to a brand-new email (the name and email it typed, "invite pending").
 *
 * An invite stands in for a membership on the team screen. Its id is the id the membership will have once accepted, and the
 * team actions (`loadMember` in staff-team.ts) accept it: editing access, switching it off, resending, cancelling, linking a
 * profile and changing its email all work on the invite row and never touch the login.
 */

export type LoginInvite = typeof staffLoginInvites.$inferSelect;

/** Extra facts a team action needs when its target is an invite rather than a membership. */
export interface LoginInviteFacts {
  practitionerId: string | null;
  locationIds: string[];
  expiresAt: Date;
}

/**
 * Looks up an email a business is inviting. Returns null when no login uses it (a new account is made, as before), or the
 * login's id when one does: the caller then makes an invite with `createLoginInvite`. Someone already on this team, as a
 * member or with an invite here, is the one plain 409 the business sees for either kind of email.
 */
export async function findLoginToInvite(transaction: KalendrTransaction, tenantId: string, rawEmail: string): Promise<string | null> {
  const email = rawEmail.trim().toLowerCase();
  const [user] = await transaction.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, email)).limit(1);
  const [invited] = await transaction
    .select({ id: staffLoginInvites.id })
    .from(staffLoginInvites)
    .where(and(
      eq(staffLoginInvites.tenantId, tenantId),
      user ? or(eq(staffLoginInvites.userId, user.id), eq(staffLoginInvites.email, email)) : eq(staffLoginInvites.email, email),
    ))
    .limit(1);
  if (invited) throw alreadyOnTeamError();
  if (!user) return null;
  const [here] = await transaction
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, user.id)))
    .limit(1);
  if (here) throw alreadyOnTeamError();
  return user.id;
}

/**
 * Records an invite for an existing login. `locationIds` are checked by the same rules as a membership's; the caller has
 * already applied "a limited manager makes limited staff". Writes no audit row of its own: the caller writes the same one it
 * writes for a new email, so the audit trail does not tell the two apart either.
 */
export async function createLoginInvite(
  transaction: KalendrTransaction,
  context: StaffContext,
  input: {
    userId: string;
    email: string;
    name: string;
    role: StaffRole;
    jobTitle?: string | null;
    permissionOverrides?: PermissionOverrides;
    locationIds: readonly string[];
    practitionerId?: string | null;
  },
): Promise<LoginInvite> {
  const locationIds = input.locationIds.length > 0 ? await checkMembershipLocations(transaction, context, input.role, input.locationIds) : [];
  const now = new Date();
  try {
    const [row] = await transaction.insert(staffLoginInvites).values({
      tenantId: context.tenantId,
      userId: input.userId,
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      role: input.role,
      jobTitle: input.jobTitle ?? null,
      permissionOverrides: input.permissionOverrides ?? {},
      locationIds,
      practitionerId: input.practitionerId ?? null,
      invitedAt: now,
      expiresAt: new Date(now.getTime() + inviteLifetimeMs),
    }).returning();
    if (!row) throw new Error("Invite insert returned no row");
    return row;
  } catch (error: unknown) {
    if (getPostgresErrorCode(error) === "23505" && getPostgresConstraint(error) === "staff_login_invites_tenant_user_uq") throw alreadyOnTeamError();
    throw error;
  }
}

/** The invite behind a team-row id, or null when the id is a membership (or nothing). */
export async function loadLoginInvite(transaction: KalendrTransaction, tenantId: string, inviteId: string, options: { lock?: boolean } = {}): Promise<LoginInvite | null> {
  const query = transaction.select().from(staffLoginInvites)
    .where(and(eq(staffLoginInvites.tenantId, tenantId), eq(staffLoginInvites.id, inviteId)))
    .limit(1);
  const [row] = options.lock ? await query.for("update") : await query;
  return row ?? null;
}

/** The custom role's permission keys for an invite, or null for a built-in role (or a custom role that has since gone). */
export async function inviteCustomPermissions(transaction: KalendrTransaction, invite: LoginInvite): Promise<string[] | null> {
  if (!invite.customRoleId) return null;
  const [role] = await transaction.select({ permissions: customRoles.permissions }).from(customRoles)
    .where(and(eq(customRoles.tenantId, invite.tenantId), eq(customRoles.id, invite.customRoleId)))
    .limit(1);
  return role?.permissions ?? null;
}

/** The invite as the team actions see a member: the typed name and email, never anything read from the login. */
export async function inviteAsMember(transaction: KalendrTransaction, invite: LoginInvite) {
  const customPermissions = await inviteCustomPermissions(transaction, invite);
  return {
    id: invite.id,
    // The stand-in the business sees, which matches no login, so nothing done to "the member" can reach the login behind it.
    userId: invite.standInUserId,
    role: invite.role,
    customRoleId: customPermissions ? invite.customRoleId : null,
    customPermissions,
    isActive: invite.isActive,
    jobTitle: invite.jobTitle,
    permissionOverrides: cleanOverrides(invite.role, invite.permissionOverrides, customPermissions),
    name: invite.name,
    email: invite.email,
    passwordSetAt: null,
    lastSignInAt: null,
    loginInvite: { practitionerId: invite.practitionerId, locationIds: [...invite.locationIds].sort(), expiresAt: invite.expiresAt } satisfies LoginInviteFacts,
  };
}

/** Starts the invite's clock again (a resend). A person who declined sees it again. */
export async function renewLoginInvite(transaction: KalendrTransaction, invite: LoginInvite): Promise<Date> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + inviteLifetimeMs);
  await transaction.update(staffLoginInvites).set({ invitedAt: now, expiresAt, declinedAt: null, updatedAt: now })
    .where(and(eq(staffLoginInvites.tenantId, invite.tenantId), eq(staffLoginInvites.id, invite.id)));
  return expiresAt;
}

/** The answer when the invitee accepted while the business was changing or cancelling the invite. */
export function inviteAcceptedError(): ApiError {
  return new ApiError(409, "invite_accepted", "They just joined. Refresh and try again.");
}

/**
 * Removes an invite and its link. Nothing else is touched: the login never belonged to this business. Returns false when
 * the invite was already gone (the invitee accepted first), and then nothing else is deleted.
 */
export async function deleteLoginInvite(transaction: KalendrTransaction, invite: Pick<LoginInvite, "id" | "tenantId">): Promise<boolean> {
  const removed = await transaction.delete(staffLoginInvites)
    .where(and(eq(staffLoginInvites.tenantId, invite.tenantId), eq(staffLoginInvites.id, invite.id)))
    .returning({ id: staffLoginInvites.id });
  if (removed.length === 0) return false;
  await transaction.delete(authVerifications).where(eq(authVerifications.value, invite.id));
  return true;
}

/**
 * Turns an invite into the membership it describes, for `userId`: the same id, role, switches, title and location limit. A
 * custom role that has since been deleted falls back to its base role. Locations that have since closed are dropped; if every
 * one is gone the invite can't be honoured as meant (it would widen to every location), so it is refused. The linked profile
 * is linked to the login when it still has none. Runs inside the business's transaction; the caller writes the audit row.
 */
export async function materializeInvite(transaction: KalendrTransaction, invite: LoginInvite, userId: string): Promise<{ membershipId: string }> {
  const customPermissions = await inviteCustomPermissions(transaction, invite);
  const customRoleId = customPermissions ? invite.customRoleId : null;
  try {
    await transaction.insert(memberships).values({
      id: invite.id,
      tenantId: invite.tenantId,
      userId,
      role: invite.role,
      customRoleId,
      permissionOverrides: cleanOverrides(invite.role, invite.permissionOverrides, customPermissions),
      jobTitle: invite.jobTitle,
      isActive: invite.isActive,
      invitedAt: invite.invitedAt,
    });
  } catch (error: unknown) {
    rethrowIfAlreadyMember(error);
  }
  if (invite.locationIds.length > 0) {
    const open = await transaction.select({ id: locations.id }).from(locations)
      .where(and(eq(locations.tenantId, invite.tenantId), inArray(locations.id, invite.locationIds), eq(locations.isActive, true)));
    if (open.length === 0) {
      throw new ApiError(409, "invite_outdated", "The locations this invite was for have closed. Ask the business to send a new invite.");
    }
    await transaction.insert(membershipLocations).values(open.map((row) => ({ tenantId: invite.tenantId, membershipId: invite.id, locationId: row.id })));
  }
  if (invite.practitionerId) {
    await transaction.update(practitioners).set({ authUserId: userId, updatedAt: new Date() })
      .where(and(eq(practitioners.tenantId, invite.tenantId), eq(practitioners.id, invite.practitionerId), isNull(practitioners.authUserId)));
  }
  await deleteLoginInvite(transaction, invite);
  return { membershipId: invite.id };
}

/** An invite as the invited person sees it: which business, and the role offered. */
export interface MyInvite {
  id: string;
  businessName: string;
  role: StaffRole;
  invitedAt: string;
}

interface MyInviteRow extends Record<string, unknown> {
  invite_id: string;
  tenant_id: string;
  slug: string;
  name: string;
  role: StaffRole;
  invited_at: Date | string;
}

async function myInviteRows(userId: string): Promise<MyInviteRow[]> {
  return requireDatabase().execute<MyInviteRow>(sql`select * from kalendr_staff_invites_for_user(${userId})`);
}

/** The invites waiting for this login's answer, newest first. Empty when there is no database (preview). */
export async function listMyInvites(userId: string): Promise<MyInvite[]> {
  try {
    const rows = await myInviteRows(userId);
    return rows.map((row) => ({ id: row.invite_id, businessName: row.name, role: row.role, invitedAt: new Date(row.invited_at).toISOString() }));
  } catch {
    // The screens that show invites must never fail because of them.
    return [];
  }
}

function inviteGone(): ApiError {
  return new ApiError(404, "invite_not_found", "This invite is no longer open. It may have expired or been cancelled.");
}

/** The open invite `inviteId` for this login, locked, inside its business's transaction. */
async function withMyInvite<T>(userId: string, inviteId: string, operation: (transaction: KalendrTransaction, invite: LoginInvite, business: { slug: string; name: string }) => Promise<T>): Promise<T> {
  const mine = (await myInviteRows(userId)).find((row) => row.invite_id === inviteId);
  if (!mine) throw inviteGone();
  return withTenant(mine.tenant_id, async (transaction) => {
    const [invite] = await transaction.select().from(staffLoginInvites)
      .where(and(
        eq(staffLoginInvites.tenantId, mine.tenant_id),
        eq(staffLoginInvites.id, inviteId),
        eq(staffLoginInvites.userId, userId),
        eq(staffLoginInvites.isActive, true),
        isNull(staffLoginInvites.declinedAt),
        gt(staffLoginInvites.expiresAt, new Date()),
      ))
      .limit(1)
      .for("update");
    if (!invite) throw inviteGone();
    return operation(transaction, invite, { slug: mine.slug, name: mine.name });
  });
}

/**
 * The person says yes: the membership is made and the business sees them as an ordinary member from now on. Returns the
 * business's slug so the page can open it.
 */
export async function acceptLoginInvite(userId: string, inviteId: string): Promise<{ slug: string; name: string }> {
  return withMyInvite(userId, inviteId, async (transaction, invite, business) => {
    const { membershipId } = await materializeInvite(transaction, invite, userId);
    await transaction.insert(auditEvents).values({
      tenantId: invite.tenantId,
      actorUserId: userId,
      actorType: "staff",
      action: "staff.member.invite_accepted",
      outcome: "success",
      metadata: { membershipId, role: invite.role },
    });
    return business;
  });
}

/**
 * The person says no. The invite stops showing for them and its link stops working. The business is not told (no audit row
 * there, no change on its team list): it keeps seeing "invite pending" until the invite expires, exactly as for a new email
 * nobody answered, so declining does not reveal that the email has a login. A resend asks again.
 */
export async function declineLoginInvite(userId: string, inviteId: string): Promise<{ declined: true }> {
  return withMyInvite(userId, inviteId, async (transaction, invite) => {
    const now = new Date();
    await transaction.update(staffLoginInvites).set({ declinedAt: now, updatedAt: now })
      .where(and(eq(staffLoginInvites.tenantId, invite.tenantId), eq(staffLoginInvites.id, invite.id)));
    await transaction.delete(authVerifications).where(eq(authVerifications.value, invite.id));
    return { declined: true as const };
  });
}

/** The business an invite link belongs to, for the page the link opens. Null for an unknown, used or expired link. */
export async function findLoginInviteLink(token: string): Promise<{ businessName: string } | null> {
  const context = await auth.$context;
  const verification = await context.internalAdapter.findVerificationValue(`staff-invite:${token}`);
  if (!verification || new Date(verification.expiresAt) <= new Date()) return null;
  const [row] = await requireDatabase().execute<{ name: string }>(sql`select name from kalendr_staff_invite_business(${verification.value})`);
  return row ? { businessName: row.name } : null;
}
