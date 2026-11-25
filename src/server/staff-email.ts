import "server-only";

import { eq, sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents, authAccounts, authSessions, authUsers, authVerifications, memberships } from "@/db/schema";
import { emailAuditActions, type StaffMemberEmailChangeInput, type StaffMemberEmailChangeResult } from "@/lib/staff-email";

import { ApiError } from "./api-error";
import { assertEmailAvailable, generateStaffPassword, insertCredentialUser, rethrowIfEmailTaken } from "./staff-credentials";
import { assertNoCompanySignInConflict } from "./staff-email-change";
import { queueEmailNotice } from "./staff-email-notice";
import { requirePermission, requireRecentStepUp, type StaffContext } from "./staff-context";
import { sendStaffInvite } from "./staff-invites";
import { loadLoginInvite, materializeInvite } from "./staff-login-invites";
import { loginHeldElsewhere } from "./staff-shared-login";
import { loadMemberForEmailChange, requireLocationReach } from "./staff-team";

/**
 * An owner or admin changes a teammate's sign-in email (the person's own change is `staff-email-change.ts`).
 *
 * Who may: someone with `team.manage` who has passed a second-factor check in the last 10 minutes; never on themselves (they use
 * their profile), never on the owner, and only the owner on an admin.
 *
 * What it does, in one transaction: moves the email, marks it NOT verified, signs the person out on every device, unlinks
 * Google/Microsoft logins that belonged to the old address, kills any password or invite link already sent, queues a notice
 * to the old and to the new address, and writes an audit row with no address in it. If the person had not accepted their
 * invite yet, a new invite goes to the new address afterwards (the old link is dead).
 *
 * Why "not verified": the manager typed the address, the person has not proved they own it. With email verification on, their next
 * password sign-in sends a confirmation link to the new address and waits for it; accepting an invite verifies it too.
 * Better Auth's own flow for a person changing their own email keeps it verified, because there the link proves the address.
 *
 * An invite to an existing login (`staff-login-invites.ts`) is never moved onto the login it pointed at: the manager is
 * correcting the address they typed. The invite becomes a new person at the new address, with the same team row, access and
 * profile, and gets a new person's invite, so the answer reads the same as for anyone who had not accepted yet.
 */
export async function changeMemberEmail(context: StaffContext, membershipId: string, input: StaffMemberEmailChangeInput): Promise<StaffMemberEmailChangeResult> {
  requirePermission(context, "team.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Team changes are unavailable in preview mode.");
  requireRecentStepUp(context);
  const newEmail = input.newEmail;
  const now = new Date();
  const outcome = await withTenant(context.tenantId, async (transaction) => {
    const target = await loadMemberForEmailChange(transaction, context.tenantId, membershipId);
    if (context.userId && target.userId === context.userId) {
      throw new ApiError(400, "own_email", "To change your own email, use Change email on your profile.");
    }
    if (target.role === "owner") throw new ApiError(403, "owner_required", "The owner changes their own email from their profile.");
    if (target.role === "admin" && context.role !== "owner") throw new ApiError(403, "owner_only", "Only the owner can change an admin's email.");
    await requireLocationReach(transaction, context, target);
    if (!target.isActive) throw new ApiError(400, "member_inactive", "Reactivate this person before changing their email.");
    if (target.email.toLowerCase() === newEmail) throw new ApiError(400, "same_email", "That is already their email.", { newEmail: ["That is already their email."] });
    if (target.loginInvite) {
      await assertNoCompanySignInConflict(transaction, context.tenantId, target.email, newEmail);
      await assertEmailAvailable(transaction, newEmail);
      const invite = await loadLoginInvite(transaction, context.tenantId, membershipId, { lock: true });
      if (!invite) throw new ApiError(404, "member_not_found", "Staff member not found.");
      // The new person's login takes the id the business already sees for the invite, as a new person's would stay the same.
      const userId = invite.standInUserId;
      try {
        await insertCredentialUser(transaction, { id: userId, name: invite.name, email: newEmail, password: generateStaffPassword(), passwordChosen: false });
      } catch (error: unknown) {
        rethrowIfEmailTaken(error);
      }
      await materializeInvite(transaction, { ...invite, invitedAt: now }, userId);
      await transaction.insert(auditEvents).values({
        tenantId: context.tenantId,
        actorUserId: context.userId,
        actorType: "staff",
        action: emailAuditActions.memberChanged,
        outcome: "success",
        metadata: { membershipId, inviteReissued: true, unlinkedLogins: 0 },
      });
      // The old address belongs to someone's own login, which nothing here changed, so only the new address hears of it.
      await queueEmailNotice(transaction, context.tenantId, { kind: "now_yours", to: newEmail, name: invite.name, at: now });
      return { userId, name: invite.name, inviteReissued: true };
    }
    // One login can belong to several businesses; changing it would change it for all of them, so only one-business logins are changed here.
    // This asks the definer function that also counts memberships switched off elsewhere and suspended businesses.
    if (await loginHeldElsewhere(transaction, context.tenantId, target.userId)) {
      throw new ApiError(409, "shared_login", "This person also works in another business, so their email can't be changed from here. They can change it from their own profile.");
    }
    await assertNoCompanySignInConflict(transaction, context.tenantId, target.email, newEmail);
    await assertEmailAvailable(transaction, newEmail, target.userId);
    const inviteReissued = target.passwordSetAt === null;
    try {
      await transaction.update(authUsers).set({ email: newEmail, emailVerified: false, updatedAt: now }).where(eq(authUsers.id, target.userId));
    } catch (error: unknown) {
      rethrowIfEmailTaken(error);
    }
    // Everything that could still open the account from the old address or from this person's open sessions.
    await transaction.delete(authSessions).where(eq(authSessions.userId, target.userId));
    await transaction.delete(authVerifications).where(eq(authVerifications.value, target.userId));
    const unlinked = await transaction.delete(authAccounts).where(sql`${authAccounts.userId} = ${target.userId} and ${authAccounts.providerId} <> 'credential'`).returning({ id: authAccounts.id });
    if (inviteReissued) await transaction.update(memberships).set({ invitedAt: now, updatedAt: now }).where(eq(memberships.id, membershipId));
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action: emailAuditActions.memberChanged,
      outcome: "success",
      // Facts only: no address, no name.
      metadata: { membershipId, inviteReissued, unlinkedLogins: unlinked.length },
    });
    await queueEmailNotice(transaction, context.tenantId, { kind: "changed_by_admin", to: target.email, name: target.name, at: now });
    await queueEmailNotice(transaction, context.tenantId, { kind: "now_yours", to: newEmail, name: target.name, at: now });
    return { userId: target.userId, name: target.name, inviteReissued };
  });
  if (!outcome.inviteReissued) return { membershipId, inviteReissued: false };
  const invite = await sendStaffInvite({ userId: outcome.userId, email: newEmail, name: outcome.name, clinicName: context.clinicName, inviterName: context.userName });
  return { membershipId, inviteReissued: true, invite };
}
