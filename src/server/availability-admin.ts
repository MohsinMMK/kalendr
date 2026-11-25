import "server-only";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import type { KalendrTransaction } from "@/db/client";
import {
  auditEvents,
  availabilityOverrides,
  availabilityRules,
  availabilitySchedules,
  practitionerLocations,
  practitioners,
  services,
  tenants,
} from "@/db/schema";
import {
  scheduleCreateSchema,
  scheduleUpdateSchema,
  type Schedule,
  type WeeklyHours,
} from "@/lib/availability-setup";
import type { z } from "zod";

import { ApiError, getPostgresConstraint, getPostgresErrorCode } from "./api-error";
import { overlappingDays, rowsToWeekly, weeklyToRows } from "./availability-mapping";
import { claimKey, finishKey } from "./idempotent";
import { allowedLocationIds } from "./location-scope";
import { can, requirePermission, type StaffContext } from "./staff-context";
import { clinicDateKey } from "./staff-credentials";

/**
 * Named weekly schedules for one person. A schedule's weekly pattern is stored as one
 * `availability_rules` row per range per branch the person works at, in the schedule's timezone.
 */

export type { KalendrTransaction };

const weeklyEmpty = (): WeeklyHours => ({ "1": [], "2": [], "3": [], "4": [], "5": [], "6": [], "7": [] });

export function auditAvailability(
  transaction: KalendrTransaction,
  context: StaffContext,
  action: string,
  metadata: Record<string, unknown>,
) {
  // Ids, counts and group names only. Names, notes and times never go into the audit trail.
  return transaction.insert(auditEvents).values({
    tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action, outcome: "success", metadata,
  });
}

/** Runs `work` once per Idempotency-Key when one is sent; a repeat gets the first answer back. */
export async function withOptionalKey<T>(
  transaction: KalendrTransaction,
  context: StaffContext,
  route: string,
  key: string | null,
  request: unknown,
  work: () => Promise<T>,
): Promise<T> {
  if (!key) return work();
  const claim = await claimKey<T>(transaction, context.tenantId, route, key, request);
  if ("replay" in claim) return claim.replay;
  const result = await work();
  await finishKey(transaction, claim.claimId, result);
  return result;
}

export interface PersonAccess {
  id: string;
  authUserId: string | null;
}

/** A limited manager changes a doctor's profile, hours or locations only when every location the doctor works at is theirs. */
export async function requirePractitionerReach(transaction: KalendrTransaction, context: StaffContext, practitionerId: string): Promise<void> {
  const mine = allowedLocationIds(context);
  if (!mine) return;
  const rows = await transaction.select({ locationId: practitionerLocations.locationId }).from(practitionerLocations)
    .where(and(eq(practitionerLocations.tenantId, context.tenantId), eq(practitionerLocations.practitionerId, practitionerId)));
  if (rows.length === 0 || rows.some((row) => !mine.includes(row.locationId))) {
    throw new ApiError(403, "cannot_manage_location", "This person works at locations you don't, so only someone who works at all of them can change their profile.");
  }
}

/**
 * Anyone with hours.edit may change anyone's hours; hours.own lets a person change their own.
 * Reading is also open to schedule.read, so the desk can see why a time is missing.
 * Someone limited to some locations reaches only doctors at their locations: a write needs every one of the doctor's
 * locations to be theirs (403); a read needs the doctor to work at one of theirs, or nowhere in particular (404).
 */
export async function personAccess(
  transaction: KalendrTransaction,
  context: StaffContext,
  practitionerId: string,
  mode: "read" | "write",
): Promise<PersonAccess> {
  const [person] = await transaction
    .select({ id: practitioners.id, authUserId: practitioners.authUserId })
    .from(practitioners)
    .where(and(eq(practitioners.tenantId, context.tenantId), eq(practitioners.id, practitionerId)))
    .limit(1);
  if (!person) throw new ApiError(404, "practitioner_not_found", "Person not found.");
  const own = context.userId !== null && person.authUserId === context.userId;
  if (!own) await requireReach(transaction, context, practitionerId, mode);
  if (can(context, "hours.edit")) return person;
  if (own && can(context, "hours.own")) return person;
  if (mode === "read" && can(context, "schedule.read")) return person;
  requirePermission(context, own ? "hours.own" : "hours.edit");
  return person;
}

async function requireReach(transaction: KalendrTransaction, context: StaffContext, practitionerId: string, mode: "read" | "write"): Promise<void> {
  const mine = allowedLocationIds(context);
  if (!mine) return;
  if (mode === "write") return requirePractitionerReach(transaction, context, practitionerId);
  const theirs = await branchIdsOf(transaction, context.tenantId, practitionerId);
  if (theirs.length > 0 && !theirs.some((id) => mine.includes(id))) throw new ApiError(404, "practitioner_not_found", "Person not found.");
}

async function tenantTimezone(transaction: KalendrTransaction, tenantId: string): Promise<string> {
  const [tenant] = await transaction.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return tenant?.timezone || "Asia/Kolkata";
}

/** The person's default schedule, made on the spot with `timezone` when they have none. */
export async function ensureDefaultSchedule(
  transaction: KalendrTransaction,
  tenantId: string,
  practitionerId: string,
  timezone: string,
): Promise<{ id: string; timezone: string; version: number }> {
  const [existing] = await transaction
    .select({ id: availabilitySchedules.id, timezone: availabilitySchedules.timezone, version: availabilitySchedules.version })
    .from(availabilitySchedules)
    .where(and(eq(availabilitySchedules.tenantId, tenantId), eq(availabilitySchedules.practitionerId, practitionerId), eq(availabilitySchedules.isDefault, true)))
    .limit(1);
  if (existing) return existing;
  const [created] = await transaction.insert(availabilitySchedules)
    .values({ tenantId, practitionerId, name: "Working hours", timezone, isDefault: true })
    .returning({ id: availabilitySchedules.id, timezone: availabilitySchedules.timezone, version: availabilitySchedules.version });
  if (!created) throw new Error("Schedule insert returned no row");
  return created;
}

export async function branchIdsOf(transaction: KalendrTransaction, tenantId: string, practitionerId: string): Promise<string[]> {
  const rows = await transaction
    .select({ locationId: practitionerLocations.locationId })
    .from(practitionerLocations)
    .where(and(eq(practitionerLocations.tenantId, tenantId), eq(practitionerLocations.practitionerId, practitionerId)))
    .orderBy(asc(practitionerLocations.locationId));
  return rows.map((row) => row.locationId);
}

/** Replaces one schedule's rules with `weekly`, once per branch. The database also refuses overlaps. */
export async function replaceScheduleRules(
  transaction: KalendrTransaction,
  input: { tenantId: string; scheduleId: string; practitionerId: string; timezone: string; weekly: WeeklyHours; locationIds?: string[] },
): Promise<void> {
  const bad = overlappingDays(input.weekly);
  if (bad.length > 0) throw new ApiError(400, "hours_overlap", "Some times on the same day overlap. Change one so they sit one after the other.", { weekly: ["These times overlap."] });
  await transaction.delete(availabilityRules).where(and(eq(availabilityRules.tenantId, input.tenantId), eq(availabilityRules.scheduleId, input.scheduleId)));
  const rows = weeklyToRows(input.weekly);
  if (rows.length === 0) return;
  const locationIds = input.locationIds ?? await branchIdsOf(transaction, input.tenantId, input.practitionerId);
  if (locationIds.length === 0) throw new ApiError(400, "location_not_found", "Choose a place this person works at before setting hours.");
  const validFrom = clinicDateKey(input.timezone);
  try {
    await transaction.insert(availabilityRules).values(locationIds.flatMap((locationId) => rows.map((row) => ({
      tenantId: input.tenantId,
      locationId,
      practitionerId: input.practitionerId,
      scheduleId: input.scheduleId,
      dayOfWeek: row.dayOfWeek,
      startsAtLocal: row.startsAtLocal,
      endsAtLocal: row.endsAtLocal,
      timezone: input.timezone,
      validFrom,
      slotIntervalMinutes: 15,
    }))));
  } catch (error: unknown) {
    if (getPostgresErrorCode(error) === "23P01" && getPostgresConstraint(error) === "availability_rules_no_overlap") {
      throw new ApiError(400, "hours_overlap", "Some times on the same day overlap. Change one so they sit one after the other.", { weekly: ["These times overlap."] });
    }
    throw error;
  }
}

/** Keeps every schedule's ranges on exactly the branches the person works at. */
export async function syncRuleLocations(
  transaction: KalendrTransaction,
  tenantId: string,
  practitionerId: string,
  locationIds: string[],
): Promise<void> {
  const existing = await transaction.select().from(availabilityRules)
    .where(and(eq(availabilityRules.tenantId, tenantId), eq(availabilityRules.practitionerId, practitionerId)));
  const keep = new Set(locationIds);
  const removed = existing.filter((rule) => !keep.has(rule.locationId));
  if (removed.length > 0) {
    await transaction.delete(availabilityRules).where(and(
      eq(availabilityRules.tenantId, tenantId), eq(availabilityRules.practitionerId, practitionerId),
      inArray(availabilityRules.id, removed.map((rule) => rule.id)),
    ));
  }
  const kept = existing.filter((rule) => keep.has(rule.locationId));
  const added = locationIds.filter((locationId) => !kept.some((rule) => rule.locationId === locationId));
  if (added.length === 0 || kept.length === 0) return;
  // Copy one existing branch's ranges per schedule to each new branch.
  const templates = new Map<string, typeof kept>();
  for (const rule of kept) {
    const first = templates.get(rule.scheduleId)?.[0]?.locationId ?? rule.locationId;
    if (rule.locationId === first) templates.set(rule.scheduleId, [...(templates.get(rule.scheduleId) ?? []), rule]);
  }
  await transaction.insert(availabilityRules).values([...templates.values()].flatMap((rules) => added.flatMap((locationId) => rules.map((rule) => ({
    tenantId, locationId, practitionerId, scheduleId: rule.scheduleId, dayOfWeek: rule.dayOfWeek,
    startsAtLocal: rule.startsAtLocal, endsAtLocal: rule.endsAtLocal, timezone: rule.timezone,
    validFrom: rule.validFrom, validThrough: rule.validThrough, slotIntervalMinutes: rule.slotIntervalMinutes, isActive: rule.isActive,
  })))));
}

async function readSchedule(transaction: KalendrTransaction, tenantId: string, row: typeof availabilitySchedules.$inferSelect): Promise<Schedule> {
  const rules = await transaction
    .select({ dayOfWeek: availabilityRules.dayOfWeek, startsAtLocal: availabilityRules.startsAtLocal, endsAtLocal: availabilityRules.endsAtLocal })
    .from(availabilityRules)
    .where(and(eq(availabilityRules.tenantId, tenantId), eq(availabilityRules.scheduleId, row.id), eq(availabilityRules.isActive, true)));
  const overrides = await transaction
    .select({ date: availabilityOverrides.date, ranges: availabilityOverrides.ranges })
    .from(availabilityOverrides)
    .where(and(eq(availabilityOverrides.tenantId, tenantId), eq(availabilityOverrides.scheduleId, row.id)))
    .orderBy(asc(availabilityOverrides.date));
  return {
    id: row.id,
    practitionerId: row.practitionerId,
    name: row.name,
    timezone: row.timezone,
    isDefault: row.isDefault,
    version: row.version,
    weekly: rows(rules),
    overrides: overrides.map((override) => ({ date: override.date, ranges: override.ranges ?? null })),
  };
}

function rows(rules: Array<{ dayOfWeek: number; startsAtLocal: string; endsAtLocal: string }>): WeeklyHours {
  return rules.length === 0 ? weeklyEmpty() : rowsToWeekly(rules);
}

async function lockSchedule(transaction: KalendrTransaction, tenantId: string, scheduleId: string) {
  const [row] = await transaction.select().from(availabilitySchedules)
    .where(and(eq(availabilitySchedules.tenantId, tenantId), eq(availabilitySchedules.id, scheduleId)))
    .limit(1).for("update");
  if (!row) throw new ApiError(404, "schedule_not_found", "Schedule not found.");
  return row;
}

function versionConflict(): ApiError {
  return new ApiError(409, "version_conflict", "Someone else changed this schedule. Reload it and make your change again.");
}

function nameTaken(): ApiError {
  return new ApiError(409, "name_taken", "This person already has a schedule with that name. Choose another name.", { name: ["Choose another name."] });
}

export async function listSchedules(context: StaffContext, practitionerId: string): Promise<Schedule[]> {
  return withTenant(context.tenantId, async (transaction) => {
    await personAccess(transaction, context, practitionerId, "read");
    const found = await transaction.select().from(availabilitySchedules)
      .where(and(eq(availabilitySchedules.tenantId, context.tenantId), eq(availabilitySchedules.practitionerId, practitionerId)))
      .orderBy(asc(availabilitySchedules.createdAt));
    const schedules = await Promise.all(found.map((row) => readSchedule(transaction, context.tenantId, row)));
    return schedules.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  });
}

type CreateInput = z.infer<typeof scheduleCreateSchema>;

async function insertSchedule(
  transaction: KalendrTransaction,
  context: StaffContext,
  input: { practitionerId: string; name: string; timezone?: string | undefined; source?: Schedule | undefined },
): Promise<Schedule> {
  const [anyDefault] = await transaction.select({ id: availabilitySchedules.id }).from(availabilitySchedules)
    .where(and(eq(availabilitySchedules.tenantId, context.tenantId), eq(availabilitySchedules.practitionerId, input.practitionerId), eq(availabilitySchedules.isDefault, true))).limit(1);
  const timezone = input.timezone ?? input.source?.timezone ?? await tenantTimezone(transaction, context.tenantId);
  let created: typeof availabilitySchedules.$inferSelect | undefined;
  try {
    [created] = await transaction.insert(availabilitySchedules)
      .values({ tenantId: context.tenantId, practitionerId: input.practitionerId, name: input.name, timezone, isDefault: !anyDefault })
      .returning();
  } catch (error: unknown) {
    if (getPostgresErrorCode(error) === "23505") throw nameTaken();
    throw error;
  }
  if (!created) throw new Error("Schedule insert returned no row");
  if (input.source) {
    await replaceScheduleRules(transaction, { tenantId: context.tenantId, scheduleId: created.id, practitionerId: input.practitionerId, timezone, weekly: input.source.weekly });
    if (input.source.overrides.length > 0) {
      await transaction.insert(availabilityOverrides).values(input.source.overrides.map((override) => ({
        tenantId: context.tenantId, scheduleId: created.id, date: override.date, ranges: override.ranges,
      })));
    }
  }
  return readSchedule(transaction, context.tenantId, created);
}

export async function createSchedule(context: StaffContext, input: CreateInput, idempotencyKey: string | null = null): Promise<Schedule> {
  return withTenant(context.tenantId, (transaction) => withOptionalKey(transaction, context, "/api/staff/availability/schedules", idempotencyKey, input, async () => {
    await personAccess(transaction, context, input.practitionerId, "write");
    let source: Schedule | undefined;
    if (input.copyFromScheduleId) {
      const [row] = await transaction.select().from(availabilitySchedules)
        .where(and(eq(availabilitySchedules.tenantId, context.tenantId), eq(availabilitySchedules.id, input.copyFromScheduleId))).limit(1);
      if (!row) throw new ApiError(404, "schedule_not_found", "Schedule not found.");
      source = await readSchedule(transaction, context.tenantId, row);
    }
    const created = await insertSchedule(transaction, context, { practitionerId: input.practitionerId, name: input.name, timezone: input.timezone, source });
    await auditAvailability(transaction, context, "availability.schedule.created", { scheduleId: created.id, practitionerId: input.practitionerId, copied: Boolean(source) });
    return created;
  }));
}

export interface ScheduleChange {
  schedule: Schedule;
  /** True when the weekly pattern or timezone changed, so the route can move visits that no longer fit. */
  hoursChanged: boolean;
}

export async function updateSchedule(context: StaffContext, scheduleId: string, input: z.infer<typeof scheduleUpdateSchema>): Promise<ScheduleChange> {
  return withTenant(context.tenantId, async (transaction) => {
    const row = await lockSchedule(transaction, context.tenantId, scheduleId);
    await personAccess(transaction, context, row.practitionerId, "write");
    if (row.version !== input.expectedVersion) throw versionConflict();
    const changed: string[] = [];
    const timezone = input.timezone ?? row.timezone;
    if (input.name !== undefined && input.name !== row.name) changed.push("name");
    if (input.timezone !== undefined && input.timezone !== row.timezone) changed.push("timezone");
    if (input.isDefault && !row.isDefault) {
      await transaction.update(availabilitySchedules).set({ isDefault: false })
        .where(and(eq(availabilitySchedules.tenantId, context.tenantId), eq(availabilitySchedules.practitionerId, row.practitionerId), eq(availabilitySchedules.isDefault, true)));
      changed.push("default");
    }
    try {
      await transaction.update(availabilitySchedules).set({
        name: input.name ?? row.name,
        timezone,
        ...(input.isDefault ? { isDefault: true } : {}),
        version: row.version + 1,
        updatedAt: new Date(),
      }).where(and(eq(availabilitySchedules.tenantId, context.tenantId), eq(availabilitySchedules.id, scheduleId)));
    } catch (error: unknown) {
      if (getPostgresErrorCode(error) === "23505") throw nameTaken();
      throw error;
    }
    const isDefaultNow = input.isDefault ? true : row.isDefault;
    if (input.weekly) {
      if (isDefaultNow && weeklyToRows(input.weekly).length === 0) {
        throw new ApiError(400, "hours_required", "Set at least one working day on the main schedule.", { weekly: ["Set at least one working day."] });
      }
      await replaceScheduleRules(transaction, { tenantId: context.tenantId, scheduleId, practitionerId: row.practitionerId, timezone, weekly: input.weekly });
      changed.push("weekly");
    } else if (input.timezone !== undefined && input.timezone !== row.timezone) {
      // Same times, read in another timezone: the rules carry the zone too.
      await transaction.update(availabilityRules).set({ timezone, updatedAt: new Date() })
        .where(and(eq(availabilityRules.tenantId, context.tenantId), eq(availabilityRules.scheduleId, scheduleId)));
    }
    if (input.overrides?.length) {
      for (const override of input.overrides) {
        await transaction.insert(availabilityOverrides)
          .values({ tenantId: context.tenantId, scheduleId, date: override.date, ranges: override.ranges })
          .onConflictDoUpdate({ target: [availabilityOverrides.tenantId, availabilityOverrides.scheduleId, availabilityOverrides.date], set: { ranges: override.ranges } });
      }
      changed.push("overrides");
    }
    if (input.removeOverrideDates?.length) {
      await transaction.delete(availabilityOverrides).where(and(
        eq(availabilityOverrides.tenantId, context.tenantId), eq(availabilityOverrides.scheduleId, scheduleId),
        inArray(availabilityOverrides.date, input.removeOverrideDates),
      ));
      changed.push("overrides");
    }
    await auditAvailability(transaction, context, "availability.schedule.updated", { scheduleId, practitionerId: row.practitionerId, changed });
    const [fresh] = await transaction.select().from(availabilitySchedules).where(and(eq(availabilitySchedules.tenantId, context.tenantId), eq(availabilitySchedules.id, scheduleId))).limit(1);
    if (!fresh) throw new Error("Schedule vanished during update");
    return {
      schedule: await readSchedule(transaction, context.tenantId, fresh),
      hoursChanged: (changed.includes("weekly") || changed.includes("timezone") || changed.includes("default")) && (row.isDefault || Boolean(input.isDefault)),
    };
  });
}

export async function deleteSchedule(context: StaffContext, scheduleId: string): Promise<{ scheduleId: string }> {
  return withTenant(context.tenantId, async (transaction) => {
    const row = await lockSchedule(transaction, context.tenantId, scheduleId);
    await personAccess(transaction, context, row.practitionerId, "write");
    if (row.isDefault) throw new ApiError(409, "default_schedule", "This is the main schedule, so it can't be deleted. Make another schedule the main one first.");
    const [used] = await transaction.select({ id: services.id }).from(services)
      .where(and(eq(services.tenantId, context.tenantId), sql`(${services.scheduleId} = ${scheduleId} or ${services.restrictionScheduleId} = ${scheduleId})`)).limit(1);
    if (used) throw new ApiError(409, "schedule_in_use", "A service uses this schedule. Change that service first, then delete the schedule.");
    await transaction.delete(availabilitySchedules).where(and(eq(availabilitySchedules.tenantId, context.tenantId), eq(availabilitySchedules.id, scheduleId)));
    await auditAvailability(transaction, context, "availability.schedule.deleted", { scheduleId, practitionerId: row.practitionerId });
    return { scheduleId };
  });
}

/** Copies one schedule's times and dates to another person, as one of their schedules. */
export async function copyScheduleToPerson(
  context: StaffContext,
  scheduleId: string,
  input: { toPractitionerId: string; name?: string | undefined },
  idempotencyKey: string | null = null,
): Promise<Schedule> {
  return withTenant(context.tenantId, (transaction) => withOptionalKey(transaction, context, "/api/staff/availability/schedules/copy", idempotencyKey, { scheduleId, ...input }, async () => {
    const [source] = await transaction.select().from(availabilitySchedules)
      .where(and(eq(availabilitySchedules.tenantId, context.tenantId), eq(availabilitySchedules.id, scheduleId))).limit(1);
    if (!source) throw new ApiError(404, "schedule_not_found", "Schedule not found.");
    await personAccess(transaction, context, source.practitionerId, "read");
    await personAccess(transaction, context, input.toPractitionerId, "write");
    const loaded = await readSchedule(transaction, context.tenantId, source);
    const created = await insertSchedule(transaction, context, { practitionerId: input.toPractitionerId, name: input.name ?? source.name, source: loaded });
    await auditAvailability(transaction, context, "availability.schedule.copied", { fromScheduleId: scheduleId, scheduleId: created.id, practitionerId: input.toPractitionerId });
    return created;
  }));
}
