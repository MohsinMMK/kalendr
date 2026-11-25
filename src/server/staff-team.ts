import "server-only";

import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { checkMembershipLocations, loadMembershipLocationIds, setMembershipLocations } from "@/server/membership-locations";
import { allowedLocationIds } from "@/server/location-scope";
import {
  auditEvents,
  authUsers,
  customRoles,
  availabilityRules,
  locations,
  memberships,
  practitionerLocations,
  practitionerServices,
  practitioners,
  services,
  staffLoginInvites,
  tenants,
} from "@/db/schema";
import { practitionerInitials } from "@/lib/clinic-slug";
import { isInvitePending } from "@/lib/staff-invite-state";
import {
  cleanOverrides,
  resolvePermissions,
  type Permission,
  type PermissionOverrides,
  type StaffRole,
} from "@/lib/permissions";
import { profileWords, type TermWords } from "@/lib/terminology";
import { expandWorkingHourWindows } from "@/lib/working-hours";

import { assertCalendarEditable, assertCanAddCalendar } from "./billing/enforcement";
import { requireFeature } from "./entitlements";
import { ApiError } from "./api-error";
import { ensureDefaultSchedule, requirePractitionerReach, syncRuleLocations } from "./availability-admin";
import { loadBusinessProfileIn, loadStaffBusinessProfile } from "./business-profile";
import type {
  StaffCreateMemberInput,
  StaffCreatePractitionerInput,
  StaffSelfUpdateInput,
  StaffUpdateMemberInput,
  StaffUpdatePractitionerInput,
  WorkingHoursInput,
} from "./contracts";
import { refuseUnscannedUploads, setPractitionerPhotoIn, withStoredFiles, type StoredFiles } from "./media";
import { clinicDateKey, generateStaffPassword, insertCredentialUser } from "./staff-credentials";
import { closeCalendar, closePractitionerCalendar, reopenCalendar, reopenPractitionerCalendar } from "./scim/users";
import { requirePermission, requireRecentStepUp, type StaffContext } from "./staff-context";
import { revokeAllSessions, sendStaffInvite, sendStaffLoginInvite, sendStaffPasswordReset, type AccountLink } from "./staff-invites";
import {
  createLoginInvite,
  findLoginToInvite,
  inviteAcceptedError,
  inviteAsMember,
  loadLoginInvite,
  renewLoginInvite,
  type LoginInvite,
  type LoginInviteFacts,
} from "./staff-login-invites";
import { assertLoginNotShared, loginHeldElsewhere } from "./staff-shared-login";

export interface CreatedPractitioner {
  practitionerId: string;
  userId: string;
  email: string;
  /** Absent only when the profile was attached to the signed-in person. */
  invite?: AccountLink;
  attachedToCurrentUser: boolean;
}

/**
 * The answer is the same whether the email is new or already has a login (then it is an invite the person accepts after
 * signing in, `staff-login-invites.ts`): the same fields, an invite link either way, and nothing that says which it was.
 */
export interface CreatedMember {
  membershipId: string;
  userId: string;
  email: string;
  role: StaffCreateMemberInput["role"];
  invite: AccountLink;
}

/** Sends the link for a new person (choose a password) or for an existing login (sign in and accept). */
function sendNewMemberLink(context: StaffContext, input: { userId: string; email: string; name: string; loginInvite: LoginInvite | null }): Promise<AccountLink> {
  const common = { email: input.email, name: input.name, clinicName: context.clinicName, inviterName: context.userName };
  return input.loginInvite
    ? sendStaffLoginInvite({ ...common, inviteId: input.loginInvite.id, expiresAt: input.loginInvite.expiresAt })
    : sendStaffInvite({ ...common, userId: input.userId });
}

export type TenantTransaction = Parameters<Parameters<typeof withTenant>[1]>[0];

export async function wordsIn(transaction: TenantTransaction, tenantId: string): Promise<TermWords> {
  return profileWords(await loadBusinessProfileIn(transaction, tenantId));
}

async function staffWords(context: StaffContext): Promise<TermWords> {
  return profileWords(await loadStaffBusinessProfile(context));
}

/**
 * The locations a new membership is limited to. Someone who is limited themselves can only create limited staff: the list they
 * asked for (setMembershipLocations rejects ids outside their own), or all of their own locations when they gave none. Empty
 * means every location, and only someone who works at every location may create that.
 */
function locationsForNewMember(context: StaffContext, requested?: readonly string[]): string[] {
  const mine = allowedLocationIds(context);
  if (requested?.length) return [...requested];
  return mine ? [...mine] : [];
}

/** Applies `locationsForNewMember` to a membership just created. */
async function limitNewMember(transaction: TenantTransaction, context: StaffContext, membershipId: string, role: StaffRole, requested?: readonly string[]): Promise<void> {
  const wanted = locationsForNewMember(context, requested);
  if (wanted.length > 0) await setMembershipLocations(transaction, context, { id: membershipId, role }, wanted);
}

async function requireLocations(
  transaction: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  locationIds: string[],
): Promise<void> {
  const rows = await transaction
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.tenantId, tenantId), inArray(locations.id, locationIds)));
  if (rows.length !== locationIds.length) {
    const t = await wordsIn(transaction, tenantId);
    throw new ApiError(400, "location_not_found", `Choose an active ${t.business} ${t.location}.`);
  }
}

async function requireServices(
  transaction: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  serviceIds: string[],
): Promise<void> {
  const rows = await transaction
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.tenantId, tenantId), inArray(services.id, serviceIds)));
  if (rows.length !== serviceIds.length) {
    throw new ApiError(400, "service_not_found", `Choose services that belong to this ${(await wordsIn(transaction, tenantId)).business}.`);
  }
}

/**
 * Maps the optional profile fields to columns. A blank text field clears the value; a missing one leaves it.
 * A photo is stored as a picture in the file store (savePhoto); the old photo_data_url column is only cleared.
 */
function profileColumns(input: Pick<StaffUpdatePractitionerInput, "photoDataUrl" | "bio" | "qualifications" | "registrationNumber" | "experienceYears" | "languages" | "phone">) {
  return {
    ...(input.photoDataUrl !== undefined ? { photoDataUrl: null } : {}),
    ...(input.bio !== undefined ? { bio: input.bio || null } : {}),
    ...(input.qualifications !== undefined ? { qualifications: input.qualifications || null } : {}),
    ...(input.registrationNumber !== undefined ? { registrationNumber: input.registrationNumber || null } : {}),
    ...(input.experienceYears !== undefined ? { experienceYears: input.experienceYears } : {}),
    ...(input.languages !== undefined ? { languages: input.languages || null } : {}),
    ...(input.phone !== undefined ? { phone: input.phone || null } : {}),
  };
}

/** Stores a changed staff photo. Runs after the practitioner row exists. */
async function savePhoto(
  transaction: TenantTransaction,
  tenantId: string,
  practitionerId: string,
  photoDataUrl: string | null | undefined,
  stored: StoredFiles,
): Promise<void> {
  if (photoDataUrl === undefined) return;
  await setPractitionerPhotoIn(transaction, tenantId, practitionerId, photoDataUrl, stored);
}

async function writeHours(
  transaction: Parameters<Parameters<typeof withTenant>[1]>[0],
  input: {
    tenantId: string;
    practitionerId: string;
    locationIds: string[];
    timezone: string;
    hours: WorkingHoursInput;
  },
): Promise<void> {
  if (input.locationIds.length === 0) {
    const t = await wordsIn(transaction, input.tenantId);
    throw new ApiError(400, "location_not_found", `Choose ${t.aBusiness} ${t.location}.`);
  }
  const windows = expandWorkingHourWindows(input.hours);
  if (windows.length === 0) {
    throw new ApiError(400, "hours_required", "Set at least one working day.");
  }
  // This form edits the person's main schedule only; their other named schedules are left alone.
  const schedule = await ensureDefaultSchedule(transaction, input.tenantId, input.practitionerId, input.timezone);
  await transaction
    .delete(availabilityRules)
    .where(and(
      eq(availabilityRules.tenantId, input.tenantId),
      eq(availabilityRules.practitionerId, input.practitionerId),
      eq(availabilityRules.scheduleId, schedule.id),
    ));
  const validFrom = clinicDateKey(input.timezone);
  // A doctor's hours apply wherever they work. Reservations stop them being booked in two places at once.
  await transaction.insert(availabilityRules).values(
    input.locationIds.flatMap((locationId) => windows.map((window) => ({
      tenantId: input.tenantId,
      locationId,
      practitionerId: input.practitionerId,
      scheduleId: schedule.id,
      dayOfWeek: window.dayOfWeek,
      startsAtLocal: window.startsAtLocal,
      endsAtLocal: window.endsAtLocal,
      timezone: schedule.timezone,
      validFrom,
      slotIntervalMinutes: 15,
    }))),
  );
}

export async function createStaffPractitioner(
  context: StaffContext,
  input: StaffCreatePractitionerInput,
): Promise<CreatedPractitioner> {
  requirePermission(context, "team.manage");
  if (context.preview) {
    throw new ApiError(400, "preview_only", `${(await staffWords(context)).Practitioners} cannot be created in preview mode.`);
  }
  if (input.photoDataUrl) refuseUnscannedUploads();
  const created = await withStoredFiles((stored) => withTenant(context.tenantId, async (transaction) => {
    await assertCanAddCalendar(transaction, context.tenantId);
    requireOwnLocations(context, input.locationIds);
    await requireLocations(transaction, context.tenantId, input.locationIds);
    await requireServices(transaction, context.tenantId, input.serviceIds);
    const [tenant] = await transaction
      .select({ timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, context.tenantId))
      .limit(1);
    const timezone = tenant?.timezone || "Asia/Kolkata";
    const practitionerId = crypto.randomUUID();
    let userId = context.userId;
    let email = "";
    let loginInvite: LoginInvite | null = null;
    if (input.attachToCurrentUser) {
      if (!context.userId) {
        throw new ApiError(400, "missing_user", `Sign in again before adding yourself as ${(await wordsIn(transaction, context.tenantId)).aPractitioner}.`);
      }
      const existing = await transaction
        .select({ id: practitioners.id })
        .from(practitioners)
        .where(and(
          eq(practitioners.tenantId, context.tenantId),
          eq(practitioners.authUserId, context.userId),
        ))
        .limit(1);
      if (existing[0]) {
        throw new ApiError(409, "already_practitioner", `This account already has ${(await wordsIn(transaction, context.tenantId)).aPractitioner} profile.`);
      }
      userId = context.userId;
      const [owner] = await transaction
        .select({ email: authUsers.email })
        .from(authUsers)
        .where(eq(authUsers.id, context.userId))
        .limit(1);
      email = owner?.email ?? "";
    } else {
      email = input.email!.trim().toLowerCase();
      // An email that already has a login gets an invite the person accepts after signing in; the profile is linked then.
      const existingUserId = await findLoginToInvite(transaction, context.tenantId, email);
      if (existingUserId) {
        loginInvite = await createLoginInvite(transaction, context, {
          userId: existingUserId, email, name: input.name, role: "practitioner", locationIds: locationsForNewMember(context), practitionerId,
        });
        userId = loginInvite.standInUserId;
      } else {
        userId = crypto.randomUUID();
        await insertCredentialUser(transaction, {
          id: userId,
          name: input.name,
          email,
          password: generateStaffPassword(),
          passwordChosen: false,
        });
        const [membership] = await transaction.insert(memberships).values({
          tenantId: context.tenantId,
          userId,
          role: "practitioner",
          invitedAt: new Date(),
        }).returning({ id: memberships.id });
        if (!membership) throw new Error("Membership insert returned no row");
        await limitNewMember(transaction, context, membership.id, "practitioner");
      }
    }
    await transaction.insert(practitioners).values({
      id: practitionerId,
      tenantId: context.tenantId,
      authUserId: loginInvite ? null : userId,
      name: input.name,
      title: input.title,
      initials: input.initials?.trim() || practitionerInitials(input.name),
      specialty: input.specialty,
      ...profileColumns(input),
    });
    await savePhoto(transaction, context.tenantId, practitionerId, input.photoDataUrl, stored);
    await transaction.insert(practitionerLocations).values(
      input.locationIds.map((locationId) => ({
        tenantId: context.tenantId,
        practitionerId,
        locationId,
      })),
    );
    await transaction.insert(practitionerServices).values(
      input.serviceIds.map((serviceId) => ({
        tenantId: context.tenantId,
        practitionerId,
        serviceId,
      })),
    );
    await writeHours(transaction, {
      tenantId: context.tenantId,
      practitionerId,
      locationIds: input.locationIds,
      timezone,
      hours: input.hours,
    });
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action: "staff.practitioner.created",
      outcome: "success",
      metadata: { practitionerId, name: input.name, attachedToCurrentUser: input.attachToCurrentUser, ...(email && !input.attachToCurrentUser ? { email, role: "practitioner" } : {}) },
    });
    return {
      created: { practitionerId, userId: userId!, email, attachedToCurrentUser: input.attachToCurrentUser } satisfies CreatedPractitioner,
      loginInvite,
    };
  }));
  if (created.created.attachedToCurrentUser) return created.created;
  const invite = await sendNewMemberLink(context, { userId: created.created.userId, email: created.created.email, name: input.name, loginInvite: created.loginInvite });
  return { ...created.created, invite };
}

interface LinkedLoginOutcome {
  /** Set when the login was switched off here: every session of this person ends once the change is saved. */
  revokeUserId: string | null;
  futureBookings: number;
}

/**
 * Switching a profile on or off carries its login along, whatever the login's role: an owner, admin or receptionist who
 * also takes bookings is switched off with the profile, not left able to sign in. The same guards as editing the person
 * apply, so an admin can't switch off an owner this way. Your own login is never switched off from here, or you would lock
 * yourself out; only your calendar closes.
 */
async function syncLinkedLogin(transaction: TenantTransaction, context: StaffContext, profile: { id: string; authUserId: string | null }, isActive: boolean): Promise<LinkedLoginOutcome> {
  const none: LinkedLoginOutcome = { revokeUserId: null, futureBookings: 0 };
  // The team row linked to this profile: a membership by its login, or an invite (not accepted yet) that will link it.
  const [row] = profile.authUserId
    ? await transaction.select({ id: memberships.id }).from(memberships)
      .where(and(eq(memberships.tenantId, context.tenantId), eq(memberships.userId, profile.authUserId))).limit(1)
    : await transaction.select({ id: staffLoginInvites.id }).from(staffLoginInvites)
      .where(and(eq(staffLoginInvites.tenantId, context.tenantId), eq(staffLoginInvites.practitionerId, profile.id))).limit(1);
  if (!row || (context.userId && profile.authUserId === context.userId)) return none;
  const target = await loadMember(transaction, context.tenantId, row.id, { lock: true });
  if (target.isActive === isActive) return none;
  if (!isActive) await requireActionable(transaction, context, target);
  else await requireManageable(transaction, context, target);
  if (target.loginInvite) {
    await transaction.update(staffLoginInvites).set({ isActive, updatedAt: new Date() }).where(and(eq(staffLoginInvites.tenantId, context.tenantId), eq(staffLoginInvites.id, target.id)));
  } else {
    await transaction.update(memberships).set({ isActive, updatedAt: new Date() }).where(eq(memberships.id, target.id));
  }
  await transaction.insert(auditEvents).values({
    tenantId: context.tenantId,
    actorUserId: context.userId,
    actorType: "staff",
    action: isActive ? "staff.member.activated" : "staff.member.deactivated",
    outcome: "success",
    metadata: { membershipId: target.id, role: target.role, isActive: { from: target.isActive, to: isActive }, viaProfile: true },
  });
  // Sessions are ended only when no other business holds the login; access here already ended with the membership.
  if (target.loginInvite) return none;
  const heldElsewhere = isActive ? false : await loginHeldElsewhere(transaction, context.tenantId, target.userId);
  return { revokeUserId: isActive || heldElsewhere ? null : target.userId, futureBookings: 0 };
}

export async function updateStaffPractitioner(
  context: StaffContext,
  practitionerId: string,
  input: StaffUpdatePractitionerInput,
): Promise<{ practitionerId: string }> {
  const onlyHours = Object.entries(input).every(([key, value]) => key === "hours" || value === undefined);
  requirePermission(context, onlyHours ? "hours.edit" : "team.manage");
  if (input.photoDataUrl) refuseUnscannedUploads();
  const result = await withStoredFiles((stored) => withTenant(context.tenantId, async (transaction) => {
    const [existing] = await transaction
      .select()
      .from(practitioners)
      .where(and(eq(practitioners.tenantId, context.tenantId), eq(practitioners.id, practitionerId)))
      .limit(1);
    if (!existing) throw new ApiError(404, "practitioner_not_found", `${(await wordsIn(transaction, context.tenantId)).Practitioner} not found.`);
    await requirePractitionerReach(transaction, context, practitionerId);
    if (input.locationIds) requireOwnLocations(context, input.locationIds);
    // Plan limits (feature 14): switching a calendar on counts against the limit; a calendar over the limit is read-only.
    if (input.isActive === true && !existing.isActive) await assertCanAddCalendar(transaction, context.tenantId);
    else if (existing.isActive && !Object.entries(input).every(([key, value]) => (key === "isActive" && value === false) || value === undefined)) {
      await assertCalendarEditable(transaction, context.tenantId, practitionerId);
    }
    if (input.locationIds) await requireLocations(transaction, context.tenantId, input.locationIds);
    if (input.serviceIds) await requireServices(transaction, context.tenantId, input.serviceIds);
    const profile = profileColumns(input);
    if (input.name || input.title || input.specialty || input.isActive !== undefined || Object.keys(profile).length > 0) {
      const [updated] = await transaction.update(practitioners).set({
        ...profile,
        ...(input.name ? { name: input.name } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.specialty ? { specialty: input.specialty } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        updatedAt: new Date(),
      }).where(and(eq(practitioners.tenantId, context.tenantId), eq(practitioners.id, practitionerId))).returning({
        id: practitioners.id,
      });
      if (!updated) throw new ApiError(404, "practitioner_not_found", `${(await wordsIn(transaction, context.tenantId)).Practitioner} not found.`);
    }
    await savePhoto(transaction, context.tenantId, practitionerId, input.photoDataUrl, stored);
    // The calendar follows the profile: switching it off closes it and puts future bookings on the reassign list, as a directory
    // deactivation does; switching it on opens it again.
    let loginOutcome: LinkedLoginOutcome = { revokeUserId: null, futureBookings: 0 };
    if (input.isActive === false) {
      const closed = await closePractitionerCalendar(transaction, context.tenantId, practitionerId);
      loginOutcome.futureBookings = closed.futureBookings;
    } else if (input.isActive === true) {
      await reopenPractitionerCalendar(transaction, context.tenantId, practitionerId);
    }
    if (input.isActive !== undefined) {
      loginOutcome = { ...(await syncLinkedLogin(transaction, context, existing, input.isActive)), futureBookings: loginOutcome.futureBookings };
    }
    if (input.locationIds) {
      await transaction.delete(practitionerLocations).where(and(
        eq(practitionerLocations.tenantId, context.tenantId),
        eq(practitionerLocations.practitionerId, practitionerId),
      ));
      await transaction.insert(practitionerLocations).values(
        input.locationIds.map((locationId) => ({
          tenantId: context.tenantId,
          practitionerId,
          locationId,
        })),
      );
      // Hours follow the branches: a new branch gets the same ranges, a removed one loses its ranges.
      await syncRuleLocations(transaction, context.tenantId, practitionerId, input.locationIds);
    }
    if (input.serviceIds) {
      await transaction.delete(practitionerServices).where(and(
        eq(practitionerServices.tenantId, context.tenantId),
        eq(practitionerServices.practitionerId, practitionerId),
      ));
      await transaction.insert(practitionerServices).values(
        input.serviceIds.map((serviceId) => ({
          tenantId: context.tenantId,
          practitionerId,
          serviceId,
        })),
      );
    }
    if (input.hours) {
      const locationIds = input.locationIds ?? (
        await transaction
          .select({ locationId: practitionerLocations.locationId })
          .from(practitionerLocations)
          .where(and(
            eq(practitionerLocations.tenantId, context.tenantId),
            eq(practitionerLocations.practitionerId, practitionerId),
          ))
      ).map((row) => row.locationId);
      const [tenant] = await transaction
        .select({ timezone: tenants.timezone })
        .from(tenants)
        .where(eq(tenants.id, context.tenantId))
        .limit(1);
      await writeHours(transaction, {
        tenantId: context.tenantId,
        practitionerId,
        locationIds,
        timezone: tenant?.timezone || "Asia/Kolkata",
        hours: input.hours,
      });
    }
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action: "staff.practitioner.updated",
      outcome: "success",
      metadata: {
        practitionerId,
        name: existing.name,
        changed: Object.keys(input).filter((key) => input[key as keyof typeof input] !== undefined),
        ...(input.isActive !== undefined && input.isActive !== existing.isActive ? { isActive: { from: existing.isActive, to: input.isActive } } : {}),
        ...(input.isActive === false ? { futureBookings: loginOutcome.futureBookings } : {}),
      },
    });
    return { practitionerId, revokeUserId: loginOutcome.revokeUserId };
  }));
  if (result.revokeUserId) await revokeAllSessions(result.revokeUserId);
  return { practitionerId: result.practitionerId };
}

export async function createStaffMember(
  context: StaffContext,
  input: StaffCreateMemberInput,
): Promise<CreatedMember> {
  requirePermission(context, "team.manage");
  if (context.preview) {
    throw new ApiError(400, "preview_only", "Staff accounts cannot be created in preview mode.");
  }
  // Creating a login hands out access, so it needs a fresh second-factor check like changing a role does.
  requireRecentStepUp(context);
  if (input.role === "admin" && context.role !== "owner") {
    throw new ApiError(403, "owner_only", `Only the ${(await staffWords(context)).business} owner can add an admin.`);
  }
  const overrides = cleanOverrides(input.role, input.permissionOverrides);
  requireGrantable(context, resolvePermissions(input.role, overrides), []);
  const userId = crypto.randomUUID();
  const email = input.email.trim().toLowerCase();
  const memberLocationIds = locationsForNewMember(context, input.locationIds);
  const added = await withTenant(context.tenantId, async (transaction) => {
    // An email that already has a login gets an invite the person accepts after signing in. The audit row and the answer are
    // the same as for a new email.
    const existingUserId = await findLoginToInvite(transaction, context.tenantId, email);
    const loginInvite = existingUserId
      ? await createLoginInvite(transaction, context, {
        userId: existingUserId, email, name: input.name, role: input.role, jobTitle: input.jobTitle ?? null, permissionOverrides: overrides, locationIds: memberLocationIds,
      })
      : null;
    const membershipId = loginInvite ? loginInvite.id : await insertNewMember(transaction);
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action: "staff.member.created",
      outcome: "success",
      metadata: { membershipId, name: input.name.trim(), email, role: input.role, permissionOverrides: overrides, ...(memberLocationIds.length ? { locationIds: [...new Set(memberLocationIds)].sort() } : {}) },
    });
    return { membershipId, userId: loginInvite ? loginInvite.standInUserId : userId, loginInvite };
  });
  async function insertNewMember(transaction: TenantTransaction): Promise<string> {
    await insertCredentialUser(transaction, {
      id: userId,
      name: input.name,
      email,
      password: generateStaffPassword(),
      passwordChosen: false,
    });
    const [membership] = await transaction.insert(memberships).values({
      tenantId: context.tenantId,
      userId,
      role: input.role,
      permissionOverrides: overrides,
      jobTitle: input.jobTitle ?? null,
      invitedAt: new Date(),
    }).returning({ id: memberships.id });
    if (!membership) throw new Error("Membership insert returned no row");
    await limitNewMember(transaction, context, membership.id, input.role, input.locationIds);
    return membership.id;
  }
  const invite = await sendNewMemberLink(context, { userId: added.userId, email, name: input.name.trim(), loginInvite: added.loginInvite });
  return { membershipId: added.membershipId, userId: added.userId, email, role: input.role, invite };
}

/** Nobody can hand out a permission they don't hold themselves. */
function requireGrantable(context: StaffContext, next: readonly Permission[], previous: readonly Permission[]): void {
  const added = next.filter((permission) => !previous.includes(permission) && !context.permissions.includes(permission));
  if (added.length > 0) {
    throw new ApiError(403, "cannot_grant", "You can't give someone a permission you don't have yourself.");
  }
}

function permissionDiff(previous: readonly Permission[], next: readonly Permission[]): { granted: Permission[]; revoked: Permission[] } {
  return {
    granted: next.filter((permission) => !previous.includes(permission)),
    revoked: previous.filter((permission) => !next.includes(permission)),
  };
}

export interface MemberTarget {
  id: string;
  userId: string;
  role: StaffRole;
  customRoleId: string | null;
  /** The custom role's permission keys, or null for a built-in role. */
  customPermissions: string[] | null;
  isActive: boolean;
  jobTitle: string | null;
  permissionOverrides: PermissionOverrides;
  name: string;
  email: string;
  passwordSetAt: Date | null;
  lastSignInAt: Date | null;
  /**
   * Set when the team row is an invite to an existing login that the person hasn't accepted yet (`staff-login-invites.ts`).
   * Then `id` is the invite id and `userId` a stand-in that matches no login, so no action reaches the real login.
   */
  loginInvite?: LoginInviteFacts;
}

export async function loadMember(
  transaction: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  membershipId: string,
  options: { lock?: boolean } = {},
): Promise<MemberTarget> {
  const [row] = await transaction
    .select({
      id: memberships.id,
      userId: memberships.userId,
      role: memberships.role,
      isActive: memberships.isActive,
      jobTitle: memberships.jobTitle,
      permissionOverrides: memberships.permissionOverrides,
      customRoleId: memberships.customRoleId,
      customPermissions: customRoles.permissions,
      name: authUsers.name,
      email: authUsers.email,
      passwordSetAt: authUsers.passwordSetAt,
      lastSignInAt: authUsers.lastSignInAt,
    })
    .from(memberships)
    .innerJoin(authUsers, eq(authUsers.id, memberships.userId))
    .leftJoin(customRoles, and(eq(customRoles.tenantId, memberships.tenantId), eq(customRoles.id, memberships.customRoleId)))
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.id, membershipId)))
    .limit(1);
  if (!row) {
    // The team list shows invites to existing logins as pending people, by the invite id.
    // Locked for a change, so an invitee who accepts at the same moment waits and the change doesn't land on a row that's gone.
    const invite = await loadLoginInvite(transaction, tenantId, membershipId, options);
    if (invite) return inviteAsMember(transaction, invite);
    throw new ApiError(404, "member_not_found", "Staff member not found.");
  }
  return { ...row, permissionOverrides: cleanOverrides(row.role, row.permissionOverrides, row.customPermissions) };
}

/**
 * Someone limited to some locations may act only on teammates who work at those locations and nowhere else. A teammate who
 * sees every location (no rows) or any location outside yours is out of reach, or you could switch off, sign out or take over
 * people whose work you cannot see.
 */
export async function requireLocationReach(transaction: TenantTransaction, context: StaffContext, target: Pick<MemberTarget, "id" | "loginInvite">): Promise<void> {
  const mine = allowedLocationIds(context);
  if (!mine) return;
  const theirs = target.loginInvite ? target.loginInvite.locationIds : await loadMembershipLocationIds(transaction, context.tenantId, target.id);
  if (theirs.length === 0 || theirs.some((id) => !mine.includes(id))) {
    throw new ApiError(403, "cannot_manage_location", "This person works at locations you don't, so only someone who works at all of them can change their access.");
  }
}

/** A limited manager places a doctor only at locations they work at themselves. */
function requireOwnLocations(context: StaffContext, locationIds: readonly string[]): void {
  const mine = allowedLocationIds(context);
  if (mine && locationIds.some((id) => !mine.includes(id))) {
    throw new ApiError(403, "location_not_allowed", "You can only choose locations you work at.");
  }
}

/** Owner is fixed, nobody edits their own access, only the owner touches admins, and a limited manager stays within their locations. */
export async function requireManageable(transaction: TenantTransaction, context: StaffContext, target: MemberTarget, nextRole?: StaffRole): Promise<void> {
  if (target.role === "owner") {
    throw new ApiError(400, "owner_required", `The ${(await wordsIn(transaction, context.tenantId)).business} owner's access can't be changed.`);
  }
  if (context.userId && target.userId === context.userId) {
    throw new ApiError(400, "own_access", `You can't change your own access. Ask the ${(await wordsIn(transaction, context.tenantId)).business} owner.`);
  }
  if ((target.role === "admin" || nextRole === "admin") && context.role !== "owner") {
    throw new ApiError(403, "owner_only", `Only the ${(await wordsIn(transaction, context.tenantId)).business} owner can change an admin.`);
  }
  await requireLocationReach(transaction, context, target);
}

/** The only active owner can't be switched off or removed. The database refuses it too; this says why in words. */
export async function requireNotLastOwner(transaction: TenantTransaction, tenantId: string, target: MemberTarget): Promise<void> {
  if (target.role !== "owner" || !target.isActive) return;
  const [others] = await transaction
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, "owner"), eq(memberships.isActive, true), ne(memberships.id, target.id)));
  if ((others?.n ?? 0) === 0) {
    throw new ApiError(409, "last_owner", `A ${(await wordsIn(transaction, tenantId)).business} always keeps one owner. Make someone else the owner first.`);
  }
}

/**
 * The guards every action on another person goes through (switch off, remove, sign out, link): an admin never acts on an
 * owner, nobody acts on themselves, the only owner is protected, and only an owner acts on an admin.
 */
export async function requireActionable(transaction: TenantTransaction, context: StaffContext, target: MemberTarget, options: { lastOwner?: boolean } = {}): Promise<void> {
  if (target.role === "owner" && context.role !== "owner") {
    throw new ApiError(403, "owner_only", `Only the ${(await wordsIn(transaction, context.tenantId)).business} owner can do this to an owner.`);
  }
  if (context.userId && target.userId === context.userId) {
    throw new ApiError(400, "own_access", `You can't do this to your own account. Ask the ${(await wordsIn(transaction, context.tenantId)).business} owner.`);
  }
  if (options.lastOwner !== false) await requireNotLastOwner(transaction, context.tenantId, target);
  await requireManageable(transaction, context, target);
}

/**
 * The custom role this change leaves the person with, or null for a built-in role. A new built-in role clears any custom
 * role; a custom role must exist in this business and is never given to an owner.
 */
async function resolveNextCustomRole(
  transaction: TenantTransaction,
  tenantId: string,
  target: MemberTarget,
  input: StaffUpdateMemberInput,
): Promise<{ id: string; baseRole: StaffRole; permissions: string[] } | null> {
  if (input.customRoleId === null || (input.customRoleId === undefined && input.role !== undefined)) return null;
  const wanted = input.customRoleId ?? target.customRoleId;
  if (!wanted) return null;
  const [role] = await transaction
    .select({ id: customRoles.id, baseRole: customRoles.baseRole, permissions: customRoles.permissions })
    .from(customRoles)
    .where(and(eq(customRoles.tenantId, tenantId), eq(customRoles.id, wanted)))
    .limit(1);
  if (!role) throw new ApiError(404, "custom_role_not_found", "That role no longer exists. Choose another.");
  if (target.role === "owner") throw new ApiError(400, "owner_required", "The owner's access can't be changed.");
  return role;
}

export async function updateStaffMember(
  context: StaffContext,
  membershipId: string,
  input: StaffUpdateMemberInput,
): Promise<{ membershipId: string }> {
  requirePermission(context, "team.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Team changes are unavailable in preview mode.");
  // Changing what a person may do needs a fresh second-factor check. Switching someone on or off does not.
  if (input.role !== undefined || input.permissionOverrides !== undefined || input.customRoleId !== undefined || input.locationIds !== undefined) requireRecentStepUp(context);
  if (input.customRoleId) requireFeature(context, "enterprise");
  const outcome = await withTenant(context.tenantId, async (transaction) => {
    const target = await loadMember(transaction, context.tenantId, membershipId, { lock: true });
    const nextCustom = await resolveNextCustomRole(transaction, context.tenantId, target, input);
    const nextRole = nextCustom ? nextCustom.baseRole : input.role ?? target.role;
    await requireManageable(transaction, context, target, nextRole);
    if (nextRole === "practitioner" && target.role !== "practitioner") {
      const [profile] = target.loginInvite
        ? target.loginInvite.practitionerId ? [{ id: target.loginInvite.practitionerId }] : []
        : await transaction
          .select({ id: practitioners.id })
          .from(practitioners)
          .where(and(eq(practitioners.tenantId, context.tenantId), eq(practitioners.authUserId, target.userId)))
          .limit(1);
      if (!profile) {
        const t = await wordsIn(transaction, context.tenantId);
        throw new ApiError(400, "practitioner_profile_required", `Add them from ${t.Practitioners} first, so ${t.customers} can book them.`);
      }
    }
    // A new role starts from its own defaults unless new switches come with it.
    const nextCustomPermissions = nextCustom ? nextCustom.permissions : null;
    const roleChanged = nextRole !== target.role || (nextCustom?.id ?? null) !== target.customRoleId;
    const nextOverrides = input.permissionOverrides !== undefined
      ? cleanOverrides(nextRole, input.permissionOverrides, nextCustomPermissions)
      : roleChanged && (input.role !== undefined || input.customRoleId !== undefined) ? {} : target.permissionOverrides;
    const previousPermissions = resolvePermissions(target.role, target.permissionOverrides, target.customPermissions);
    const nextPermissions = resolvePermissions(nextRole, nextOverrides, nextCustomPermissions);
    requireGrantable(context, nextPermissions, previousPermissions);
    const nextActive = input.isActive ?? target.isActive;
    const locationChange = input.locationIds === undefined
      ? null
      : target.loginInvite
        ? await inviteLocationChange(transaction, context, target.loginInvite, nextRole, input.locationIds)
        : await setMembershipLocations(transaction, context, { id: target.id, role: nextRole }, input.locationIds);
    const jobTitleChanged = input.jobTitle !== undefined && input.jobTitle !== target.jobTitle;
    const values = {
      role: nextRole,
      customRoleId: nextCustom?.id ?? null,
      permissionOverrides: nextOverrides,
      isActive: nextActive,
      ...(input.jobTitle !== undefined ? { jobTitle: input.jobTitle } : {}),
      updatedAt: new Date(),
    };
    if (target.loginInvite) {
      const updated = await transaction.update(staffLoginInvites).set({ ...values, ...(locationChange ? { locationIds: locationChange.after } : {}) })
        .where(and(eq(staffLoginInvites.tenantId, context.tenantId), eq(staffLoginInvites.id, membershipId)))
        .returning({ id: staffLoginInvites.id });
      if (updated.length === 0) throw inviteAcceptedError();
    } else {
      await transaction.update(memberships).set(values).where(eq(memberships.id, membershipId));
    }
    const diff = permissionDiff(previousPermissions, nextPermissions);
    const locationsChanged = locationChange?.changed === true;
    const accessChanged = nextRole !== target.role || nextActive !== target.isActive || roleChanged || diff.granted.length > 0 || diff.revoked.length > 0;
    const action = nextActive !== target.isActive
      ? nextActive ? "staff.member.activated" : "staff.member.deactivated"
      : roleChanged ? "staff.member.role_changed" : jobTitleChanged && !accessChanged && !locationsChanged ? "staff.member.job_title_changed" : locationsChanged && !accessChanged ? "staff.member.locations_changed" : "staff.member.permissions_changed";
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action,
      outcome: "success",
      metadata: {
        membershipId,
        name: target.name,
        ...(nextRole !== target.role ? { role: { from: target.role, to: nextRole } } : {}),
        ...((nextCustom?.id ?? null) !== target.customRoleId ? { customRole: { from: target.customRoleId, to: nextCustom?.id ?? null } } : {}),
        ...(nextActive !== target.isActive ? { isActive: { from: target.isActive, to: nextActive } } : {}),
        ...(diff.granted.length || diff.revoked.length ? diff : {}),
        // That the title changed, never the text.
        ...(jobTitleChanged ? { changed: ["jobTitle"] } : {}),
        // Location ids only, before and after; an empty list means every location.
        ...(locationsChanged && locationChange ? { locations: { from: locationChange.before, to: locationChange.after } } : {}),
      },
    });
    // Switching someone off closes their calendar too, so their future bookings land on the reassign list; switching on opens it.
    // An invite has no login yet, so its calendar is the profile it will link.
    const profileId = target.loginInvite?.practitionerId;
    if (target.isActive && !nextActive) {
      if (target.loginInvite) { if (profileId) await closePractitionerCalendar(transaction, context.tenantId, profileId); }
      else await closeCalendar(transaction, context.tenantId, target.userId);
    } else if (!target.isActive && nextActive) {
      if (target.loginInvite) { if (profileId) await reopenPractitionerCalendar(transaction, context.tenantId, profileId); }
      else await reopenCalendar(transaction, context.tenantId, target.userId);
    }
    // An invite grants nothing yet, so there are no sessions to end.
    const deactivated = target.isActive && !nextActive && !target.loginInvite;
    return { userId: target.userId, deactivated, heldElsewhere: deactivated ? await loginHeldElsewhere(transaction, context.tenantId, target.userId) : false };
  });
  // Access here ends at once without this: getStaffContext re-reads memberships on every request, so a switched-off membership
  // stops working on the next click. Sessions belong to the login, not to one business, so they are ended too only when no
  // other business holds the login; otherwise this business would sign the person out of the others.
  if (outcome.deactivated && !outcome.heldElsewhere) await revokeAllSessions(outcome.userId);
  return { membershipId };
}

/** The same checks as `setMembershipLocations`, for an invite whose limit is kept on the invite row until it is accepted. */
async function inviteLocationChange(
  transaction: TenantTransaction,
  context: StaffContext,
  invite: LoginInviteFacts,
  role: StaffRole,
  requested: readonly string[],
): Promise<{ changed: boolean; before: string[]; after: string[] }> {
  const before = [...invite.locationIds].sort();
  const after = await checkMembershipLocations(transaction, context, role, requested);
  return { changed: before.join(",") !== after.join(","), before, after };
}

/**
 * Gives a bookable person who was added without a login (by an import or a seed) their own sign-in: a new account with
 * the practitioner role, linked to this profile, and the usual invite link to choose a password. A person who already
 * signs in keeps their login; resending their link happens on the Sign-in and access tab.
 */
export async function invitePractitionerLogin(
  context: StaffContext,
  practitionerId: string,
  rawEmail: string,
): Promise<{ practitionerId: string; membershipId: string; email: string; invite: AccountLink }> {
  requirePermission(context, "team.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Invites are unavailable in preview mode.");
  requireRecentStepUp(context);
  const email = rawEmail.trim().toLowerCase();
  const userId = crypto.randomUUID();
  const created = await withTenant(context.tenantId, async (transaction) => {
    const words = await wordsIn(transaction, context.tenantId);
    const [person] = await transaction
      .select({ name: practitioners.name, authUserId: practitioners.authUserId, isActive: practitioners.isActive })
      .from(practitioners)
      .where(and(eq(practitioners.tenantId, context.tenantId), eq(practitioners.id, practitionerId)))
      .limit(1)
      .for("update");
    if (!person) throw new ApiError(404, "not_found", `This ${words.practitioner} no longer exists.`);
    if (person.authUserId) throw new ApiError(409, "already_has_login", `${person.name} already has a login. Send them a new link from Sign-in and access.`);
    if (!person.isActive) throw new ApiError(400, "practitioner_inactive", `Reactivate ${person.name} before giving them a login.`);
    const [pending] = await transaction.select({ id: staffLoginInvites.id }).from(staffLoginInvites)
      .where(and(eq(staffLoginInvites.tenantId, context.tenantId), eq(staffLoginInvites.practitionerId, practitionerId))).limit(1);
    if (pending) throw new ApiError(409, "already_has_login", `${person.name} already has a login. Send them a new link from Sign-in and access.`);
    // An email that already has a login gets an invite the person accepts after signing in; the profile is linked then. The
    // audit row and the answer are the same as for a new email.
    const existingUserId = await findLoginToInvite(transaction, context.tenantId, email);
    if (existingUserId) {
      const loginInvite = await createLoginInvite(transaction, context, {
        userId: existingUserId, email, name: person.name, role: "practitioner", locationIds: locationsForNewMember(context), practitionerId,
      });
      await auditLoginCreated(transaction, loginInvite.id, person.name);
      return { membershipId: loginInvite.id, userId: loginInvite.standInUserId, name: person.name, loginInvite };
    }
    await insertCredentialUser(transaction, { id: userId, name: person.name, email, password: generateStaffPassword(), passwordChosen: false });
    const [membership] = await transaction.insert(memberships).values({
      tenantId: context.tenantId,
      userId,
      role: "practitioner",
      invitedAt: new Date(),
    }).returning({ id: memberships.id });
    if (!membership) throw new Error("Membership insert returned no row");
    await limitNewMember(transaction, context, membership.id, "practitioner");
    await transaction.update(practitioners).set({ authUserId: userId, updatedAt: new Date() })
      .where(and(eq(practitioners.tenantId, context.tenantId), eq(practitioners.id, practitionerId)));
    await auditLoginCreated(transaction, membership.id, person.name);
    return { membershipId: membership.id, userId, name: person.name, loginInvite: null };
  });
  async function auditLoginCreated(transaction: TenantTransaction, membershipId: string, name: string): Promise<void> {
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action: "staff.practitioner.login_created",
      outcome: "success",
      metadata: { practitionerId, membershipId, name, email, role: "practitioner" },
    });
  }
  const invite = await sendNewMemberLink(context, { userId: created.userId, email, name: created.name, loginInvite: created.loginInvite });
  return { practitionerId, membershipId: created.membershipId, email, invite };
}

/** Sends a fresh invite to someone who hasn't set a password yet, otherwise a password reset link. */
export async function sendMemberAccessLink(
  context: StaffContext,
  membershipId: string,
): Promise<AccountLink & { kind: "invite" | "reset" }> {
  requirePermission(context, "team.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Invites are unavailable in preview mode.");
  // The link is shown to the sender and sets the person's password, so it asks for a fresh second-factor check.
  requireRecentStepUp(context);
  const target = await withTenant(context.tenantId, async (transaction) => {
    const member = await loadMember(transaction, context.tenantId, membershipId, { lock: true });
    if (member.role === "owner" && member.userId !== context.userId) {
      throw new ApiError(400, "owner_required", "The owner resets their own password from the sign-in page.");
    }
    if (!member.isActive) throw new ApiError(400, "member_inactive", "Reactivate this person before sending them a link.");
    if (member.role === "admin" && context.role !== "owner") {
      throw new ApiError(403, "owner_only", `Only the ${(await wordsIn(transaction, context.tenantId)).business} owner can reset an admin's password.`);
    }
    if (member.userId !== context.userId) await requireLocationReach(transaction, context, member);
    // An invite to an existing login: a fresh link that only lets the person sign in and answer. It sets no password, so the
    // shared-login check below does not apply (and running it would tell the sender the email already had a login).
    let loginInvite: LoginInvite | null = null;
    if (member.loginInvite) {
      loginInvite = await loadLoginInvite(transaction, context.tenantId, membershipId, { lock: true });
      if (!loginInvite) throw new ApiError(404, "member_not_found", "Staff member not found.");
      loginInvite = { ...loginInvite, expiresAt: await renewLoginInvite(transaction, loginInvite) };
    } else if (member.userId !== context.userId) {
      // A link would set the password for every business this login belongs to, and the link is shown to the sender.
      await assertLoginNotShared(transaction, context.tenantId, member.userId);
    }
    const kind = isInvitePending(member) ? "invite" : "reset";
    if (kind === "invite" && !loginInvite) {
      await transaction.update(memberships).set({ invitedAt: new Date(), updatedAt: new Date() }).where(eq(memberships.id, membershipId));
    }
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action: kind === "invite" ? "staff.member.invite_sent" : "staff.member.reset_sent",
      outcome: "success",
      metadata: { membershipId, name: member.name },
    });
    return { ...member, kind, loginInvite } as const;
  });
  const link = target.kind === "invite"
    ? await sendNewMemberLink(context, { userId: target.userId, email: target.email, name: target.name, loginInvite: target.loginInvite })
    : await sendStaffPasswordReset({ userId: target.userId, email: target.email, name: target.name });
  return { ...link, kind: target.kind };
}

/** The doctor profile linked to this login, if they see patients here. */
export async function findOwnPractitionerId(context: StaffContext): Promise<string | null> {
  if (context.preview || !context.userId) return null;
  const userId = context.userId;
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction
      .select({ id: practitioners.id })
      .from(practitioners)
      .where(and(eq(practitioners.tenantId, context.tenantId), eq(practitioners.authUserId, userId)))
      .limit(1);
    return row?.id ?? null;
  });
}

/** The signed-in person's own job title, for the sidebar's account section. */
export async function findOwnJobTitle(context: StaffContext): Promise<string | null> {
  if (context.preview || !context.userId) return null;
  const userId = context.userId;
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction
      .select({ jobTitle: memberships.jobTitle })
      .from(memberships)
      .where(and(eq(memberships.tenantId, context.tenantId), eq(memberships.userId, userId)))
      .limit(1);
    return row?.jobTitle ?? null;
  });
}

/**
 * My profile. Anyone with profile.own can change their name, and a doctor their public profile;
 * hours.own lets a doctor set their own hours. Nothing here changes their access.
 */
export async function updateOwnProfile(
  context: StaffContext,
  input: StaffSelfUpdateInput,
): Promise<{ practitionerId: string | null }> {
  const changesHours = input.hours !== undefined;
  const changesProfile = input.name !== undefined || input.profile !== undefined || input.jobTitle !== undefined;
  if (!changesHours && !changesProfile) throw new ApiError(400, "nothing_to_change", "Nothing to change.");
  if (changesProfile) requirePermission(context, "profile.own");
  if (changesHours) requirePermission(context, "hours.own");
  if (context.preview || !context.userId) {
    throw new ApiError(409, "preview_profile", `Profiles are saved once ${(await staffWords(context)).aBusiness} database is connected.`);
  }
  const userId = context.userId;
  if (input.profile?.photoDataUrl) refuseUnscannedUploads();
  return withStoredFiles((stored) => withTenant(context.tenantId, async (transaction) => {
    const [practitioner] = await transaction
      .select({ id: practitioners.id, name: practitioners.name })
      .from(practitioners)
      .where(and(eq(practitioners.tenantId, context.tenantId), eq(practitioners.authUserId, userId)))
      .limit(1);
    if ((input.profile || changesHours) && !practitioner) {
      throw new ApiError(400, "not_a_practitioner", `Only ${(await wordsIn(transaction, context.tenantId)).practitioners} have a public profile and working hours.`);
    }
    const changed: string[] = [];
    if (input.jobTitle !== undefined) {
      await transaction.update(memberships).set({ jobTitle: input.jobTitle, updatedAt: new Date() })
        .where(and(eq(memberships.tenantId, context.tenantId), eq(memberships.userId, userId)));
      changed.push("jobTitle");
    }
    if (input.name && input.name !== context.userName) {
      await transaction.update(authUsers).set({ name: input.name, updatedAt: new Date() }).where(eq(authUsers.id, userId));
      changed.push("name");
    }
    if (practitioner) {
      const profile = input.profile ? profileColumns(input.profile) : {};
      const columns = {
        ...profile,
        ...(input.name ? { name: input.name, initials: practitionerInitials(input.name).slice(0, 2) } : {}),
        ...(input.profile?.title ? { title: input.profile.title } : {}),
        ...(input.profile?.specialty ? { specialty: input.profile.specialty } : {}),
      };
      if (Object.keys(columns).length > 0) {
        await transaction.update(practitioners).set({ ...columns, updatedAt: new Date() })
          .where(and(eq(practitioners.tenantId, context.tenantId), eq(practitioners.id, practitioner.id)));
      }
      await savePhoto(transaction, context.tenantId, practitioner.id, input.profile?.photoDataUrl, stored);
      if (input.profile) {
        const fieldNames: Record<string, string> = { photoDataUrl: "photo" };
        for (const [key, value] of Object.entries(input.profile)) {
          if (value !== undefined) changed.push(fieldNames[key] ?? key);
        }
      }
      if (input.hours) {
        const locationIds = (await transaction
          .select({ locationId: practitionerLocations.locationId })
          .from(practitionerLocations)
          .where(and(eq(practitionerLocations.tenantId, context.tenantId), eq(practitionerLocations.practitionerId, practitioner.id)))
        ).map((row) => row.locationId);
        const [tenant] = await transaction.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, context.tenantId)).limit(1);
        await writeHours(transaction, {
          tenantId: context.tenantId,
          practitionerId: practitioner.id,
          locationIds,
          timezone: tenant?.timezone || "Asia/Kolkata",
          hours: input.hours,
        });
        changed.push("hours");
      }
    }
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: userId,
      actorType: "staff",
      action: practitioner ? "staff.practitioner.updated" : "staff.profile.updated",
      outcome: "success",
      metadata: { self: true, name: input.name ?? context.userName, changed, ...(practitioner ? { practitionerId: practitioner.id } : {}) },
    });
    return { practitionerId: practitioner?.id ?? null };
  }));
}

/**
 * For `staff-email.ts`: the member an email change is aimed at, read the same way every other team change reads one.
 * @alias
 */
export const loadMemberForEmailChange = loadMember;
