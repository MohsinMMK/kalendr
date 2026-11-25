import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents, authPasskeys, authUsers, authVerifications, memberships, practitioners, staffLoginInvites } from "@/db/schema";
import { isInvitePending } from "@/lib/staff-invite-state";

import { ApiError } from "./api-error";
import { closePractitionerCalendar } from "./scim/users";
import { requirePermission, requireRecentStepUp, type StaffContext } from "./staff-context";
import { setMembershipLocations } from "./membership-locations";
import { revokeAllSessions } from "./staff-invites";
import { deleteLoginInvite, inviteAcceptedError } from "./staff-login-invites";
import { loginHeldElsewhere } from "./staff-shared-login";
import { loadMember, requireActionable, wordsIn, type MemberTarget, type TenantTransaction } from "./staff-team";

/** The bookable profile linked to this team row: by its login, or the one an invite (not accepted yet) will link. */
async function linkedProfileId(transaction: TenantTransaction, tenantId: string, target: MemberTarget, options: { lock?: boolean } = {}): Promise<string | null> {
  if (target.loginInvite) return target.loginInvite.practitionerId;
  const query = transaction
    .select({ id: practitioners.id })
    .from(practitioners)
    .where(and(eq(practitioners.tenantId, tenantId), eq(practitioners.authUserId, target.userId)))
    .limit(1);
  const [profile] = options.lock ? await query.for("update") : await query;
  return profile?.id ?? null;
}

/**
 * What an owner or manager does to a person who is already on the team, beyond editing their access: remove them, cancel
 * an invite that was never used, sign them out of every device, hand over the business, and link or unlink their login
 * and their bookable profile. Each one asks for a recent second factor, needs the manage-the-team permission, goes through
 * the same guards as editing a person, and writes one audit event (ids and counts only, never names or addresses).
 */

function prepare(context: StaffContext): void {
  requirePermission(context, "team.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Team changes are unavailable in preview mode.");
  requireRecentStepUp(context);
}

async function audit(transaction: TenantTransaction, context: StaffContext, action: string, metadata: Record<string, string | number | boolean>): Promise<void> {
  await transaction.insert(auditEvents).values({
    tenantId: context.tenantId,
    actorUserId: context.userId,
    actorType: "staff",
    action,
    outcome: "success",
    metadata,
  });
}

export interface RemovedMember {
  membershipId: string;
  /** Bookings still ahead for their profile; they are on the reassign list, nothing is cancelled. */
  futureBookings: number;
  /** Their login was deleted too, so the same email can be invited again. */
  loginDeleted: boolean;
}

/**
 * Takes a person off the team for good. Their membership goes, every session ends, and a profile they had stays with its
 * history but loses its login, is switched off, and closes its calendar so future bookings wait on the reassign list. Their
 * login is deleted when they belong to no other business, which frees their email for a fresh invite.
 *
 * `cancel_invite` is the same removal for someone who never joined, and says so in the audit trail. Cancelling an invite
 * removes the member rather than leaving a "never joined" row, because a live membership is enough to sign in with Google
 * or a magic link; the only safe way to stop an invite is to take the access away with it.
 *
 * An invite to an existing login (`staff-login-invites.ts`) is removed the same way and reads the same in the answer and the
 * audit trail: the invite row goes, the login is never touched (it was never this business's to delete or sign out).
 */
async function removeMember(context: StaffContext, membershipId: string, kind: "remove" | "cancel_invite"): Promise<RemovedMember> {
  prepare(context);
  const outcome = await withTenant(context.tenantId, async (transaction) => {
    const target = await loadMember(transaction, context.tenantId, membershipId, { lock: true });
    await requireActionable(transaction, context, target);
    if (kind === "cancel_invite" && !isInvitePending(target)) {
      throw new ApiError(409, "invite_accepted", "They have already joined, so there is no invite to cancel. Remove them from the team instead.");
    }
    const profileId = await linkedProfileId(transaction, context.tenantId, target);
    let futureBookings = 0;
    if (profileId) {
      futureBookings = (await closePractitionerCalendar(transaction, context.tenantId, profileId)).futureBookings;
      await transaction.update(practitioners).set({ authUserId: null, isActive: false, updatedAt: new Date() })
        .where(and(eq(practitioners.tenantId, context.tenantId), eq(practitioners.id, profileId)));
    }
    const auditKind = kind === "remove" ? "staff.member.removed" : "staff.member.invite_cancelled";
    if (target.loginInvite) {
      if (!(await deleteLoginInvite(transaction, { id: target.id, tenantId: context.tenantId }))) throw inviteAcceptedError();
      // Reported as a new person's cancelled invite is: their placeholder login is gone, so the email can be invited again.
      await audit(transaction, context, auditKind, { membershipId: target.id, role: target.role, hadProfile: Boolean(profileId), futureBookings, loginDeleted: true });
      return { userId: null, futureBookings, loginDeleted: true, heldElsewhere: false };
    }
    await transaction.delete(memberships).where(and(eq(memberships.tenantId, context.tenantId), eq(memberships.id, target.id)));
    // Sessions and links belong to the login, which another business may still rely on: leave them alone then. Access here
    // ends at once either way, because getStaffContext re-reads the memberships on every request.
    const heldElsewhere = await loginHeldElsewhere(transaction, context.tenantId, target.userId);
    // Any invite or reset link this person still holds stops working with their access (when this was their only business).
    if (!heldElsewhere) await transaction.delete(authVerifications).where(eq(authVerifications.value, target.userId));
    const [freed] = await transaction.execute<{ deleted: boolean }>(sql`select kalendr_delete_orphan_user(${target.userId}) as deleted`);
    const loginDeleted = freed?.deleted === true;
    await audit(transaction, context, auditKind, {
      membershipId: target.id,
      role: target.role,
      hadProfile: Boolean(profileId),
      futureBookings,
      loginDeleted,
    });
    return { userId: target.userId, futureBookings, loginDeleted, heldElsewhere };
  });
  // A deleted login took its sessions with it. A login another business holds keeps its sessions, so the person stays signed in there.
  if (outcome.userId && !outcome.loginDeleted && !outcome.heldElsewhere) await revokeAllSessions(outcome.userId);
  return { membershipId, futureBookings: outcome.futureBookings, loginDeleted: outcome.loginDeleted };
}

export function removeStaffMember(context: StaffContext, membershipId: string): Promise<RemovedMember> {
  return removeMember(context, membershipId, "remove");
}

export function cancelStaffInvite(context: StaffContext, membershipId: string): Promise<RemovedMember> {
  return removeMember(context, membershipId, "cancel_invite");
}

/** Ends every sign-in this person has, on every device. They can sign in again unless they are also switched off. */
export async function signOutStaffMember(context: StaffContext, membershipId: string): Promise<{ membershipId: string }> {
  prepare(context);
  const userId = await withTenant(context.tenantId, async (transaction) => {
    const target = await loadMember(transaction, context.tenantId, membershipId, { lock: true });
    await requireActionable(transaction, context, target, { lastOwner: false });
    // An invite has no sessions here to end; it answers as a new person's would.
    if (target.loginInvite) {
      await audit(transaction, context, "staff.member.signed_out", { membershipId: target.id, role: target.role });
      return null;
    }
    // Sessions are shared by every business the login belongs to, so this would sign the person out of the others too.
    if (await loginHeldElsewhere(transaction, context.tenantId, target.userId)) {
      throw new ApiError(409, "shared_login", "This person also works in another business, so signing them out here would sign them out there too. Switch them off here instead, which ends their access to your business at once.");
    }
    await audit(transaction, context, "staff.member.signed_out", { membershipId: target.id, role: target.role });
    return target.userId;
  });
  if (userId) await revokeAllSessions(userId);
  return { membershipId };
}

/**
 * Hands the business to another active person: they become the owner and you become an admin, in one transaction. The new
 * owner must already use a second factor, because an owner without one would lock the business's strictest actions behind a
 * step nobody can pass. Promoting comes first so the business never has zero owners, which the database would refuse.
 */
export async function transferOwnership(context: StaffContext, targetMembershipId: string): Promise<{ membershipId: string }> {
  prepare(context);
  if (context.role !== "owner" || !context.userId) {
    throw new ApiError(403, "owner_only", "Only the owner can hand over the business.");
  }
  const userId = context.userId;
  await withTenant(context.tenantId, async (transaction) => {
    const t = await wordsIn(transaction, context.tenantId);
    const [mine] = await transaction
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, context.tenantId), eq(memberships.userId, userId)))
      .limit(1);
    if (!mine) throw new ApiError(403, "owner_only", `Only the ${t.business} owner can hand it over.`);
    if (mine.id === targetMembershipId) throw new ApiError(400, "own_access", "You already own this " + t.business + ".");
    // Both rows are locked in id order, so two transfers at once cannot cross, then read again as they are now.
    const ids = [mine.id, targetMembershipId].sort();
    const locked = await transaction
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, context.tenantId), inArray(memberships.id, ids)))
      .orderBy(memberships.id)
      .for("update");
    const me = await loadMember(transaction, context.tenantId, mine.id, { lock: true });
    if (me.role !== "owner" || !me.isActive) throw new ApiError(403, "owner_only", `Only the ${t.business} owner can hand it over.`);
    // An invite not accepted yet loads too (the team list shows it as a pending person); it is refused below as a new person
    // who has not set up a second factor is.
    const target = await loadMember(transaction, context.tenantId, targetMembershipId, { lock: true });
    if (locked.length !== 2 && !target.loginInvite) throw new ApiError(404, "member_not_found", "Staff member not found.");
    if (target.role === "owner") throw new ApiError(409, "already_owner", "They already own this " + t.business + ".");
    if (!target.isActive) throw new ApiError(400, "member_inactive", "Reactivate this person before making them the owner.");
    const [security] = await transaction
      .select({ twoFactorEnabled: authUsers.twoFactorEnabled, passkeys: sql<number>`(select count(*)::int from ${authPasskeys} where ${authPasskeys.userId} = ${authUsers.id})` })
      .from(authUsers)
      .where(eq(authUsers.id, target.userId))
      .limit(1);
    if (!security || (!security.twoFactorEnabled && security.passkeys === 0)) {
      throw new ApiError(400, "second_factor_required", "They need to set up an authenticator app or a passkey in Profile, Security before they can become the owner.");
    }
    const [mineRow] = await transaction.select({ breakGlass: memberships.breakGlass }).from(memberships).where(eq(memberships.id, me.id)).limit(1);
    const now = new Date();
    await transaction.update(memberships).set({ role: "owner", customRoleId: null, permissionOverrides: {}, updatedAt: now }).where(eq(memberships.id, target.id));
    await transaction.update(memberships).set({ role: "admin", customRoleId: null, permissionOverrides: {}, breakGlass: false, updatedAt: now }).where(eq(memberships.id, me.id));
    // An owner always works at every location, so the new owner's limit (if any) goes.
    await setMembershipLocations(transaction, context, { id: target.id, role: "owner" }, []);
    // The owner who may sign in without company sign-in stays the owner.
    if (mineRow?.breakGlass) await transaction.update(memberships).set({ breakGlass: true }).where(eq(memberships.id, target.id));
    await audit(transaction, context, "staff.ownership.transferred", { fromMembershipId: me.id, toMembershipId: target.id, previousRole: target.role });
  });
  return { membershipId: targetMembershipId };
}

/** Links a team login that has no profile to a bookable profile that has no login. */
export async function linkMemberToProfile(context: StaffContext, membershipId: string, practitionerId: string): Promise<{ membershipId: string; practitionerId: string }> {
  prepare(context);
  await withTenant(context.tenantId, async (transaction) => {
    const t = await wordsIn(transaction, context.tenantId);
    const target = await loadMember(transaction, context.tenantId, membershipId, { lock: true });
    await requireActionable(transaction, context, target, { lastOwner: false });
    if (!target.isActive) throw new ApiError(400, "member_inactive", "Reactivate this person before linking their profile.");
    const already = await linkedProfileId(transaction, context.tenantId, target);
    if (already) throw new ApiError(409, "already_linked", `This person is already linked to ${t.aPractitioner} profile.`);
    const [profile] = await transaction
      .select({ id: practitioners.id, authUserId: practitioners.authUserId, isActive: practitioners.isActive })
      .from(practitioners)
      .where(and(eq(practitioners.tenantId, context.tenantId), eq(practitioners.id, practitionerId)))
      .limit(1)
      .for("update");
    if (!profile) throw new ApiError(404, "practitioner_not_found", `This ${t.practitioner} no longer exists.`);
    // A profile an invite will link (once accepted) is taken as well.
    const [invited] = await transaction.select({ id: staffLoginInvites.id }).from(staffLoginInvites)
      .where(and(eq(staffLoginInvites.tenantId, context.tenantId), eq(staffLoginInvites.practitionerId, practitionerId))).limit(1);
    if (profile.authUserId || invited) throw new ApiError(409, "already_has_login", `This ${t.practitioner} already has a login.`);
    if (!profile.isActive) throw new ApiError(400, "practitioner_inactive", `Reactivate this ${t.practitioner} before linking a login.`);
    if (target.loginInvite) {
      await transaction.update(staffLoginInvites).set({ practitionerId, updatedAt: new Date() })
        .where(and(eq(staffLoginInvites.tenantId, context.tenantId), eq(staffLoginInvites.id, target.id)));
    } else {
      await transaction.update(practitioners).set({ authUserId: target.userId, updatedAt: new Date() })
        .where(and(eq(practitioners.tenantId, context.tenantId), eq(practitioners.id, practitionerId)));
    }
    await audit(transaction, context, "staff.member.profile_linked", { membershipId: target.id, practitionerId, role: target.role });
  });
  return { membershipId, practitionerId };
}

/** Separates a login from its profile. The profile, its calendar and its history stay; the person keeps signing in. */
export async function unlinkMemberFromProfile(context: StaffContext, membershipId: string): Promise<{ membershipId: string }> {
  prepare(context);
  await withTenant(context.tenantId, async (transaction) => {
    const t = await wordsIn(transaction, context.tenantId);
    const target = await loadMember(transaction, context.tenantId, membershipId, { lock: true });
    await requireActionable(transaction, context, target, { lastOwner: false });
    const profileId = await linkedProfileId(transaction, context.tenantId, target, { lock: true });
    if (!profileId) throw new ApiError(404, "not_linked", `This person isn't linked to ${t.aPractitioner} profile.`);
    if (target.role === "practitioner") {
      throw new ApiError(409, "role_needs_profile", `Change their role first. A ${t.practitioner} login needs its profile to sign in.`);
    }
    if (target.loginInvite) {
      await transaction.update(staffLoginInvites).set({ practitionerId: null, updatedAt: new Date() })
        .where(and(eq(staffLoginInvites.tenantId, context.tenantId), eq(staffLoginInvites.id, target.id)));
    } else {
      await transaction.update(practitioners).set({ authUserId: null, updatedAt: new Date() })
        .where(and(eq(practitioners.tenantId, context.tenantId), eq(practitioners.id, profileId)));
    }
    await audit(transaction, context, "staff.member.profile_unlinked", { membershipId: target.id, practitionerId: profileId, role: target.role });
  });
  return { membershipId };
}
