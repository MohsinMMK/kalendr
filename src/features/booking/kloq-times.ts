import type { ConstraintSlot, KloqConstraints } from "@/components/kloq";
import type { TimeSlot } from "@/lib/domain";

import { zoneOffsetMinutes } from "@/lib/booking-page";

const MINUTE = 60_000;
const DAY = 86_400_000;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Minutes since midnight on the zone's wall clock, which is what Kloq's grid and `dayStartHour` count in. On a
 * daylight-saving day this differs from the time elapsed since midnight by the hour that was skipped or repeated.
 */
function wallMinutes(at: string, zone: string): number {
  const date = new Date(at);
  const local = date.getTime() + zoneOffsetMinutes(zone, date) * MINUTE;
  return Math.round((((local % DAY) + DAY) % DAY) / MINUTE);
}

/** The longest grid every start falls on, in the zone being shown: 60, 30, 20, 15, 10 or 5 minutes. One opening is one cell of it. */
export function cellMinutesFor(slots: readonly TimeSlot[], zone: string): number {
  let step = 60;
  for (const slot of slots) {
    const minute = wallMinutes(slot.startsAt, zone);
    step = gcd(step, minute % 60 === 0 ? 60 : minute % 60);
  }
  return Math.max(5, step);
}

/**
 * What Kloq's "Booking calendar" example calls `hostConstraints`: free time is the openings we were sent, and every
 * other part of the grid is refused (hatched, unclickable). An opening is one cell long, from its start.
 *
 * Kloq rounds a click to the nearest grid line, so the grid snaps to the minute and the rule looks only at where a
 * slot starts: a click anywhere in a free cell lands inside it, and is mapped back to the opening by `openingsAround`.
 */
export function openingConstraints(slots: readonly TimeSlot[], cellMinutes: number, minDate?: Date): KloqConstraints {
  const length = cellMinutes * MINUTE;
  const starts = [...new Set(slots.map((slot) => new Date(slot.startsAt).getTime()))].sort((a, b) => a - b);
  // Neighbouring cells merge into one run, so a long stretch of free time is one interval.
  const runs: Array<[number, number]> = [];
  for (const start of starts) {
    const last = runs[runs.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], start + length);
    else runs.push([start, start + length]);
  }
  return {
    minDate,
    isSlotDisabled: (slot: ConstraintSlot) => {
      if (slot.allDay) return true;
      const from = slot.start.getTime();
      let low = 0;
      let high = runs.length - 1;
      let found = -1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (runs[middle][0] <= from) {
          found = middle;
          low = middle + 1;
        } else high = middle - 1;
      }
      return found < 0 || from >= runs[found][1];
    },
  };
}

/** Everyone who is free to start in the cell that holds this instant. */
export function openingsAround(slots: readonly TimeSlot[], instant: number, cellMinutes: number): TimeSlot[] {
  const length = cellMinutes * MINUTE;
  const starts = slots.map((slot) => new Date(slot.startsAt).getTime()).filter((start) => start <= instant && instant < start + length);
  if (starts.length === 0) return [];
  const start = Math.max(...starts);
  return slots.filter((slot) => new Date(slot.startsAt).getTime() === start);
}

/** The hours Kloq should draw for these days: from the earliest opening's hour to the end of the latest visit. */
export function visibleHours(slots: readonly TimeSlot[], zone: string, cellMinutes = 60): { dayStartHour: number; dayEndHour: number } {
  if (slots.length === 0) return { dayStartHour: 9, dayEndHour: 17 };
  let first = 24 * 60;
  let last = 0;
  for (const slot of slots) {
    const start = wallMinutes(slot.startsAt, zone);
    first = Math.min(first, start);
    last = Math.max(last, start + (new Date(slot.endsAt).getTime() - new Date(slot.startsAt).getTime()) / MINUTE);
  }
  const dayStartHour = Math.max(0, Math.floor(first / 60));
  // Kloq keeps a click half an hour clear of the day's end, so short cells get one more hour to land in.
  const dayEndHour = Math.min(24, Math.max(Math.ceil(last / 60) + (cellMinutes < 30 ? 1 : 0), dayStartHour + 2));
  return { dayStartHour: Math.min(dayStartHour, 22), dayEndHour };
}
