import type { LimitMeasure, LimitPeriod, LimitScope } from "@/lib/booking-limits";

import { addDays, isoWeekday, localDateOf, MINUTE } from "./time";
import type { Candidate, EngineContext, LimitRuleInput, LimitUsageInput, SlotFilter } from "./types";

/**
 * Booking limits (feature 38). Everything is counted on local dates in the business's timezone:
 * the database groups bookings by their local day, and these pure functions add the days up into
 * periods. The listing, the commit's recount and the lock key all use `periodBounds`, so they cannot
 * disagree about where a week or a month starts.
 */

export const limitReasons = { day: "daily_limit_reached", other: "period_limit_reached" } as const;

/** The first and last local date of the period that holds `date`. */
export function periodBounds(date: string, period: LimitPeriod, weekStart: 1 | 7): { first: string; last: string } {
  const [year = 0, month = 1] = date.split("-").map(Number);
  switch (period) {
    case "day":
      return { first: date, last: date };
    case "week": {
      const back = (isoWeekday(date) - weekStart + 7) % 7;
      const first = addDays(date, -back);
      return { first, last: addDays(first, 6) };
    }
    case "month": {
      const first = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
      const nextMonth = month === 12 ? `${String(year + 1).padStart(4, "0")}-01-01` : `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-01`;
      return { first, last: addDays(nextMonth, -1) };
    }
    case "year":
      return { first: `${String(year).padStart(4, "0")}-01-01`, last: `${String(year).padStart(4, "0")}-12-31` };
  }
}

/** A stable text key for the period, used for the advisory lock at commit. */
export function periodKey(ruleId: string, date: string, period: LimitPeriod, weekStart: 1 | 7): string {
  return `${ruleId}:${periodBounds(date, period, weekStart).first}`;
}

/** What the period already holds, from the per-day counts. */
export function usedInPeriod(usage: LimitUsageInput | undefined, bounds: { first: string; last: string }, measure: LimitMeasure): number {
  if (!usage) return 0;
  let total = 0;
  for (const day of usage.days) {
    if (day.date >= bounds.first && day.date <= bounds.last) total += measure === "count" ? day.count : day.minutes;
  }
  return total;
}

/** Does this rule cover the start being considered? Room limits are applied where the room is picked. */
export function ruleCovers(
  rule: Pick<LimitRuleInput, "scope" | "scopeId" | "memberIds">,
  facts: { serviceId?: string; locationId?: string; practitionerId: string; resourceId: string | null },
): boolean {
  const scope: LimitScope = rule.scope;
  switch (scope) {
    case "service": return facts.serviceId === rule.scopeId;
    case "practitioner": return facts.practitionerId === rule.scopeId;
    case "location": return facts.locationId === rule.scopeId;
    case "resource": return facts.resourceId !== null && facts.resourceId === rule.scopeId;
    case "team": return rule.memberIds.includes(facts.practitionerId);
  }
}

export interface LimitHit {
  rule: LimitRuleInput;
  used: number;
  added: number;
}

/** The first covering rule that this start would push past its maximum, or null. */
export function limitReachedFor(
  context: EngineContext,
  candidate: Pick<Candidate, "practitionerId" | "start" | "end" | "resourceId">,
  options: { onlyResource?: boolean; skipResource?: boolean } = {},
): LimitHit | null {
  const { input } = context;
  const rules = input.limits ?? [];
  if (rules.length === 0) return null;
  const date = localDateOf(candidate.start, input.timezone);
  const minutes = Math.round((candidate.end - candidate.start) / MINUTE);
  for (const rule of rules) {
    if (options.onlyResource && rule.scope !== "resource") continue;
    if (options.skipResource && rule.scope === "resource") continue;
    if (!ruleCovers(rule, { serviceId: input.serviceId, locationId: input.locationId, practitionerId: candidate.practitionerId, resourceId: candidate.resourceId })) continue;
    const used = usedInPeriod(input.usage?.find((entry) => entry.ruleId === rule.id), periodBounds(date, rule.period, rule.weekStart), rule.measure);
    const added = rule.measure === "count" ? 1 : minutes;
    if (used + added > rule.maxValue) return { rule, used, added };
  }
  return null;
}

/** "8 of 8", or "420 of 480 minutes" for a limit on booked time. */
export function describeUsage(hit: LimitHit): string {
  return hit.rule.measure === "count" ? `${hit.rule.maxValue} of ${hit.rule.maxValue}` : `${hit.used} of ${hit.rule.maxValue} minutes`;
}

export const limitsFilter: SlotFilter = {
  id: "limits",
  reject(candidate, context) {
    // Room limits are applied by the resource filter, which can try another room.
    const hit = limitReachedFor(context, candidate, { skipResource: true });
    if (!hit) return null;
    return { reason: hit.rule.period === "day" ? limitReasons.day : limitReasons.other, detail: periodDetail(hit) };
  },
};

export function periodDetail(hit: LimitHit): string {
  const usage = hit.rule.measure === "count" ? `${hit.used} of ${hit.rule.maxValue}` : `${hit.used} of ${hit.rule.maxValue} minutes`;
  return hit.rule.period === "day" ? usage : `${usage} this ${hit.rule.period}`;
}

/** The sentence a customer or receptionist sees when a limit stops a booking. */
export function limitSentence(reason: string): string | undefined {
  if (reason === limitReasons.day) return "That day is fully booked. Please choose another day.";
  if (reason === limitReasons.other) return "No more bookings can be taken for that period. Please choose a later date.";
  return undefined;
}

/** With "first slot only" on, each person keeps only their earliest free start of each local day. */
export function keepFirstPerDay<T extends { practitionerId: string; startsAt: Date }>(slots: T[], timezone: string): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const slot of [...slots].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())) {
    const key = `${slot.practitionerId}:${localDateOf(slot.startsAt.getTime(), timezone)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(slot);
  }
  return kept;
}
