import { sql, type SQL } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import { countedStatusesFor, type LimitPeriod } from "@/lib/booking-limits";

import { periodBounds } from "./limits";
import { addDays, localDateOf, localInstant } from "./time";
import type { LimitRuleInput, LimitUsageInput } from "./types";

/**
 * Reads the limits that can touch one service and what they already hold. One grouped query per
 * limit returns bookings per local day; `limits.ts` adds days up into periods.
 */

export interface LimitQuery {
  tenantId: string;
  serviceId: string;
  locationId: string;
  personIds: string[];
  resourceIds: string[];
  timezone: string;
  from: Date;
  to: Date;
  /** A visit being moved does not count against its own new time. */
  excludeAppointmentId?: string | null;
}

interface RuleRow extends Record<string, unknown> {
  id: string;
  scope: LimitRuleInput["scope"];
  service_id: string | null;
  practitioner_id: string | null;
  location_id: string | null;
  resource_id: string | null;
  team_id: string | null;
  measure: LimitRuleInput["measure"];
  period: LimitPeriod;
  max_value: number;
  week_start: number;
}

function inList(ids: string[]): SQL {
  return ids.length === 0 ? sql`null` : sql.join(ids.map((id) => sql`${id}`), sql`, `);
}

/** The scope's own filter on the bookings table (`appointment`). */
function scopeFilter(rule: LimitRuleInput): SQL {
  switch (rule.scope) {
    case "service": return sql`appointment.service_id = ${rule.scopeId}`;
    case "practitioner": return sql`appointment.practitioner_id = ${rule.scopeId}`;
    case "location": return sql`appointment.location_id = ${rule.scopeId}`;
    case "team": return sql`appointment.practitioner_id in (${inList(rule.memberIds)})`;
    case "resource": return sql`exists (
      select 1 from resource_reservations as reservation
      where reservation.tenant_id = appointment.tenant_id and reservation.appointment_id = appointment.id
        and reservation.resource_id = ${rule.scopeId} and reservation.state <> 'released')`;
  }
}

export async function loadLimits(transaction: KalendrTransaction, query: LimitQuery): Promise<{ limits: LimitRuleInput[]; usage: LimitUsageInput[] }> {
  const rows = await transaction.execute<RuleRow>(sql`
    select id, scope, service_id, practitioner_id, location_id, resource_id, team_id, measure, period, max_value, week_start
    from booking_limits
    where tenant_id = ${query.tenantId}
      and ((scope = 'service' and service_id = ${query.serviceId})
        or (scope = 'practitioner' and practitioner_id in (${inList(query.personIds)}))
        or (scope = 'location' and location_id = ${query.locationId})
        or (scope = 'resource' and resource_id in (${inList(query.resourceIds)}))
        or (scope = 'team' and team_id in (select team_id from limit_team_members where tenant_id = ${query.tenantId} and practitioner_id in (${inList(query.personIds)}))))
    order by id
  `);
  if (rows.length === 0) return { limits: [], usage: [] };

  const teamIds = [...new Set(rows.flatMap((row) => row.team_id ?? []))];
  const members = teamIds.length === 0 ? [] : await transaction.execute<{ team_id: string; practitioner_id: string }>(sql`
    select team_id, practitioner_id from limit_team_members where tenant_id = ${query.tenantId} and team_id in (${inList(teamIds)})
  `);
  const limits: LimitRuleInput[] = rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    scopeId: row.service_id ?? row.practitioner_id ?? row.location_id ?? row.resource_id ?? row.team_id,
    memberIds: row.team_id ? members.filter((member) => member.team_id === row.team_id).map((member) => member.practitioner_id) : [],
    measure: row.measure,
    period: row.period,
    maxValue: row.max_value,
    weekStart: row.week_start === 7 ? 7 : 1,
  }));

  const statuses = countedStatusesFor({ requestedHoldsSlot: true });
  const firstDate = localDateOf(query.from.getTime(), query.timezone);
  const lastDate = localDateOf(Math.max(query.from.getTime(), query.to.getTime() - 1), query.timezone);
  const exclude = query.excludeAppointmentId ?? null;
  const usage: LimitUsageInput[] = [];
  for (const rule of limits) {
    const start = localInstant(periodBounds(firstDate, rule.period, rule.weekStart).first, "00:00", query.timezone);
    const end = localInstant(addDays(periodBounds(lastDate, rule.period, rule.weekStart).last, 1), "00:00", query.timezone);
    const days = await transaction.execute<{ day: string; booked: number; minutes: number }>(sql`
      select (appointment.starts_at at time zone ${query.timezone})::date::text as day,
        count(*)::int as booked,
        coalesce(sum(extract(epoch from (appointment.ends_at - appointment.starts_at)) / 60), 0)::int as minutes
      from appointments as appointment
      where appointment.tenant_id = ${query.tenantId}
        and appointment.status in (${sql.join(statuses.map((status) => sql`${status}::appointment_status`), sql`, `)})
        -- A request on a service that does not hold its slot takes no capacity until it is approved (feature 41).
        and (appointment.status <> 'requested' or exists (
          select 1 from services as held_service
          where held_service.tenant_id = appointment.tenant_id and held_service.id = appointment.service_id and held_service.requests_hold_slot
        ))
        and appointment.starts_at >= ${new Date(start).toISOString()}::timestamptz and appointment.starts_at < ${new Date(end).toISOString()}::timestamptz
        and (${exclude}::text is null or appointment.id <> ${exclude})
        and ${scopeFilter(rule)}
      group by 1
    `);
    usage.push({ ruleId: rule.id, days: days.map((row) => ({ date: row.day, count: row.booked, minutes: row.minutes })) });
  }
  return { limits, usage };
}
