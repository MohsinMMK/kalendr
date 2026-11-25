import type { ExplainReason } from "@/lib/availability-setup";

import { addDays, DAY, datesBetween, isoWeekday, localDateOf, localInstant, mergeSpans } from "./time";
import type { PersonInput, ScheduleInput, SlotEngineInput, Span } from "./types";

/**
 * When one person works. For each local date a chain of small pure steps builds the day's
 * ranges, in this order: the schedule's weekly pattern, the date's override, public holiday,
 * out of office, blocked time, and last the restriction schedule. Travel is not a step: it
 * decides which timezone a date is read in (see `daysFor`). `explain.ts` replays the same
 * chain to say which step took a time away.
 */

export interface DayContext {
  person: PersonInput;
  schedule: ScheduleInput;
  /** `YYYY-MM-DD` on the wall clock of `timezone`. */
  date: string;
  timezone: string;
  holidays: ReadonlyMap<string, string>;
  restriction: ScheduleInput | null;
}

export interface RemovedSpan {
  span: Span;
  /** A holiday's name, or a short code for an override. */
  detail?: string;
}

export interface StepResult {
  ranges: Span[];
  /** What this step took away. */
  removed: RemovedSpan[];
}

export type StepId = "schedule" | "override" | "holiday" | "out_of_office" | "blocked_off" | "restriction";

export interface HoursStep {
  id: StepId;
  reason: ExplainReason;
  apply(ranges: Span[], day: DayContext): StepResult;
}

export function intersect(a: Span[], b: Span[]): Span[] {
  const out: Span[] = [];
  for (const left of a) {
    for (const right of b) {
      const start = Math.max(left.start, right.start);
      const end = Math.min(left.end, right.end);
      if (end > start) out.push({ start, end });
    }
  }
  return mergeSpans(out);
}

export function subtract(a: Span[], b: Span[]): { kept: Span[]; removed: Span[] } {
  const closed = mergeSpans(b);
  const kept: Span[] = [];
  for (const range of a) {
    let cursor = range.start;
    for (const cut of closed) {
      if (cut.end <= cursor || cut.start >= range.end) continue;
      if (cut.start > cursor) kept.push({ start: cursor, end: cut.start });
      cursor = Math.max(cursor, cut.end);
    }
    if (cursor < range.end) kept.push({ start: cursor, end: range.end });
  }
  return { kept, removed: intersect(a, closed) };
}

function rangesOn(date: string, ranges: Array<{ start: string; end: string }>, timezone: string): Span[] {
  return mergeSpans(ranges.flatMap((range) => {
    const start = localInstant(date, range.start, timezone);
    const end = localInstant(date, range.end, timezone);
    return end > start ? [{ start, end }] : [];
  }));
}

/** The weekly pattern of a schedule on one date, read in `timezone`. */
function weeklyOn(schedule: ScheduleInput, date: string, timezone: string): Span[] {
  const weekday = isoWeekday(date);
  const applicable = schedule.rules.filter((rule) =>
    rule.dayOfWeek === weekday && date >= rule.validFrom && (rule.validThrough === null || date <= rule.validThrough));
  return rangesOn(date, applicable.map((rule) => ({ start: rule.startsAtLocal, end: rule.endsAtLocal })), timezone);
}

/** A schedule's whole day on one date: its override when it has one, otherwise the weekly pattern. */
export function scheduleDay(schedule: ScheduleInput, date: string, timezone: string): Span[] {
  const override = schedule.overrides.find((entry) => entry.date === date);
  if (override) return override.ranges === null ? [] : rangesOn(date, override.ranges, timezone);
  return weeklyOn(schedule, date, timezone);
}

const scheduleStep: HoursStep = {
  id: "schedule",
  reason: "outside_hours",
  apply: (_ranges, day) => ({ ranges: weeklyOn(day.schedule, day.date, day.timezone), removed: [] }),
};

const overrideStep: HoursStep = {
  id: "override",
  reason: "outside_hours",
  apply(ranges, day) {
    const override = day.schedule.overrides.find((entry) => entry.date === day.date);
    if (!override) return { ranges, removed: [] };
    const replaced = override.ranges === null ? [] : rangesOn(day.date, override.ranges, day.timezone);
    // An override can also open time the weekly pattern did not have, so only the hours it takes away are "removed".
    return { ranges: replaced, removed: subtract(ranges, replaced).removed.map((span) => ({ span, detail: "date_override" })) };
  },
};

const holidayStep: HoursStep = {
  id: "holiday",
  reason: "holiday",
  apply(ranges, day) {
    const name = day.holidays.get(day.date);
    // A person can still work a holiday by giving that date its own hours.
    const worked = day.schedule.overrides.some((entry) => entry.date === day.date && entry.ranges !== null);
    if (name === undefined || worked) return { ranges, removed: [] };
    return { ranges: [], removed: ranges.map((span) => ({ span, detail: name })) };
  },
};

const outOfOfficeStep: HoursStep = {
  id: "out_of_office",
  reason: "out_of_office",
  apply(ranges, day) {
    const cut = subtract(ranges, day.person.outOfOffice.map((entry) => entry.span));
    return { ranges: cut.kept, removed: cut.removed.map((span) => ({ span })) };
  },
};

const blockedStep: HoursStep = {
  id: "blocked_off",
  reason: "blocked_off",
  apply(ranges, day) {
    const cut = subtract(ranges, day.person.blocks);
    return { ranges: cut.kept, removed: cut.removed.map((span) => ({ span })) };
  },
};

const restrictionStep: HoursStep = {
  id: "restriction",
  reason: "outside_restriction",
  apply(ranges, day) {
    if (!day.restriction) return { ranges, removed: [] };
    const zone = day.restriction.timezone;
    // The restriction is read on its own wall clock, so look a day either side of this date.
    const allowed = mergeSpans([-1, 0, 1].flatMap((offset) => scheduleDay(day.restriction!, addDays(localDateOf(localInstant(day.date, "12:00", day.timezone), zone), offset), zone)));
    return { ranges: intersect(ranges, allowed), removed: subtract(ranges, allowed).removed.map((span) => ({ span })) };
  },
};

/** In the order the rules apply. Later features add a step here and nowhere else. */
export const hoursSteps: HoursStep[] = [scheduleStep, overrideStep, holidayStep, outOfOfficeStep, blockedStep, restrictionStep];

/** The steps that decide what the day's grid is anchored to. The closures (holiday, away, blocked) cut into it later. */
const shapeSteps: ReadonlySet<StepId> = new Set<StepId>(["schedule", "override", "restriction"]);

export interface WorkingDay {
  date: string;
  timezone: string;
  /** The hours before holidays, time away and blocks. Slot starts are laid out from these. */
  shape: Span[];
  /** What is left once every step has run. */
  final: Span[];
  steps: Array<{ id: StepId; reason: ExplainReason; before: Span[]; after: Span[]; removed: RemovedSpan[] }>;
}

export function runHoursChain(context: DayContext, steps: HoursStep[] = hoursSteps): WorkingDay {
  let ranges: Span[] = [];
  let shape: Span[] = [];
  const trace: WorkingDay["steps"] = [];
  for (const step of steps) {
    const result = step.apply(ranges, context);
    trace.push({ id: step.id, reason: step.reason, before: ranges, after: result.ranges, removed: result.removed });
    ranges = result.ranges;
  }
  // The shape is the same chain without the closures.
  let anchor: Span[] = [];
  for (const step of steps) {
    if (shapeSteps.has(step.id)) anchor = step.apply(anchor, context).ranges;
  }
  shape = anchor;
  return { date: context.date, timezone: context.timezone, shape, final: ranges, steps: trace };
}

/** Which timezone each date is read in: the schedule's own, or a travel period's. */
export function daysFor(person: PersonInput, from: number, to: number): Array<{ date: string; timezone: string }> {
  const schedule = person.schedule;
  if (!schedule) return [];
  const home = schedule.timezone;
  const first = addDays(localDateOf(from, home), -2);
  const last = addDays(localDateOf(to, home), 2);
  const away = (date: string) => person.travel.some((period) => date >= period.from && date <= period.through);
  const days = datesBetween(first, last).filter((date) => !away(date)).map((date) => ({ date, timezone: home }));
  for (const period of person.travel) {
    const reachesRange = localInstant(period.through, "24:00", period.timezone) > from - 2 * DAY && localInstant(period.from, "00:00", period.timezone) < to + 2 * DAY;
    if (!reachesRange) continue;
    for (const date of datesBetween(period.from, period.through)) days.push({ date, timezone: period.timezone });
  }
  return days;
}

export function contextFor(input: Pick<SlotEngineInput, "holidays" | "restriction">, person: PersonInput, schedule: ScheduleInput, day: { date: string; timezone: string }): DayContext {
  return { person, schedule, date: day.date, timezone: day.timezone, holidays: new Map(input.holidays.map((holiday) => [holiday.date, holiday.name])), restriction: input.restriction };
}

/** Every working day of one person that could touch `from` to `to`. */
export function workingDays(input: Pick<SlotEngineInput, "holidays" | "restriction">, person: PersonInput, from: number, to: number): WorkingDay[] {
  const schedule = person.schedule;
  if (!schedule) return [];
  const holidays = new Map(input.holidays.map((holiday) => [holiday.date, holiday.name]));
  return daysFor(person, from, to)
    .map((day) => runHoursChain({ person, schedule, date: day.date, timezone: day.timezone, holidays, restriction: input.restriction }))
    .filter((day) => day.shape.length > 0 || day.final.length > 0);
}
