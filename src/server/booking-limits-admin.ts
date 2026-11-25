import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";

import { withTenant } from "@/db/client";
import type { KalendrTransaction } from "@/db/client";
import { auditEvents, bookingLimits, limitTeamMembers, limitTeams, locations, practitioners, resources, services } from "@/db/schema";
import type { BookingLimit, BookingLimitsReplace, BookingLimitsView, LimitScope, ServiceCustomerRules } from "@/lib/booking-limits";

import { ApiError } from "./api-error";
import { requirePermission, type StaffContext } from "./staff-context";

/** Reads and saves booking limits (feature 38). Limits for a service, person, branch, room or team all go through here. */

function toLimit(row: typeof bookingLimits.$inferSelect): BookingLimit {
  const scopeId = row.serviceId ?? row.practitionerId ?? row.locationId ?? row.resourceId ?? row.teamId;
  return {
    id: row.id,
    scope: row.scope as LimitScope,
    scopeId: scopeId ?? "",
    measure: row.measure as BookingLimit["measure"],
    period: row.period as BookingLimit["period"],
    maxValue: row.maxValue,
    weekStart: row.weekStart === 7 ? 7 : 1,
  };
}

function ownerColumn(scope: LimitScope) {
  switch (scope) {
    case "service": return bookingLimits.serviceId;
    case "practitioner": return bookingLimits.practitionerId;
    case "location": return bookingLimits.locationId;
    case "resource": return bookingLimits.resourceId;
    case "team": return bookingLimits.teamId;
  }
}

async function assertOwnerExists(transaction: KalendrTransaction, tenantId: string, scope: LimitScope, scopeId: string): Promise<void> {
  const table = { service: services, practitioner: practitioners, location: locations, resource: resources, team: limitTeams }[scope];
  const [row] = await transaction.select({ id: table.id }).from(table).where(and(eq(table.tenantId, tenantId), eq(table.id, scopeId))).limit(1);
  if (!row) throw new ApiError(404, "limit_target_not_found", "That item could not be found. It may have been removed.");
}

async function serviceRulesOf(transaction: KalendrTransaction, tenantId: string, serviceId: string): Promise<ServiceCustomerRules | null> {
  const [row] = await transaction.select({
    maxActivePerCustomer: services.maxActivePerCustomer,
    offerRescheduleWhenCapped: services.offerRescheduleWhenCapped,
    firstSlotOnly: services.firstSlotOnly,
  }).from(services).where(and(eq(services.tenantId, tenantId), eq(services.id, serviceId))).limit(1);
  return row ?? null;
}

async function viewFor(transaction: KalendrTransaction, tenantId: string, scope: LimitScope, scopeId: string): Promise<BookingLimitsView> {
  const rows = await transaction.select().from(bookingLimits)
    .where(and(eq(bookingLimits.tenantId, tenantId), eq(bookingLimits.scope, scope), eq(ownerColumn(scope), scopeId)))
    .orderBy(asc(bookingLimits.period), asc(bookingLimits.measure));
  let team: BookingLimitsView["team"] = null;
  if (scope === "team") {
    const [row] = await transaction.select().from(limitTeams).where(and(eq(limitTeams.tenantId, tenantId), eq(limitTeams.id, scopeId))).limit(1);
    if (row) {
      const members = await transaction.select({ id: limitTeamMembers.practitionerId }).from(limitTeamMembers)
        .where(and(eq(limitTeamMembers.tenantId, tenantId), eq(limitTeamMembers.teamId, scopeId)));
      team = { id: row.id, name: row.name, memberIds: members.map((member) => member.id) };
    }
  }
  return {
    target: { scope, scopeId },
    team,
    limits: rows.map(toLimit),
    serviceRules: scope === "service" ? await serviceRulesOf(transaction, tenantId, scopeId) : null,
  };
}

export async function getBookingLimits(context: StaffContext, scope: LimitScope, scopeId: string): Promise<BookingLimitsView> {
  requirePermission(context, "settings.manage");
  return withTenant(context.tenantId, async (transaction) => {
    await assertOwnerExists(transaction, context.tenantId, scope, scopeId);
    return viewFor(transaction, context.tenantId, scope, scopeId);
  });
}

export async function listLimitTeams(context: StaffContext): Promise<BookingLimitsView[]> {
  requirePermission(context, "settings.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const teams = await transaction.select({ id: limitTeams.id }).from(limitTeams).where(eq(limitTeams.tenantId, context.tenantId)).orderBy(asc(limitTeams.name));
    return Promise.all(teams.map((team) => viewFor(transaction, context.tenantId, "team", team.id)));
  });
}

/** Saves the whole list of limits for one owner. Counts, ids and kinds go in the audit trail, never names. */
export async function replaceBookingLimits(context: StaffContext, input: BookingLimitsReplace): Promise<BookingLimitsView> {
  requirePermission(context, "settings.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const { scope } = input.target;
    let scopeId = input.target.scopeId;
    if (scope === "team") {
      const team = input.team;
      if (!team) throw new ApiError(400, "validation_error", "Pick the people in this team.", { team: ["Pick the people in this team."] });
      const unique = [...new Set(team.memberIds)];
      const found = await transaction.select({ id: practitioners.id }).from(practitioners)
        .where(and(eq(practitioners.tenantId, context.tenantId), inArray(practitioners.id, unique)));
      if (found.length !== unique.length) throw new ApiError(400, "validation_error", "One of the people you picked could not be found.", { "team.memberIds": ["Choose people from the list."] });
      if (scopeId) {
        await assertOwnerExists(transaction, context.tenantId, "team", scopeId);
        await transaction.update(limitTeams).set({ name: team.name }).where(and(eq(limitTeams.tenantId, context.tenantId), eq(limitTeams.id, scopeId)));
        await transaction.delete(limitTeamMembers).where(and(eq(limitTeamMembers.tenantId, context.tenantId), eq(limitTeamMembers.teamId, scopeId)));
      } else {
        const [created] = await transaction.insert(limitTeams).values({ tenantId: context.tenantId, name: team.name }).returning({ id: limitTeams.id });
        if (!created) throw new Error("Team insert returned no row");
        scopeId = created.id;
      }
      await transaction.insert(limitTeamMembers).values(unique.map((practitionerId) => ({ tenantId: context.tenantId, teamId: scopeId!, practitionerId })));
    } else {
      if (!scopeId) throw new ApiError(400, "validation_error", "Choose what this limit is for.");
      await assertOwnerExists(transaction, context.tenantId, scope, scopeId);
    }
    if (!scopeId) throw new Error("A limit target needs an id");

    await transaction.delete(bookingLimits).where(and(eq(bookingLimits.tenantId, context.tenantId), eq(bookingLimits.scope, scope), eq(ownerColumn(scope), scopeId)));
    if (input.limits.length > 0) {
      await transaction.insert(bookingLimits).values(input.limits.map((limit) => ({
        tenantId: context.tenantId,
        scope,
        ...(scope === "service" ? { serviceId: scopeId } : {}),
        ...(scope === "practitioner" ? { practitionerId: scopeId } : {}),
        ...(scope === "location" ? { locationId: scopeId } : {}),
        ...(scope === "resource" ? { resourceId: scopeId } : {}),
        ...(scope === "team" ? { teamId: scopeId } : {}),
        measure: limit.measure,
        period: limit.period,
        maxValue: limit.maxValue,
        weekStart: limit.weekStart,
      })));
    }
    if (scope === "service" && input.serviceRules) {
      await transaction.update(services).set({
        maxActivePerCustomer: input.serviceRules.maxActivePerCustomer,
        offerRescheduleWhenCapped: input.serviceRules.offerRescheduleWhenCapped,
        firstSlotOnly: input.serviceRules.firstSlotOnly,
        updatedAt: new Date(),
      }).where(and(eq(services.tenantId, context.tenantId), eq(services.id, scopeId)));
    }
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "booking_limits.replaced", outcome: "success",
      metadata: { scope, scopeId, count: input.limits.length, ...(input.serviceRules ? { customerCap: input.serviceRules.maxActivePerCustomer, firstSlotOnly: input.serviceRules.firstSlotOnly } : {}) },
    });
    return viewFor(transaction, context.tenantId, scope, scopeId);
  });
}

export async function deleteLimitTeam(context: StaffContext, teamId: string): Promise<{ teamId: string }> {
  requirePermission(context, "settings.manage");
  return withTenant(context.tenantId, async (transaction) => {
    await assertOwnerExists(transaction, context.tenantId, "team", teamId);
    await transaction.delete(limitTeams).where(and(eq(limitTeams.tenantId, context.tenantId), eq(limitTeams.id, teamId)));
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "booking_limits.team_deleted", outcome: "success", metadata: { teamId },
    });
    return { teamId };
  });
}
