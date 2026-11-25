import "server-only";

import { randomBytes } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase, withTenant } from "@/db/client";
import { auditEvents, authUsers, memberships, practitioners, timeOff } from "@/db/schema";
import { emailDomainOf } from "@/lib/email-domain-rules";
import { getPostgresErrorCode } from "@/server/api-error";
import { insertCredentialUser } from "@/server/staff-credentials";
import { revokeAllSessions } from "@/server/staff-invites";

import type { ScimContext } from "./auth";
import { ScimError, listResponse, looseBoolean, parseListQuery, scimUserSchemaId, type PatchOperation } from "./protocol";

type TenantTransaction = Parameters<Parameters<typeof withTenant>[1]>[0];

/** How far ahead a deactivated person's time off runs: their calendar stays closed and their bookings stay on the reassign list. */
const closedForYears = 10;

interface UserRow extends Record<string, unknown> {
  membership_id: string;
  user_id: string;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
  scim_external_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function resource(row: UserRow, baseUrl: string): unknown {
  const parts = row.name.trim().split(/\s+/);
  return {
    schemas: [scimUserSchemaId],
    id: row.membership_id,
    ...(row.scim_external_id ? { externalId: row.scim_external_id } : {}),
    userName: row.email,
    name: { formatted: row.name, givenName: parts[0] ?? row.name, familyName: parts.slice(1).join(" ") },
    displayName: row.name,
    emails: [{ value: row.email, primary: true, type: "work" }],
    active: row.is_active,
    meta: { resourceType: "User", created: new Date(row.created_at).toISOString(), lastModified: new Date(row.updated_at).toISOString(), location: `${baseUrl}/Users/${row.membership_id}` },
  };
}

const selectUsers = (tenantId: string) => sql`
  select membership.id as membership_id, membership.user_id, person.email, person.name, membership.role, membership.is_active,
    membership.scim_external_id, membership.created_at, membership.updated_at
  from memberships as membership join auth_users as person on person.id = membership.user_id
  where membership.tenant_id = ${tenantId}`;

async function loadUser(transaction: TenantTransaction, tenantId: string, membershipId: string): Promise<UserRow> {
  const [row] = await transaction.execute<UserRow>(sql`${selectUsers(tenantId)} and membership.id = ${membershipId}`);
  if (!row) throw new ScimError(404, "That user does not exist.");
  return row;
}

export async function listUsers(context: ScimContext, url: URL, baseUrl: string): Promise<unknown> {
  const query = parseListQuery(url);
  return withTenant(context.tenantId, async (transaction) => {
    const filter = query.filter
      ? query.filter.attribute === "externalid" ? sql` and membership.scim_external_id = ${query.filter.value}`
        : sql` and lower(person.email) = ${query.filter.value.toLowerCase()}`
      : sql``;
    const [{ total } = { total: 0 }] = await transaction.execute<{ total: number }>(sql`select count(*)::int as total from (${selectUsers(context.tenantId)}${filter}) as listed`);
    const rows = await transaction.execute<UserRow>(sql`${selectUsers(context.tenantId)}${filter} order by person.email limit ${query.count} offset ${query.startIndex - 1}`);
    return listResponse(rows.map((row) => resource(row, baseUrl)), total, query.startIndex);
  });
}

export async function getUser(context: ScimContext, membershipId: string, baseUrl: string): Promise<unknown> {
  return withTenant(context.tenantId, async (transaction) => resource(await loadUser(transaction, context.tenantId, membershipId), baseUrl));
}

export const userInputSchema = z.object({
  userName: z.string().trim().toLowerCase().email().max(254),
  externalId: z.string().trim().min(1).max(255).optional(),
  displayName: z.string().trim().min(1).max(160).optional(),
  name: z.object({ givenName: z.string().trim().max(80).optional(), familyName: z.string().trim().max(80).optional(), formatted: z.string().trim().max(160).optional() }).optional(),
  emails: z.array(z.object({ value: z.string().trim().email().max(254), primary: z.boolean().optional() })).max(10).optional(),
  active: looseBoolean.optional(),
}).passthrough();
export type UserInput = z.infer<typeof userInputSchema>;

function displayNameOf(input: UserInput, email: string): string {
  const joined = [input.name?.givenName, input.name?.familyName].filter(Boolean).join(" ");
  return (input.displayName ?? input.name?.formatted ?? joined ?? "").trim().slice(0, 160) || email.split("@")[0]!;
}

async function requireOwnDomain(transaction: TenantTransaction, tenantId: string, email: string): Promise<void> {
  const domain = emailDomainOf(email);
  const [row] = domain ? await transaction.execute<{ id: string }>(sql`select id from verified_domains where tenant_id = ${tenantId} and domain = ${domain} and verified_at is not null`) : [];
  if (!row) throw new ScimError(400, "That address is not on a domain this business has proved.", "invalidValue");
}

async function audit(transaction: TenantTransaction, context: ScimContext, action: string, metadata: Record<string, unknown>): Promise<void> {
  await transaction.insert(auditEvents).values({ tenantId: context.tenantId, actorType: "system", action, outcome: "success", metadata: { tokenId: context.tokenId, ...metadata } });
}

/**
 * Closes a deactivated person's calendar and counts the bookings that now need someone else. They stay until a person moves them.
 * Also used by the team screen's deactivate and remove, so a hand-made change leaves the same trail as a directory one.
 */
export async function closePractitionerCalendar(transaction: TenantTransaction, tenantId: string, practitionerId: string): Promise<{ timeOffId: string | null; futureBookings: number }> {
  const [open] = await transaction.execute<{ id: string }>(sql`
    select id from time_off where tenant_id = ${tenantId} and practitioner_id = ${practitionerId} and ends_at > now() + ${`${closedForYears - 1} years`}::interval limit 1`);
  let timeOffId = open?.id ?? null;
  if (!timeOffId) {
    const [created] = await transaction.insert(timeOff).values({
      tenantId, practitionerId, startsAt: new Date(), endsAt: new Date(Date.now() + closedForYears * 365 * 86_400_000), reason: "other",
    }).returning({ id: timeOff.id });
    timeOffId = created!.id;
  }
  const [count] = await transaction.execute<{ n: number }>(sql`
    select count(*)::int as n from appointments where tenant_id = ${tenantId} and practitioner_id = ${practitionerId} and status in ('requested', 'booked') and ends_at > now()`);
  return { timeOffId, futureBookings: count?.n ?? 0 };
}

export async function closeCalendar(transaction: TenantTransaction, tenantId: string, userId: string): Promise<{ timeOffId: string | null; futureBookings: number }> {
  const [person] = await transaction.select({ id: practitioners.id }).from(practitioners).where(and(eq(practitioners.tenantId, tenantId), eq(practitioners.authUserId, userId))).limit(1);
  if (!person) return { timeOffId: null, futureBookings: 0 };
  return closePractitionerCalendar(transaction, tenantId, person.id);
}

/** Opens a calendar that deactivation or removal closed. A leave someone entered by hand is not touched. */
export async function reopenPractitionerCalendar(transaction: TenantTransaction, tenantId: string, practitionerId: string): Promise<void> {
  await transaction.execute(sql`
    update time_off set ends_at = greatest(now(), starts_at + interval '1 second'), updated_at = now()
    where tenant_id = ${tenantId} and ends_at > now() + ${`${closedForYears - 1} years`}::interval and practitioner_id = ${practitionerId}`);
}

export async function reopenCalendar(transaction: TenantTransaction, tenantId: string, userId: string): Promise<void> {
  await transaction.execute(sql`
    update time_off set ends_at = greatest(now(), starts_at + interval '1 second'), updated_at = now()
    where tenant_id = ${tenantId} and ends_at > now() + ${`${closedForYears - 1} years`}::interval
      and practitioner_id in (select id from practitioners where tenant_id = ${tenantId} and auth_user_id = ${userId})`);
}

/** Signs the person out everywhere when this was their last business; otherwise the business is simply refused them from now on. */
async function endSessionsIfNoBusinessLeft(userId: string): Promise<void> {
  const database = getDatabase();
  if (!database) return;
  const remaining = await database.execute(sql`select 1 from kalendr_resolve_staff_access(${userId}) limit 1`);
  if (remaining.length === 0) await revokeAllSessions(userId);
}

export async function createUser(context: ScimContext, input: UserInput, baseUrl: string): Promise<unknown> {
  const email = input.userName;
  let created: UserRow;
  try {
    created = await withTenant(context.tenantId, async (transaction) => {
      await requireOwnDomain(transaction, context.tenantId, email);
      const [existing] = await transaction.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, email)).limit(1);
      if (existing) {
        const [member] = await transaction.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.tenantId, context.tenantId), eq(memberships.userId, existing.id))).limit(1);
        if (member) throw new ScimError(409, "A user with that name already exists.", "uniqueness");
      }
      const userId = existing?.id ?? crypto.randomUUID();
      if (!existing) {
        await insertCredentialUser(transaction, { id: userId, name: displayNameOf(input, email), email, password: randomBytes(24).toString("base64url"), emailVerified: true, passwordChosen: false });
      }
      const active = input.active !== false;
      const [membership] = await transaction.insert(memberships).values({
        tenantId: context.tenantId, userId, role: context.defaultRole, isActive: active, invitedAt: new Date(), scimExternalId: input.externalId ?? null,
      }).returning({ id: memberships.id });
      await audit(transaction, context, "enterprise.scim.user_created", { membershipId: membership!.id, role: context.defaultRole });
      return loadUser(transaction, context.tenantId, membership!.id);
    });
  } catch (error: unknown) {
    if (getPostgresErrorCode(error) === "23505") throw new ScimError(409, "A user with that name or external id already exists.", "uniqueness");
    throw error;
  }
  return resource(created, baseUrl);
}

/** Applies the fields a directory may change. The owner's own access is never changed from outside Kalendr. */
async function applyChanges(transaction: TenantTransaction, context: ScimContext, current: UserRow, changes: { active?: boolean | undefined; externalId?: string | null | undefined; name?: string | undefined; userName?: string | undefined }): Promise<{ deactivated: boolean; timeOffId: string | null; futureBookings: number }> {
  if (current.role === "owner") throw new ScimError(403, "The owner's access is managed in Kalendr, not by the directory.", "mutability");
  if (changes.userName !== undefined && changes.userName !== current.email) throw new ScimError(400, "The user name can't be changed. Create a new user instead.", "mutability");
  let outcome = { deactivated: false, timeOffId: null as string | null, futureBookings: 0 };
  if (changes.externalId !== undefined) {
    await transaction.update(memberships).set({ scimExternalId: changes.externalId, updatedAt: new Date() }).where(and(eq(memberships.tenantId, context.tenantId), eq(memberships.id, current.membership_id)));
  }
  if (changes.name !== undefined && changes.name !== current.name) {
    // The name belongs to the person, who may work for other businesses too, so only a business they belong to alone may change it.
    const [others] = await transaction.execute<{ n: number }>(sql`select count(*)::int as n from kalendr_resolve_staff_access(${current.user_id}) where tenant_id <> ${context.tenantId}`).catch(() => [{ n: 1 }]);
    if ((others?.n ?? 1) === 0) await transaction.update(authUsers).set({ name: changes.name, updatedAt: new Date() }).where(eq(authUsers.id, current.user_id));
  }
  if (changes.active !== undefined && changes.active !== current.is_active) {
    await transaction.update(memberships).set({ isActive: changes.active, updatedAt: new Date() }).where(and(eq(memberships.tenantId, context.tenantId), eq(memberships.id, current.membership_id)));
    if (changes.active) {
      await reopenCalendar(transaction, context.tenantId, current.user_id);
      await audit(transaction, context, "enterprise.scim.user_updated", { membershipId: current.membership_id, isActive: true });
    } else {
      const closed = await closeCalendar(transaction, context.tenantId, current.user_id);
      outcome = { deactivated: true, ...closed };
      await audit(transaction, context, "enterprise.scim.user_deactivated", { membershipId: current.membership_id, ...(closed.timeOffId ? { timeOffId: closed.timeOffId } : {}), futureBookings: closed.futureBookings });
    }
  } else if (changes.externalId !== undefined || changes.name !== undefined) {
    await audit(transaction, context, "enterprise.scim.user_updated", { membershipId: current.membership_id });
  }
  return outcome;
}

function nameFrom(input: { displayName?: string | undefined; name?: { givenName?: string | undefined; familyName?: string | undefined; formatted?: string | undefined } | undefined }): string | undefined {
  const joined = [input.name?.givenName, input.name?.familyName].filter(Boolean).join(" ");
  return (input.displayName ?? input.name?.formatted ?? (joined || undefined))?.slice(0, 160);
}

export async function replaceUser(context: ScimContext, membershipId: string, input: UserInput, baseUrl: string): Promise<unknown> {
  const result = await withTenant(context.tenantId, async (transaction) => {
    const current = await loadUser(transaction, context.tenantId, membershipId);
    const outcome = await applyChanges(transaction, context, current, { active: input.active, externalId: input.externalId ?? null, name: nameFrom(input), userName: input.userName });
    return { outcome, row: await loadUser(transaction, context.tenantId, membershipId) };
  });
  if (result.outcome.deactivated) await endSessionsIfNoBusinessLeft(result.row.user_id);
  return resource(result.row, baseUrl);
}

/** PATCH, in the two shapes directories send: `{ path: "active", value: false }` and `{ value: { active: false } }`. */
export async function patchUser(context: ScimContext, membershipId: string, operations: PatchOperation[], baseUrl: string): Promise<unknown> {
  const changes: Parameters<typeof applyChanges>[3] = {};
  const apply = (path: string, value: unknown) => {
    switch (path.toLowerCase()) {
      case "active": {
        const parsed = looseBoolean.safeParse(value);
        if (!parsed.success) throw new ScimError(400, "Active must be true or false.", "invalidValue");
        changes.active = parsed.data;
        return;
      }
      case "externalid": changes.externalId = typeof value === "string" && value ? value.slice(0, 255) : null; return;
      case "displayname": case "name.formatted": if (typeof value === "string" && value.trim()) changes.name = value.trim().slice(0, 160); return;
      case "name.givenname": case "name.familyname": return;
      case "username": if (typeof value === "string") changes.userName = value.trim().toLowerCase(); return;
      default: return;
    }
  };
  for (const operation of operations) {
    if (operation.op === "remove") {
      if (operation.path?.toLowerCase() === "externalid") changes.externalId = null;
      continue;
    }
    if (operation.path) apply(operation.path, operation.value);
    else if (operation.value && typeof operation.value === "object") for (const [key, value] of Object.entries(operation.value)) apply(key, value);
  }
  const result = await withTenant(context.tenantId, async (transaction) => {
    const current = await loadUser(transaction, context.tenantId, membershipId);
    const outcome = await applyChanges(transaction, context, current, changes);
    return { outcome, row: await loadUser(transaction, context.tenantId, membershipId) };
  });
  if (result.outcome.deactivated) await endSessionsIfNoBusinessLeft(result.row.user_id);
  return resource(result.row, baseUrl);
}

/** DELETE deactivates. A directory removing someone never deletes their bookings, records or history. */
export async function removeUser(context: ScimContext, membershipId: string): Promise<void> {
  const result = await withTenant(context.tenantId, async (transaction) => {
    const current = await loadUser(transaction, context.tenantId, membershipId);
    if (!current.is_active) return { outcome: { deactivated: false }, userId: current.user_id };
    return { outcome: await applyChanges(transaction, context, current, { active: false }), userId: current.user_id };
  });
  if (result.outcome.deactivated) await endSessionsIfNoBusinessLeft(result.userId);
}
