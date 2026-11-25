import "server-only";

import { randomUUID } from "node:crypto";

import { TZDate } from "@date-fns/tz";
import { sql } from "drizzle-orm";

import { getDatabase, withTenant, type KalendrTransaction } from "@/db/client";
import { appointmentSeries, auditEvents, outboxEvents } from "@/db/schema";
import { SERIES_CONFIRMATION_EVENT, type SeriesPreview, type SeriesPreviewVisit, type SeriesResolution, type SeriesSaveResult, type SeriesView } from "@/lib/series-contracts";
import { expandRuleDates, parseStoredRule, ruleSummary, ruleText, type RepeatRule } from "@/lib/series-rule";
import { profileWords } from "@/lib/terminology";
import { ApiError, getPostgresErrorCode, mapDatabaseError } from "@/server/api-error";
import { assertLocationAllowed } from "@/server/location-scope";
import { insertStaffAppointment, loadBookingConfiguration } from "@/server/appointment-repository";
import { loadBusinessProfileIn } from "@/server/business-profile";
import { seriesScope } from "@/server/series-count";
import type { StaffBookingInput } from "@/server/contracts";
import { claimKey, finishKey } from "@/server/idempotent";
import type { SeriesSaveInput } from "@/server/series-contracts";
import { describeReason, explainDay } from "@/server/slot-engine/explain";
import { loadSlotInput } from "@/server/slot-engine/load";
import { offerableSlots } from "@/server/slot-engine/offerable-slots";
import { addDays, localDateOf, localInstant, MINUTE } from "@/server/slot-engine/time";
import { requirePermission, type StaffContext } from "@/server/staff-context";
import { currentTraceParent } from "@/server/tracing";

/**
 * Repeating appointments (feature 17). A series is a rule plus ordinary appointments that point back at it. Every visit is
 * booked through `insertStaffAppointment`, the same function a single desk booking uses, so the slot engine, the booking
 * limits, the customer cap and the audit trail apply to each one exactly as they would to one booking made by hand.
 * The whole series is saved in one transaction: if any visit fails, nothing is saved.
 */

export const SERIES_ROUTE = "/api/staff/series";


export interface PlannedVisit {
  index: number;
  date: string;
  startsAt: number;
  endsAt: number;
}

export interface SeriesSpec {
  tenantId: string;
  locationId: string;
  serviceId: string;
  practitionerId: string;
  durationMinutes: number;
  timezone: string;
}

/** A visit the database or the engine refused at commit. Thrown so the whole transaction rolls back. */
export class SeriesVisitFailure extends Error {
  constructor(readonly index: number, readonly code: string, message: string) {
    super(message);
    this.name = "SeriesVisitFailure";
  }
}

export function databaseUnavailable(): ApiError {
  return new ApiError(503, "database_unavailable", "Repeating appointments are not available right now.");
}

export async function locationZone(transaction: KalendrTransaction, tenantId: string, locationId: string): Promise<string> {
  const [row] = await transaction.execute<{ timezone: string }>(sql`
    select coalesce(location.timezone, tenant.timezone) as timezone
    from locations as location join tenants as tenant on tenant.id = location.tenant_id
    where location.tenant_id = ${tenantId} and location.id = ${locationId}
  `);
  if (!row) throw new ApiError(404, "location_not_found", "That place was not found.");
  return row.timezone;
}

/** The clock time (`HH:mm`) an instant reads at the place. */
export function clockOf(epoch: number, timezone: string): string {
  const zoned = new TZDate(epoch, timezone);
  return `${String(zoned.getHours()).padStart(2, "0")}:${String(zoned.getMinutes()).padStart(2, "0")}`;
}

/** The rule as dates, then as instants: each date is read on the place's own clock, so 10:00 stays 10:00 across a clock change. */
export function buildVisits(rule: RepeatRule, startsOn: string, time: string, timezone: string, durationMinutes: number): { visits: PlannedVisit[]; capped: boolean } {
  const { dates, capped } = expandRuleDates(rule, startsOn);
  return {
    visits: dates.map(({ index, date }) => {
      const startsAt = localInstant(date, time, timezone);
      return { index, date, startsAt, endsAt: startsAt + durationMinutes * MINUTE };
    }),
    capped,
  };
}

/**
 * Staff's answers applied to the list: a skipped visit is dropped, a moved one keeps its place in the rule but starts at the
 * chosen time. A move must stay on the same day, so a series never drifts to a date the rule did not produce.
 */
export function applyResolutions(visits: PlannedVisit[], resolutions: SeriesResolution[], timezone: string, durationMinutes: number): PlannedVisit[] {
  const byIndex = new Map(resolutions.map((entry) => [entry.index, entry]));
  for (const entry of resolutions) {
    if (!visits.some((visit) => visit.index === entry.index)) throw new ApiError(400, "validation_error", "One of the choices is for a visit that is not in this series.");
  }
  if (byIndex.size !== resolutions.length) throw new ApiError(400, "validation_error", "Each visit can have only one choice.");
  const result: PlannedVisit[] = [];
  for (const visit of visits) {
    const choice = byIndex.get(visit.index);
    if (!choice) { result.push(visit); continue; }
    if (choice.action === "skip") continue;
    const startsAt = new Date(choice.startsAt ?? "").getTime();
    if (!Number.isFinite(startsAt) || localDateOf(startsAt, timezone) !== visit.date) {
      throw new ApiError(400, "validation_error", "Choose another time on the same day.");
    }
    result.push({ ...visit, startsAt, endsAt: startsAt + durationMinutes * MINUTE });
  }
  return result.sort((a, b) => a.startsAt - b.startsAt);
}

const ALTERNATIVES_PER_DAY = 12;

/**
 * Checks every visit with the slot engine, read only. A visit is free when the engine would offer it; otherwise the reason
 * is the engine's own (the "why no slot" explanation for that day) and the same person's other free times that day are
 * offered. Visits are checked against what is booked now, not against each other, so the save checks again in order.
 */
export async function checkVisits(transaction: KalendrTransaction, spec: SeriesSpec, visits: PlannedVisit[]): Promise<SeriesPreviewVisit[]> {
  if (visits.length === 0) return [];
  const { tenantId, timezone } = spec;
  const loaded = await loadSlotInput(transaction, {
    tenantId,
    locationId: spec.locationId,
    serviceId: spec.serviceId,
    durationMinutes: spec.durationMinutes,
    practitionerId: spec.practitionerId,
    from: new Date(localInstant(visits[0]!.date, "00:00", timezone)),
    to: new Date(localInstant(addDays(visits[visits.length - 1]!.date, 1), "00:00", timezone)),
    mode: "standard",
  });
  const lengthOffered = loaded?.lengths.some((length) => length.minutes === spec.durationMinutes) ?? false;
  const offered = loaded && lengthOffered
    ? offerableSlots(loaded.input).filter((slot) => slot.practitionerId === spec.practitionerId)
    : [];
  const free = new Set(offered.map((slot) => slot.startsAt.getTime()));
  const byDay = new Map<string, Array<{ startsAt: number; endsAt: number }>>();
  for (const slot of offered) {
    const day = localDateOf(slot.startsAt.getTime(), timezone);
    byDay.set(day, [...(byDay.get(day) ?? []), { startsAt: slot.startsAt.getTime(), endsAt: slot.endsAt.getTime() }]);
  }

  const result: SeriesPreviewVisit[] = [];
  for (const visit of visits) {
    const base = { index: visit.index, date: visit.date, startsAt: new Date(visit.startsAt).toISOString(), endsAt: new Date(visit.endsAt).toISOString() };
    if (free.has(visit.startsAt)) { result.push({ ...base, state: "free", alternatives: [] }); continue; }
    const why = !loaded
      ? { reason: "person_does_not_offer", label: describeReason("person_does_not_offer") }
      : !lengthOffered
        ? { reason: "length_not_offered", label: "This is not offered for that length of time" }
        : await explainVisit(transaction, spec, visit);
    const alternatives = (byDay.get(visit.date) ?? [])
      .sort((a, b) => Math.abs(a.startsAt - visit.startsAt) - Math.abs(b.startsAt - visit.startsAt))
      .slice(0, ALTERNATIVES_PER_DAY)
      .sort((a, b) => a.startsAt - b.startsAt)
      .map((slot) => ({ startsAt: new Date(slot.startsAt).toISOString(), endsAt: new Date(slot.endsAt).toISOString() }));
    result.push({ ...base, state: "clash", reason: why.reason, reasonLabel: why.label, alternatives });
  }
  return result;
}

/** The engine's own reason for one start, read from its "why no slot" explanation of that day. */
async function explainVisit(transaction: KalendrTransaction, spec: SeriesSpec, visit: PlannedVisit): Promise<{ reason: string; label: string }> {
  try {
    const explained = await explainDay(transaction, spec.tenantId, {
      practitionerId: spec.practitionerId, serviceId: spec.serviceId, locationId: spec.locationId, date: visit.date, durationMinutes: spec.durationMinutes,
    });
    const clock = clockOf(visit.startsAt, spec.timezone);
    const step = explained.steps.filter((entry) => entry.time <= clock).at(-1);
    if (step?.reason) return { reason: step.reason, label: step.label };
  } catch (error: unknown) {
    if (!(error instanceof ApiError)) throw error;
  }
  return { reason: "not_available", label: "That time is not available" };
}

function previewOf(spec: SeriesSpec, rule: RepeatRule, startsOn: string, time: string, capped: boolean, visits: SeriesPreviewVisit[]): SeriesPreview {
  return {
    timezone: spec.timezone,
    startsOn,
    timeOfDay: time,
    ruleText: ruleText(rule, startsOn),
    visits,
    capped,
    freeCount: visits.filter((visit) => visit.state === "free").length,
    clashCount: visits.filter((visit) => visit.state === "clash").length,
  };
}

async function durationFor(transaction: KalendrTransaction, tenantId: string, booking: StaffBookingInput): Promise<number> {
  const configuration = await loadBookingConfiguration(transaction, tenantId, booking.locationId, booking.serviceId, booking.practitionerId, booking.newPatient ? "new" : "returning");
  if (!configuration) throw new ApiError(409, "slot_unavailable", "That time is no longer available. Please choose another slot.");
  return booking.durationMinutes ?? configuration.duration_minutes;
}

function assertSeriesBooking(context: StaffContext, booking: StaffBookingInput): void {
  requirePermission(context, "series.manage");
  assertLocationAllowed(context, booking.locationId);
  if (context.clinicSlug !== booking.clinicSlug || !context.userId) throw new ApiError(403, "forbidden", "You cannot book repeating appointments for this business.");
  if (booking.source === "walk_in") throw new ApiError(400, "validation_error", "A walk-in cannot repeat. Book a normal visit and repeat it from there.");
  if (context.preview) throw new ApiError(503, "unavailable_in_preview", "Repeating appointments are not available in the preview.");
}

/** What the rule would book, with every visit checked. Read only: nothing is saved. */
export async function previewSeries(context: StaffContext, booking: StaffBookingInput, rule: RepeatRule): Promise<SeriesPreview> {
  assertSeriesBooking(context, booking);
  return withTenant(context.tenantId, (transaction) => previewIn(transaction, context.tenantId, booking, rule));
}

async function previewIn(transaction: KalendrTransaction, tenantId: string, booking: StaffBookingInput, rule: RepeatRule, failure?: SeriesVisitFailure): Promise<SeriesPreview> {
  const timezone = await locationZone(transaction, tenantId, booking.locationId);
  const durationMinutes = await durationFor(transaction, tenantId, booking);
  const first = new Date(booking.startsAt).getTime();
  const startsOn = localDateOf(first, timezone);
  const time = clockOf(first, timezone);
  const spec: SeriesSpec = { tenantId, locationId: booking.locationId, serviceId: booking.serviceId, practitionerId: booking.practitionerId, durationMinutes, timezone };
  const { visits, capped } = buildVisits(rule, startsOn, time, timezone, durationMinutes);
  if (visits.length === 0) throw new ApiError(400, "validation_error", "That rule does not produce any visits. Check the end date.");
  const checked = await checkVisits(transaction, spec, visits);
  // A visit that failed at commit for a reason the preview cannot see (a limit used up by the series itself) is shown as a clash.
  const marked = failure
    ? checked.map((visit) => visit.index === failure.index && visit.state === "free" ? { ...visit, state: "clash" as const, reason: failure.code, reasonLabel: failure.message } : visit)
    : checked;
  return previewOf(spec, rule, startsOn, time, capped, marked);
}

/** Runs one serializable transaction, starting it again when the database asks (two changes at the same moment). */
export async function inSerializableTransaction<T>(tenantId: string, work: (transaction: KalendrTransaction) => Promise<T>): Promise<T> {
  const database = getDatabase();
  if (!database) throw databaseUnavailable();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await database.transaction(async (transaction) => {
        await transaction.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        return work(transaction);
      }, { isolationLevel: "serializable" });
    } catch (error: unknown) {
      const code = getPostgresErrorCode(error);
      if ((code === "40001" || code === "40P01") && attempt < 2) continue;
      throw error instanceof SeriesVisitFailure ? error : mapDatabaseError(error) ?? error;
    }
  }
}

/**
 * Books the visits in date order, each through the desk booking path. The customer is made once (with the first visit) and
 * reused for the rest. A visit that the engine or the database refuses throws a `SeriesVisitFailure` naming it.
 */
export async function bookVisits(
  transaction: KalendrTransaction,
  context: StaffContext,
  template: StaffBookingInput,
  seriesId: string,
  visits: PlannedVisit[],
  durationMinutes: number,
): Promise<{ appointmentIds: string[]; patientId: string }> {
  const { newPatient, patientId: existingPatientId, ...rest } = template;
  let patientId = existingPatientId;
  const appointmentIds: string[] = [];
  for (const visit of visits) {
    try {
      const booked = await insertStaffAppointment(transaction, context, {
        ...rest,
        startsAt: new Date(visit.startsAt).toISOString(),
        durationMinutes,
        source: "desk",
        ...(patientId ? { patientId } : { newPatient }),
      }, { seriesId, seriesIndex: visit.index });
      patientId = booked.patientId;
      appointmentIds.push(booked.appointmentId);
    } catch (error: unknown) {
      if (error instanceof ApiError && (error.status === 409 || error.status === 404)) throw new SeriesVisitFailure(visit.index, error.code, error.message);
      const code = getPostgresErrorCode(error);
      if (code === "23P01" || code === "23505") throw new SeriesVisitFailure(visit.index, "slot_unavailable", "That time was just taken.");
      throw error;
    }
  }
  if (!patientId) throw new ApiError(400, "validation_error", "Choose an existing person or enter a new one.");
  return { appointmentIds, patientId };
}

export type SeriesMessageKind = "booked" | "changed" | "cancelled";

/** Queues the one message for the whole series. The worker builds the dates from the visit ids, so no personal text is stored here. */
export async function queueSeriesMessage(
  transaction: KalendrTransaction,
  tenantId: string,
  seriesId: string,
  kind: SeriesMessageKind,
  appointmentIds: string[],
  version: number,
): Promise<void> {
  const first = appointmentIds[0];
  if (!first) return;
  await transaction.insert(outboxEvents).values({
    tenantId,
    aggregateType: "appointment",
    aggregateId: first,
    eventType: SERIES_CONFIRMATION_EVENT,
    payload: { appointmentId: first, seriesId, kind, appointmentIds, version },
    dedupeKey: `${SERIES_CONFIRMATION_EVENT}:${seriesId}:${kind}:${version}`,
    traceParent: currentTraceParent(),
  });
}

export async function writeSeriesAudit(
  transaction: KalendrTransaction,
  context: StaffContext,
  action: string,
  metadata: Record<string, string | number | boolean | null>,
  appointmentId?: string,
): Promise<void> {
  await transaction.insert(auditEvents).values({
    tenantId: context.tenantId,
    ...(appointmentId ? { appointmentId } : {}),
    actorUserId: context.userId,
    actorType: "staff",
    action,
    outcome: "success",
    // Ids, counts and fixed words only: never a name, a note or any free text.
    metadata,
  });
}

/** Books the whole series in one transaction. Returns the fresh list instead when a visit could not be saved. */
export async function saveSeries(context: StaffContext, input: SeriesSaveInput, idempotencyKey: string): Promise<SeriesSaveResult> {
  const { booking, rule } = input;
  assertSeriesBooking(context, booking);
  try {
    return await inSerializableTransaction(context.tenantId, async (transaction) => {
      const claim = await claimKey<SeriesSaveResult>(transaction, context.tenantId, SERIES_ROUTE, idempotencyKey, input);
      if ("replay" in claim) return claim.replay;
      const membership = await transaction.execute<{ authorized: boolean }>(sql`
        select exists (select 1 from memberships where tenant_id = ${context.tenantId} and user_id = ${context.userId} and is_active) as authorized
      `);
      if (!membership[0]?.authorized) {
        const t = profileWords(await loadBusinessProfileIn(transaction, context.tenantId));
        throw new ApiError(403, "forbidden", `This ${t.business} role cannot create ${t.appointments}.`);
      }

      const timezone = await locationZone(transaction, context.tenantId, booking.locationId);
      const durationMinutes = await durationFor(transaction, context.tenantId, booking);
      const first = new Date(booking.startsAt).getTime();
      const startsOn = localDateOf(first, timezone);
      const time = clockOf(first, timezone);
      const planned = buildVisits(rule, startsOn, time, timezone, durationMinutes);
      const visits = applyResolutions(planned.visits, input.resolutions, timezone, durationMinutes);
      if (visits.length === 0) throw new ApiError(400, "validation_error", "Nothing is left to book. Keep at least one visit.");

      // The visits point at the series before it exists (the key is checked at commit): a brand-new customer is made by the
      // first visit, and the series row needs their id.
      const seriesId = randomUUID();
      const booked = await bookVisits(transaction, context, booking, seriesId, visits, durationMinutes);
      await transaction.insert(appointmentSeries).values({
        id: seriesId,
        tenantId: context.tenantId,
        patientId: booked.patientId,
        serviceId: booking.serviceId,
        practitionerId: booking.practitionerId,
        locationId: booking.locationId,
        ruleText: ruleText(rule, startsOn),
        rule,
        startsOn,
        timeOfDay: time,
        durationMinutes,
        ...(rule.end.kind === "until" ? { untilOn: rule.end.date } : { occurrenceCount: rule.end.count }),
      });
      await writeSeriesAudit(transaction, context, "series.created", {
        seriesId, visits: booked.appointmentIds.length, skipped: planned.visits.length - visits.length,
      }, booked.appointmentIds[0]);
      await queueSeriesMessage(transaction, context.tenantId, seriesId, "booked", booked.appointmentIds, 1);

      const result: SeriesSaveResult = {
        saved: true, seriesId, visitCount: booked.appointmentIds.length, skippedCount: planned.visits.length - visits.length, appointmentIds: booked.appointmentIds,
      };
      await finishKey(transaction, claim.claimId, result);
      return result;
    });
  } catch (error: unknown) {
    if (!(error instanceof SeriesVisitFailure)) throw error;
    // Nothing was saved. Look again at what is free now, and show the visit that failed as a clash.
    const preview = await withTenant(context.tenantId, (transaction) => previewIn(transaction, context.tenantId, booking, rule, error));
    return { saved: false, preview };
  }
}

interface SeriesRow extends Record<string, unknown> {
  id: string;
  status: "active" | "ended" | "cancelled";
  version: number;
  patient_id: string;
  service_id: string;
  practitioner_id: string;
  location_id: string;
  timezone: string;
  rule: unknown;
  rule_text: string;
  starts_on: string;
  time_of_day: string;
  duration_minutes: number;
  continued_from_id: string | null;
  continued_by_id: string | null;
}

/** One series with every visit and its status, for the series screen. */
export async function getSeriesView(context: StaffContext, seriesId: string): Promise<SeriesView> {
  requirePermission(context, "appointments.book");
  if (context.preview) throw new ApiError(404, "series_not_found", "That repeating series was not found.");
  return withTenant(context.tenantId, async (transaction) => {
    // The same scope as the Repeating list: other locations (and, for a practitioner, other people's series) read as missing.
    const scope = await seriesScope(transaction, context);
    const [row] = await transaction.execute<SeriesRow>(sql`
      select series.id, series.status, series.version, series.patient_id, series.service_id, series.practitioner_id, series.location_id,
        coalesce(location.timezone, tenant.timezone) as timezone, series.rule, series.rule_text, series.starts_on::text as starts_on,
        series.time_of_day, series.duration_minutes, series.continued_from_id,
        (select next.id from appointment_series as next where next.tenant_id = series.tenant_id and next.continued_from_id = series.id limit 1) as continued_by_id
      from appointment_series as series
      join locations as location on location.tenant_id = series.tenant_id and location.id = series.location_id
      join tenants as tenant on tenant.id = series.tenant_id
      where series.tenant_id = ${context.tenantId} and series.id = ${seriesId} ${scope ? sql`and ${scope}` : sql``}
    `);
    const rule = row ? parseStoredRule(row.rule) : null;
    if (!row || !rule) throw new ApiError(404, "series_not_found", "That repeating series was not found.");
    const visits = await transaction.execute<{ id: string; series_index: number; starts_at: Date | string; ends_at: Date | string; status: string }>(sql`
      select id, series_index, starts_at, ends_at, status from appointments
      where tenant_id = ${context.tenantId} and series_id = ${seriesId}
      order by starts_at, series_index
    `);
    const t = profileWords(await loadBusinessProfileIn(transaction, context.tenantId));
    return {
      id: row.id, status: row.status, version: row.version, patientId: row.patient_id, serviceId: row.service_id,
      practitionerId: row.practitioner_id, locationId: row.location_id, timezone: row.timezone, rule, ruleText: row.rule_text,
      startsOn: row.starts_on, timeOfDay: row.time_of_day, durationMinutes: row.duration_minutes,
      summary: ruleSummary(rule, row.starts_on, row.time_of_day, { visit: t.visit, visits: t.visits }),
      continuedFromId: row.continued_from_id, continuedById: row.continued_by_id,
      visits: visits.map((visit) => ({
        appointmentId: visit.id, index: Number(visit.series_index), status: visit.status,
        startsAt: new Date(visit.starts_at).toISOString(), endsAt: new Date(visit.ends_at).toISOString(),
      })),
    };
  });
}
