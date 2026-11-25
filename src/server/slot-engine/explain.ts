import { sql } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import { explainReasons, type ExplainBand, type ExplainQuery, type ExplainReason, type ExplainResult, type ExplainStep } from "@/lib/availability-setup";
import { TZDate } from "@date-fns/tz";
import { ApiError } from "@/server/api-error";

import { loadSlotInput } from "./load";
import { buildContext, candidatesFor, slotFilters } from "./offerable-slots";
import { addDays, localInstant, MINUTE, overlaps } from "./time";
import type { BusySpan, Candidate, Span } from "./types";
import { workingDays } from "./working-hours";

/**
 * "Why no slot?" It replays the slot engine's own rules for one person, service and date and,
 * for each 15 minutes of the day, names the first rule that took the start away. Read only:
 * it changes nothing and has no rule of its own, so it cannot disagree with what customers see.
 */

const STEP_MINUTES = 15;

function clock(epoch: number, timezone: string): string {
  const zoned = new TZDate(epoch, timezone);
  return `${String(zoned.getHours()).padStart(2, "0")}:${String(zoned.getMinutes()).padStart(2, "0")}`;
}

function within(span: Span, ranges: Span[]): boolean {
  return ranges.some((range) => range.start <= span.start && range.end >= span.end);
}

function label(reason: ExplainReason, detail: string | undefined): string {
  switch (reason) {
    case "outside_hours": return detail === "date_override" ? "Closed on this date" : "Outside working hours";
    case "holiday": return detail ? `Holiday: ${detail}` : "Holiday";
    case "out_of_office": return "Out of office";
    case "blocked_off": return "Time blocked off";
    case "outside_restriction": return "Outside the hours this service is limited to";
    case "already_booked": return "Already booked";
    case "buffer_after": return detail ? `Buffer after the ${detail} visit` : "Buffer after a visit";
    case "buffer_before": return detail ? `Buffer before the ${detail} visit` : "Buffer before a visit";
    case "within_minimum_notice": return "Too soon to book online";
    case "beyond_booking_window": return "Beyond the booking window";
    case "no_free_resource": return "No free room";
    case "person_does_not_offer": return "Does not offer this here";
    case "not_a_start_time": return "Not a start time for this service";
    case "daily_limit_reached": return detail ? `Daily limit reached (${detail})` : "Daily limit reached";
    case "period_limit_reached": return detail ? `Limit reached (${detail})` : "Limit reached";
    case "busy_in_calendar": return "Busy in a connected calendar";
  }
}

/** The sentence for a reason code a slot filter returned, for screens that explain one time (feature 17's clash list). */
export function describeReason(reason: string, detail?: string): string {
  const known = explainReasons.find((code) => code === reason);
  return known ? label(known, detail) : "Not available at that time";
}

/** Tells a visit from its buffers when the busy span carries both. */
function busyReason(candidate: Candidate, busy: BusySpan[], timezone: string): { reason: ExplainReason; detail?: string } {
  const reserved = { start: candidate.reservedStart, end: candidate.reservedEnd };
  const hit = busy.find((span) => overlaps(reserved, span));
  if (!hit || hit.visitStart === undefined || hit.visitEnd === undefined) return { reason: "already_booked" };
  const visit = { start: hit.visitStart, end: hit.visitEnd };
  if (overlaps({ start: candidate.start, end: candidate.end }, visit)) return { reason: "already_booked" };
  const at = clock(hit.visitStart, timezone);
  // The start sits after the visit, inside its trailing buffer, or runs into the next visit's buffer.
  return candidate.start >= visit.end ? { reason: "buffer_after", detail: at } : { reason: "buffer_before", detail: at };
}

export async function explainDay(transaction: KalendrTransaction, tenantId: string, query: ExplainQuery, now: Date = new Date()): Promise<ExplainResult> {
  const [place] = await transaction.execute<{ timezone: string }>(sql`
    select timezone from locations where tenant_id = ${tenantId} and id = ${query.locationId}
  `);
  if (!place) throw new ApiError(404, "location_not_found", "Location not found.");
  const dayStart = localInstant(query.date, "00:00", place.timezone);
  const dayEnd = localInstant(addDays(query.date, 1), "00:00", place.timezone);

  const loaded = await loadSlotInput(transaction, {
    tenantId,
    locationId: query.locationId,
    serviceId: query.serviceId,
    ...(query.durationMinutes ? { durationMinutes: query.durationMinutes } : {}),
    practitionerId: query.practitionerId,
    // Starts near midnight need the neighbouring days' hours and bookings, so look a day either side.
    from: new Date(dayStart - 86_400_000),
    to: new Date(dayEnd + 86_400_000),
    mode: "standard",
    now,
  });
  if (!loaded) throw new ApiError(404, "service_not_found", "This service is not offered at this location.");
  const input = { ...loaded.input };
  const duration = input.service.durationMinutes;
  const person = input.people.find((entry) => entry.id === query.practitionerId);
  const steps: ExplainStep[] = [];
  const outOfOffice = person?.outOfOffice.find((entry) => entry.span.start < dayEnd && entry.span.end > dayStart && entry.note);

  const emit = (time: string, reason: ExplainReason | null, detail?: string) => steps.push({ time, reason, label: reason ? label(reason, detail) : "" });

  if (!person) {
    for (let at = dayStart; at < dayEnd; at += STEP_MINUTES * MINUTE) emit(clock(at, place.timezone), "person_does_not_offer");
  } else if (!person.schedule) {
    for (let at = dayStart; at < dayEnd; at += STEP_MINUTES * MINUTE) emit(clock(at, place.timezone), "outside_hours");
  } else {
    // Ranges after each step of the hours chain, joined across the days that reach this date.
    const days = workingDays(input, person, dayStart - 86_400_000, dayEnd + 86_400_000);
    const chain = days[0]?.steps.map((step, index) => ({
      reason: step.reason,
      after: days.flatMap((day) => day.steps[index]?.after ?? []),
      removed: days.flatMap((day) => day.steps[index]?.removed ?? []),
    })) ?? [];
    const context = buildContext(input);
    // The grid, so a free time that no slot starts at is not reported as offered.
    const grid = new Set(candidatesFor({ ...input, people: input.people.map((entry) => entry.id === person.id ? { ...entry, candidate: true, candidateWithin: undefined } : { ...entry, candidate: false }), from: new Date(dayStart - 86_400_000), to: new Date(dayEnd + 86_400_000) }).map((candidate) => candidate.start));
    const laterFilters = slotFilters.filter((filter) => filter.id !== "hours");

    for (let at = dayStart; at < dayEnd; at += STEP_MINUTES * MINUTE) {
      const candidate: Candidate = {
        practitionerId: person.id,
        start: at,
        end: at + duration * MINUTE,
        reservedStart: at - input.service.bufferBeforeMinutes * MINUTE,
        reservedEnd: at + (duration + input.service.bufferAfterMinutes) * MINUTE,
        resourceId: null,
      };
      const reserved = { start: candidate.reservedStart, end: candidate.reservedEnd };
      const time = clock(at, place.timezone);
      // A person with no working days at all has an empty chain: every time is outside their hours.
      const failed = chain.length === 0
        ? { reason: "outside_hours" as ExplainReason, removed: [] as Array<{ span: Span; detail?: string }> }
        : chain.find((step) => !within(reserved, step.after));
      if (failed) {
        const cut = failed.removed.find((removed) => overlaps(removed.span, reserved));
        emit(time, failed.reason, cut?.detail);
        continue;
      }
      let rejection: { reason: string; detail?: string } | null = null;
      for (const filter of laterFilters) {
        rejection = filter.reject(candidate, context);
        if (rejection) break;
      }
      if (rejection) {
        if (rejection.reason === "already_booked") {
          const refined = busyReason(candidate, person.busy, place.timezone);
          emit(time, refined.reason, refined.detail);
        } else {
          emit(time, rejection.reason as ExplainReason, rejection.detail);
        }
        continue;
      }
      emit(time, grid.has(at) ? null : "not_a_start_time");
    }
  }

  const bands: ExplainBand[] = [];
  for (const [index, step] of steps.entries()) {
    const last = bands[bands.length - 1];
    const to = steps[index + 1]?.time ?? "24:00";
    if (last && last.reason === step.reason && last.label === step.label) last.to = to;
    else bands.push({ from: step.time, to, reason: step.reason, label: step.label });
  }
  return { date: query.date, timezone: place.timezone, durationMinutes: duration, steps, bands, outOfOfficeNote: outOfOffice?.note ?? null };
}
