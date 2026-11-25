import "server-only";

import { and, asc, eq, gte } from "drizzle-orm";
import type { z } from "zod";

import { withTenant } from "@/db/client";
import type { KalendrTransaction } from "@/db/client";
import { availabilitySchedules, holidaySettings, practitioners, tenants, timeOff, travelPeriods } from "@/db/schema";
import {
  holidaySettingsUpdateSchema,
  timeOffCreateSchema,
  timeOffUpdateSchema,
  travelPeriodCreateSchema,
  type ExplainQuery,
  type ExplainResult,
  type HolidayListing,
  type TimeOff,
  type TravelPeriod,
} from "@/lib/availability-setup";

import { ApiError, getPostgresConstraint, getPostgresErrorCode } from "./api-error";
import { auditAvailability, personAccess, withOptionalKey } from "./availability-admin";
import { instantsToWholeDays, wholeDaysToInstants } from "./availability-mapping";
import { holidayCountries, holidayRegions, listHolidays, suggestCountry } from "./slot-engine/holidays";
import { can, requirePermission, type StaffContext } from "./staff-context";
import { clinicDateKey } from "./staff-credentials";

/** Travel, out of office, public holidays and the "Why no slot?" answer. */

async function personZone(transaction: KalendrTransaction, tenantId: string, practitionerId: string): Promise<string> {
  const [schedule] = await transaction.select({ timezone: availabilitySchedules.timezone }).from(availabilitySchedules)
    .where(and(eq(availabilitySchedules.tenantId, tenantId), eq(availabilitySchedules.practitionerId, practitionerId), eq(availabilitySchedules.isDefault, true))).limit(1);
  if (schedule) return schedule.timezone;
  const [tenant] = await transaction.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return tenant?.timezone || "Asia/Kolkata";
}

// Travel ------------------------------------------------------------------------------------------

function toTravel(row: typeof travelPeriods.$inferSelect): TravelPeriod {
  return { id: row.id, practitionerId: row.practitionerId, startsOn: row.startsOn, endsOn: row.endsOn, timezone: row.timezone };
}

export async function listTravel(context: StaffContext, practitionerId: string): Promise<TravelPeriod[]> {
  return withTenant(context.tenantId, async (transaction) => {
    await personAccess(transaction, context, practitionerId, "read");
    const rows = await transaction.select().from(travelPeriods)
      .where(and(eq(travelPeriods.tenantId, context.tenantId), eq(travelPeriods.practitionerId, practitionerId)))
      .orderBy(asc(travelPeriods.startsOn));
    return rows.map(toTravel);
  });
}

export async function createTravel(context: StaffContext, input: z.infer<typeof travelPeriodCreateSchema>, idempotencyKey: string | null = null): Promise<TravelPeriod> {
  return withTenant(context.tenantId, (transaction) => withOptionalKey(transaction, context, "/api/staff/availability/travel", idempotencyKey, input, async () => {
    await personAccess(transaction, context, input.practitionerId, "write");
    try {
      const [row] = await transaction.insert(travelPeriods)
        .values({ tenantId: context.tenantId, practitionerId: input.practitionerId, startsOn: input.startsOn, endsOn: input.endsOn, timezone: input.timezone })
        .returning();
      if (!row) throw new Error("Travel insert returned no row");
      await auditAvailability(transaction, context, "availability.travel.created", { travelId: row.id, practitionerId: input.practitionerId });
      return toTravel(row);
    } catch (error: unknown) {
      if (getPostgresErrorCode(error) === "23P01" && getPostgresConstraint(error) === "travel_periods_no_overlap") {
        throw new ApiError(409, "travel_overlap", "This person already has a trip on some of those days. Change one of the trips so they don't overlap.", { startsOn: ["These days overlap another trip."] });
      }
      throw error;
    }
  }));
}

export async function deleteTravel(context: StaffContext, travelId: string): Promise<{ travelId: string }> {
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.select().from(travelPeriods).where(and(eq(travelPeriods.tenantId, context.tenantId), eq(travelPeriods.id, travelId))).limit(1);
    if (!row) throw new ApiError(404, "travel_not_found", "Trip not found.");
    await personAccess(transaction, context, row.practitionerId, "write");
    await transaction.delete(travelPeriods).where(and(eq(travelPeriods.tenantId, context.tenantId), eq(travelPeriods.id, travelId)));
    await auditAvailability(transaction, context, "availability.travel.deleted", { travelId, practitionerId: row.practitionerId });
    return { travelId };
  });
}

// Out of office -----------------------------------------------------------------------------------

async function toTimeOff(transaction: KalendrTransaction, tenantId: string, row: typeof timeOff.$inferSelect): Promise<TimeOff> {
  const zone = await personZone(transaction, tenantId, row.practitionerId);
  const days = instantsToWholeDays(row.startsAt, row.endsAt, zone);
  return {
    id: row.id, practitionerId: row.practitionerId, startsOn: days.startsOn, throughDate: days.throughDate,
    reason: row.reason as TimeOff["reason"], publicNote: row.publicNote, coverPractitionerId: row.coverPractitionerId, version: row.version,
  };
}

async function requireCover(transaction: KalendrTransaction, tenantId: string, coverId: string | null, practitionerId: string): Promise<void> {
  if (!coverId) return;
  if (coverId === practitionerId) throw new ApiError(400, "validation_error", "Choose someone else to cover.", { coverPractitionerId: ["Choose someone else to cover."] });
  const [cover] = await transaction.select({ id: practitioners.id }).from(practitioners)
    .where(and(eq(practitioners.tenantId, tenantId), eq(practitioners.id, coverId), eq(practitioners.isActive, true))).limit(1);
  if (!cover) throw new ApiError(400, "validation_error", "Choose a teammate who works here.", { coverPractitionerId: ["Choose a teammate who works here."] });
}

/** Out of office that has not ended yet, for one person or (with no id) everyone the caller may see. */
export async function listTimeOff(context: StaffContext, practitionerId: string | null): Promise<TimeOff[]> {
  return withTenant(context.tenantId, async (transaction) => {
    if (practitionerId) await personAccess(transaction, context, practitionerId, "read");
    else if (!can(context, "hours.edit") && !can(context, "schedule.read")) requirePermission(context, "hours.edit");
    const rows = await transaction.select().from(timeOff)
      .where(and(eq(timeOff.tenantId, context.tenantId), gte(timeOff.endsAt, new Date()), ...(practitionerId ? [eq(timeOff.practitionerId, practitionerId)] : [])))
      .orderBy(asc(timeOff.startsAt)).limit(300);
    return Promise.all(rows.map((row) => toTimeOff(transaction, context.tenantId, row)));
  });
}

export async function createTimeOff(context: StaffContext, input: z.infer<typeof timeOffCreateSchema>, idempotencyKey: string | null = null): Promise<TimeOff> {
  return withTenant(context.tenantId, (transaction) => withOptionalKey(transaction, context, "/api/staff/availability/time-off", idempotencyKey, input, async () => {
    await personAccess(transaction, context, input.practitionerId, "write");
    await requireCover(transaction, context.tenantId, input.coverPractitionerId, input.practitionerId);
    const { startsAt, endsAt } = wholeDaysToInstants(input.startsOn, input.throughDate, await personZone(transaction, context.tenantId, input.practitionerId));
    const [row] = await transaction.insert(timeOff).values({
      tenantId: context.tenantId, practitionerId: input.practitionerId, startsAt, endsAt, reason: input.reason,
      publicNote: input.publicNote || null, coverPractitionerId: input.coverPractitionerId,
    }).returning();
    if (!row) throw new Error("Time off insert returned no row");
    await auditAvailability(transaction, context, "availability.time_off.created", { timeOffId: row.id, practitionerId: input.practitionerId, reason: input.reason, covered: Boolean(input.coverPractitionerId) });
    return toTimeOff(transaction, context.tenantId, row);
  }));
}

export async function updateTimeOff(context: StaffContext, timeOffId: string, input: z.infer<typeof timeOffUpdateSchema>): Promise<TimeOff> {
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.select().from(timeOff).where(and(eq(timeOff.tenantId, context.tenantId), eq(timeOff.id, timeOffId))).limit(1).for("update");
    if (!row) throw new ApiError(404, "time_off_not_found", "Out of office not found.");
    await personAccess(transaction, context, row.practitionerId, "write");
    if (row.version !== input.expectedVersion) {
      throw new ApiError(409, "version_conflict", "Someone else changed this. Reload it and make your change again.");
    }
    const zone = await personZone(transaction, context.tenantId, row.practitionerId);
    const current = instantsToWholeDays(row.startsAt, row.endsAt, zone);
    const startsOn = input.startsOn ?? current.startsOn;
    const throughDate = input.throughDate ?? current.throughDate;
    if (throughDate < startsOn) throw new ApiError(400, "validation_error", "The last day must not be before the first.", { throughDate: ["The last day must not be before the first."] });
    const cover = input.coverPractitionerId === undefined ? row.coverPractitionerId : input.coverPractitionerId;
    await requireCover(transaction, context.tenantId, cover, row.practitionerId);
    const { startsAt, endsAt } = wholeDaysToInstants(startsOn, throughDate, zone);
    const [updated] = await transaction.update(timeOff).set({
      startsAt, endsAt,
      reason: input.reason ?? row.reason,
      publicNote: input.publicNote === undefined ? row.publicNote : input.publicNote || null,
      coverPractitionerId: cover,
      version: row.version + 1,
      updatedAt: new Date(),
    }).where(and(eq(timeOff.tenantId, context.tenantId), eq(timeOff.id, timeOffId))).returning();
    if (!updated) throw new Error("Time off update returned no row");
    await auditAvailability(transaction, context, "availability.time_off.updated", {
      timeOffId, practitionerId: row.practitionerId,
      changed: Object.keys(input).filter((key) => key !== "expectedVersion" && input[key as keyof typeof input] !== undefined),
    });
    return toTimeOff(transaction, context.tenantId, updated);
  });
}

export async function deleteTimeOff(context: StaffContext, timeOffId: string): Promise<{ timeOffId: string }> {
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.select().from(timeOff).where(and(eq(timeOff.tenantId, context.tenantId), eq(timeOff.id, timeOffId))).limit(1);
    if (!row) throw new ApiError(404, "time_off_not_found", "Out of office not found.");
    await personAccess(transaction, context, row.practitionerId, "write");
    await transaction.delete(timeOff).where(and(eq(timeOff.tenantId, context.tenantId), eq(timeOff.id, timeOffId)));
    await auditAvailability(transaction, context, "availability.time_off.deleted", { timeOffId, practitionerId: row.practitionerId });
    return { timeOffId };
  });
}

// Public holidays ---------------------------------------------------------------------------------

function nextYear(from: string): string {
  const [year = 0, month = 1, day = 1] = from.split("-").map(Number);
  return new Date(Date.UTC(year + 1, month - 1, day - 1)).toISOString().slice(0, 10);
}

async function buildListing(transaction: KalendrTransaction, tenantId: string): Promise<HolidayListing> {
  const [tenant] = await transaction.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const timezone = tenant?.timezone || "Asia/Kolkata";
  const [row] = await transaction.select().from(holidaySettings).where(eq(holidaySettings.tenantId, tenantId)).limit(1);
  const base = { suggestedCountry: suggestCountry(timezone), countries: holidayCountries() };
  if (!row) return { ...base, settings: null, regions: [], holidays: [], dataAvailable: true };
  const settings = { country: row.country, region: row.region, optedOut: row.optedOut, customDays: row.customDays, version: row.version };
  const from = clinicDateKey(timezone);
  const listing = listHolidays(settings, from, nextYear(from));
  return { ...base, settings, regions: holidayRegions(row.country), holidays: listing.items, dataAvailable: listing.ok };
}

export async function getHolidayListing(context: StaffContext): Promise<HolidayListing> {
  if (!can(context, "settings.manage") && !can(context, "hours.edit") && !can(context, "schedule.read")) requirePermission(context, "schedule.read");
  return withTenant(context.tenantId, (transaction) => buildListing(transaction, context.tenantId));
}

export async function saveHolidaySettings(context: StaffContext, input: z.infer<typeof holidaySettingsUpdateSchema>): Promise<HolidayListing> {
  requirePermission(context, "settings.manage");
  if (!holidayCountries().some((country) => country.code === input.country)) {
    throw new ApiError(400, "validation_error", "Choose a country from the list.", { country: ["Choose a country from the list."] });
  }
  if (input.region !== null && !holidayRegions(input.country).some((region) => region.code === input.region)) {
    throw new ApiError(400, "validation_error", "Choose a state or region from the list.", { region: ["Choose a state or region from the list."] });
  }
  return withTenant(context.tenantId, async (transaction) => {
    const [existing] = await transaction.select().from(holidaySettings).where(eq(holidaySettings.tenantId, context.tenantId)).limit(1).for("update");
    if (existing && existing.version !== input.expectedVersion) {
      throw new ApiError(409, "version_conflict", "Someone else changed the holiday settings. Reload and make your change again.");
    }
    const values = { country: input.country, region: input.region, optedOut: input.optedOut, customDays: input.customDays };
    if (existing) {
      await transaction.update(holidaySettings).set({ ...values, version: existing.version + 1, updatedAt: new Date() }).where(eq(holidaySettings.tenantId, context.tenantId));
    } else {
      await transaction.insert(holidaySettings).values({ tenantId: context.tenantId, ...values });
    }
    await auditAvailability(transaction, context, "availability.holidays.saved", {
      country: input.country, region: input.region,
      optedOutCount: Object.values(input.optedOut).reduce((sum, ids) => sum + ids.length, 0), customCount: input.customDays.length,
    });
    return buildListing(transaction, context.tenantId);
  });
}

// Why no slot -------------------------------------------------------------------------------------

export async function explainSlots(context: StaffContext, query: ExplainQuery): Promise<ExplainResult> {
  requirePermission(context, "schedule.read");
  // Loaded on use: the explainer replays the whole slot engine and is only needed by this one screen.
  const { explainDay } = await import("./slot-engine/explain");
  return withTenant(context.tenantId, (transaction) => explainDay(transaction, context.tenantId, query));
}
