import { keepFirstPerDay, limitReachedFor, limitsFilter, limitReasons, periodDetail } from "./limits";
import { adjacentStarts, candidateStarts, isBeyondWindow, isWithinNotice, reservedSpan } from "./service-rules";
import { localDateOf, MINUTE, overlaps } from "./time";
import type { Candidate, EngineContext, OfferedSlot, SlotEngineInput, SlotFilter, Span } from "./types";
import { workingDays } from "./working-hours";

/**
 * The one place every slot rule is applied. The public page, the staff openings list, a
 * reschedule check and the booking commit all call `offerableSlots`; the commit runs it again
 * inside its transaction, so a slot offered a minute ago and no longer allowed is refused there.
 *
 * Adding a rule means adding a filter to `slotFilters`. A filter says why it removed a start
 * (a stable code), which is what `explain.ts` shows staff when a slot is missing.
 */

const walkIn = { earliest: -15 * MINUTE, latest: 12 * 60 * MINUTE };

/** Reason codes. Messages for them live in `explain.ts`. */
export const reasons = {
  walkInTimeframe: "walk_in_timeframe",
  notice: "within_minimum_notice",
  window: "beyond_booking_window",
  personBusy: "already_booked",
  noResource: "no_free_resource",
  calendarBusy: "busy_in_calendar",
} as const;

function overlapsAny(span: Span, others: Span[]): boolean {
  return others.some((other) => overlaps(span, other));
}

const timeframeFilter: SlotFilter = {
  id: "timeframe",
  reject(candidate, { input, openDays }) {
    const now = input.now.getTime();
    if (input.mode === "walk_in") {
      const offset = candidate.start - now;
      return offset < walkIn.earliest || offset > walkIn.latest ? { reason: reasons.walkInTimeframe } : null;
    }
    if (input.mode === "existing") return null;
    if (isWithinNotice(candidate.start, now, input.service)) return { reason: reasons.notice };
    if (isBeyondWindow(candidate.start, now, input.service.window, input.timezone, openDays)) return { reason: reasons.window };
    return null;
  },
};

function within(span: Span, ranges: Span[]): boolean {
  return ranges.some((range) => range.start <= span.start && range.end >= span.end);
}

/** A start must sit inside the day's hours once holidays, time away, blocked time and the restriction are taken out. */
const hoursFilter: SlotFilter = {
  id: "hours",
  reject(candidate) {
    const day = candidate.day;
    if (!day) return null;
    const reserved = { start: candidate.reservedStart, end: candidate.reservedEnd };
    if (within(reserved, day.final)) return null;
    // Say which step took the time: the first one after which the start no longer fits.
    const step = day.steps.find((entry) => !within(reserved, entry.after));
    const cut = step?.removed.find((removed) => overlaps(removed.span, reserved));
    return { reason: step?.reason ?? "outside_hours", ...(cut?.detail ? { detail: cut.detail } : {}) };
  },
};

const busyFilter: SlotFilter = {
  id: "busy",
  reject(candidate, { people }) {
    const person = people.get(candidate.practitionerId);
    if (!person) return { reason: reasons.personBusy };
    const reserved = { start: candidate.reservedStart, end: candidate.reservedEnd };
    return overlapsAny(reserved, person.busy) ? { reason: reasons.personBusy } : null;
  },
};

const calendarBusyFilter: SlotFilter = {
  id: "calendar_busy",
  reject(candidate, { people }) {
    const busy = people.get(candidate.practitionerId)?.calendarBusy;
    if (!busy?.length) return null;
    return overlapsAny({ start: candidate.reservedStart, end: candidate.reservedEnd }, busy) ? { reason: reasons.calendarBusy } : null;
  },
};

const resourceFilter: SlotFilter = {
  id: "resource",
  reject(candidate, context) {
    const { input } = context;
    if (!input.service.requiresResource) return null;
    const reserved = { start: candidate.reservedStart, end: candidate.reservedEnd };
    // A room whose own limit is used up for that day is not free either.
    const free = input.resources.find((resource) => !overlapsAny(reserved, resource.busy)
      && !limitReachedFor(context, { practitionerId: candidate.practitionerId, start: candidate.start, end: candidate.end, resourceId: resource.id }, { onlyResource: true }));
    if (!free) {
      const capped = input.resources.some((resource) => !overlapsAny(reserved, resource.busy));
      if (!capped) return { reason: reasons.noResource };
      const hit = input.resources.map((resource) => limitReachedFor(context, { practitionerId: candidate.practitionerId, start: candidate.start, end: candidate.end, resourceId: resource.id }, { onlyResource: true })).find((entry) => entry !== null);
      return hit ? { reason: hit.rule.period === "day" ? limitReasons.day : limitReasons.other, detail: periodDetail(hit) } : { reason: reasons.noResource };
    }
    candidate.resourceId = free.id;
    return null;
  },
};

/** In order. Cheap filters first. Features 38 (limits), 41 (holds) and 16 (calendar busy time) add theirs here. */
export const slotFilters: SlotFilter[] = [hoursFilter, timeframeFilter, busyFilter, calendarBusyFilter, resourceFilter, limitsFilter];

/** The days the business works, in the location's timezone, from today to the end of the range. */
export function openDaysFor(input: SlotEngineInput): string[] {
  const now = input.now.getTime();
  const from = Math.min(now, input.from.getTime());
  const days = new Set<string>();
  for (const person of input.people) {
    for (const day of workingDays(input, person, from, input.to.getTime())) {
      for (const span of day.final) days.add(localDateOf(span.start, input.timezone));
    }
  }
  return [...days].sort();
}

export function buildContext(input: SlotEngineInput): EngineContext {
  const openDays = input.service.window.kind === "business_days" ? openDaysFor(input) : [];
  return { input, people: new Map(input.people.map((person) => [person.id, person])), openDays };
}

/** Every start the working hours allow, before any rule removes one. */
export function candidatesFor(input: SlotEngineInput): Candidate[] {
  const from = input.from.getTime();
  const to = input.to.getTime();
  const candidates = new Map<string, Candidate>();
  for (const person of input.people) {
    if (!person.candidate) continue;
    for (const day of workingDays(input, person, from, to)) {
      for (const range of day.shape) {
        const grid = candidateStarts(range, input.service);
        // Optimized slots: starts that touch an existing booking join the grid; every filter still applies to them.
        const starts = input.service.optimizedSlots && input.mode === "standard" ? [...grid, ...adjacentStarts(range, person.busy, input.service)] : grid;
        for (const start of starts) {
          const end = start + input.service.durationMinutes * MINUTE;
          if (start < from || end > to) continue;
          if (person.candidateWithin && !person.candidateWithin.some((span) => start >= span.start && end <= span.end)) continue;
          const reserved = reservedSpan(start, input.service);
          const key = `${person.id}:${start}`;
          if (candidates.has(key)) continue;
          candidates.set(key, { practitionerId: person.id, start, end, reservedStart: reserved.start, reservedEnd: reserved.end, resourceId: null, day });
        }
      }
    }
  }
  return [...candidates.values()].sort((a, b) => a.start - b.start || a.practitionerId.localeCompare(b.practitionerId));
}

const limitReasonCodes: string[] = [limitReasons.day, limitReasons.other];

export interface SlotAnalysis {
  slots: OfferedSlot[];
  /** Local dates (`YYYY-MM-DD`) where a limit, and nothing else, took every start. They show as full, not as closed. */
  fullDays: string[];
}

/** Applies every rule and also notes which days a limit emptied, so the page can say "full". */
export function analyseSlots(input: SlotEngineInput): SlotAnalysis {
  const context = buildContext(input);
  const offered: OfferedSlot[] = [];
  const limited = new Set<string>();
  for (const candidate of candidatesFor(input)) {
    let rejection: { reason: string; detail?: string } | null = null;
    for (const filter of slotFilters) {
      rejection = filter.reject(candidate, context);
      if (rejection) break;
    }
    if (rejection) {
      if (limitReasonCodes.includes(rejection.reason)) limited.add(localDateOf(candidate.start, input.timezone));
      continue;
    }
    offered.push({
      practitionerId: candidate.practitionerId,
      startsAt: new Date(candidate.start),
      endsAt: new Date(candidate.end),
      resourceId: candidate.resourceId,
    });
  }
  const slots = input.service.firstSlotOnly && input.mode === "standard" ? keepFirstPerDay(offered, input.timezone) : offered;
  const open = new Set(slots.map((slot) => localDateOf(slot.startsAt.getTime(), input.timezone)));
  return { slots, fullDays: [...limited].filter((date) => !open.has(date)).sort() };
}

export function offerableSlots(input: SlotEngineInput): OfferedSlot[] {
  return analyseSlots(input).slots;
}
