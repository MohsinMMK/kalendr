import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { appointmentSeries, appointments, outboxEvents, resourceReservations } from "@/db/schema";
import type { SeriesChangeResult, SeriesPreview } from "@/lib/series-contracts";
import { isoWeekdayOf, parseStoredRule, ruleText, type RepeatRule } from "@/lib/series-rule";
import { ApiError } from "@/server/api-error";
import { canUseLocation } from "@/server/location-scope";
import type { StaffBookingInput } from "@/server/contracts";
import { claimKey, finishKey } from "@/server/idempotent";
import type { SeriesChangeInput, SeriesChangePreviewInput } from "@/server/series-contracts";
import {
  applyResolutions, bookVisits, buildVisits, checkVisits, clockOf, inSerializableTransaction, locationZone, queueSeriesMessage,
  SeriesVisitFailure, writeSeriesAudit, type SeriesSpec,
} from "@/server/series";
import { addDays, localDateOf } from "@/server/slot-engine/time";
import { requirePermission, type StaffContext } from "@/server/staff-context";
import { currentTraceParent } from "@/server/tracing";
import { drizzleRunner } from "@/server/workflows/runner";
import { planAppointment } from "@/server/workflows/engine";
import { offerFreedSlot } from "@/server/waitlist-hook";

/**
 * Changing or cancelling more than one visit of a series (feature 17). "This one" is an ordinary appointment change and
 * never comes here. "This and following" and "all" act only on visits that are still open: booked or requested and still
 * ahead. Completed, checked-in, no-show and already cancelled visits are never touched.
 *
 * A change ends the old series and starts a new one: the open visits are cancelled quietly (one message goes out for the
 * whole change, not one per visit), and the new list is booked again through the slot engine like a new series.
 */

interface SeriesRecord extends Record<string, unknown> {
  id: string;
  status: string;
  version: number;
  patient_id: string;
  service_id: string;
  practitioner_id: string;
  location_id: string;
  rule: unknown;
  starts_on: string;
  time_of_day: string;
  duration_minutes: number;
}

interface VisitRecord extends Record<string, unknown> {
  id: string;
  series_index: number;
  status: string;
  starts_at: Date | string;
  ends_at: Date | string;
  practitioner_id: string;
  service_id: string;
  location_id: string;
  patient_id: string;
  confirmation_status: string;
  version: number;
  reason_for_visit: string | null;
  notes: string | null;
  custom_fields: Record<string, unknown>;
}

interface Loaded {
  series: SeriesRecord;
  rule: RepeatRule;
  timezone: string;
  visits: VisitRecord[];
  /** Open visits the change acts on. */
  affected: VisitRecord[];
  /** The visit the person was looking at. */
  from: VisitRecord;
}

const OPEN = new Set(["requested", "booked"]);

function conflict(code: string, message: string): ApiError {
  return new ApiError(409, code, message);
}

async function loadForChange(
  transaction: KalendrTransaction, tenantId: string, seriesId: string,
  input: { scope: "following" | "all"; fromAppointmentId: string; expectedVersion: number }, now: Date,
  /** Whoever is asking; a series at a location they are not limited to reads as missing. */
  asker: Pick<StaffContext, "locationIds" | "role" | "tenantId" | "userId">,
): Promise<Loaded> {
  const [series] = await transaction.execute<SeriesRecord>(sql`
    select id, status, version, patient_id, service_id, practitioner_id, location_id, rule, starts_on::text as starts_on, time_of_day, duration_minutes
    from appointment_series where tenant_id = ${tenantId} and id = ${seriesId} for update
  `);
  const rule = series ? parseStoredRule(series.rule) : null;
  if (!series || !rule || !canUseLocation(asker, series.location_id)) throw new ApiError(404, "series_not_found", "That repeating series was not found.");
  // A practitioner given series.manage changes their own series only, the same rule as the Repeating list (seriesScope).
  if (asker.role === "practitioner") {
    const [own] = await transaction.execute<{ id: string }>(sql`select id from practitioners where tenant_id = ${tenantId} and auth_user_id = ${asker.userId} limit 1`);
    if (!own || own.id !== series.practitioner_id) throw new ApiError(404, "series_not_found", "That repeating series was not found.");
  }
  if (series.version !== input.expectedVersion) throw conflict("version_conflict", "This series was changed by someone else. Reload it and try again.");
  if (series.status !== "active") throw conflict("series_not_active", "This series has already ended or been cancelled.");
  const visits = await transaction.execute<VisitRecord>(sql`
    select id, series_index, status, starts_at, ends_at, practitioner_id, service_id, location_id, patient_id, confirmation_status, version,
      reason_for_visit, notes, custom_fields
    from appointments where tenant_id = ${tenantId} and series_id = ${seriesId}
    order by series_index for update
  `);
  const from = visits.find((visit) => visit.id === input.fromAppointmentId);
  if (!from) throw new ApiError(404, "appointment_not_found", "That visit is not part of this series.");
  const firstIndex = input.scope === "following" ? Number(from.series_index) : 0;
  const affected = visits.filter((visit) => Number(visit.series_index) >= firstIndex && OPEN.has(visit.status) && new Date(visit.starts_at).getTime() > now.getTime());
  return { series, rule, timezone: await locationZone(transaction, tenantId, series.location_id), visits, affected, from };
}

/** The same rule from a new first day: a weekly rule moves to the new weekday (every chosen weekday shifts the same amount). */
export function shiftRule(rule: RepeatRule, oldFirstDate: string, newStartsOn: string, count: number): RepeatRule {
  const delta = isoWeekdayOf(newStartsOn) - isoWeekdayOf(oldFirstDate);
  const weekdays = rule.frequency !== "weekly"
    ? []
    : (rule.weekdays.length > 0 ? rule.weekdays : [isoWeekdayOf(oldFirstDate)]).map((day) => ((day - 1 + delta) % 7 + 7) % 7 + 1);
  return { ...rule, weekdays: [...new Set(weekdays)].sort((a, b) => a - b), end: rule.end.kind === "count" ? { kind: "count", count: Math.min(Math.max(count, 1), 52) } : rule.end };
}

function templateFor(context: StaffContext, loaded: Loaded, practitionerId: string): StaffBookingInput {
  const { from, series } = loaded;
  return {
    clinicSlug: context.clinicSlug,
    locationId: series.location_id,
    serviceId: series.service_id,
    practitionerId,
    startsAt: new Date(from.starts_at).toISOString(),
    source: "desk",
    patientId: series.patient_id,
    ...(from.reason_for_visit ? { reasonForVisit: from.reason_for_visit } : {}),
    ...(from.notes ? { notes: from.notes } : {}),
    ...(Object.keys(from.custom_fields ?? {}).length > 0 ? { customFields: from.custom_fields as StaffBookingInput["customFields"] } : {}),
  };
}

function specFor(tenantId: string, loaded: Loaded, practitionerId: string, durationMinutes: number): SeriesSpec {
  return { tenantId, locationId: loaded.series.location_id, serviceId: loaded.series.service_id, practitionerId, durationMinutes, timezone: loaded.timezone };
}

/** Plans the new list for a change, from the new first start. */
function planChange(loaded: Loaded, input: SeriesChangePreviewInput) {
  const first = new Date(input.startsAt).getTime();
  if (!Number.isFinite(first)) throw new ApiError(400, "validation_error", "Choose a date and time.");
  const time = clockOf(first, loaded.timezone);
  const durationMinutes = input.durationMinutes ?? loaded.series.duration_minutes;
  const practitionerId = input.practitionerId ?? loaded.series.practitioner_id;
  // The new day is for the visit the person was looking at. The list starts at the first visit the change reaches, moved by
  // the same number of days, so "all" from visit 3 still starts where the series' first open visit was.
  const oldFirstDate = localDateOf(new Date(loaded.affected[0]?.starts_at ?? loaded.from.starts_at).getTime(), loaded.timezone);
  const clickedOldDate = localDateOf(new Date(loaded.from.starts_at).getTime(), loaded.timezone);
  const startsOn = addDays(oldFirstDate, daysBetween(clickedOldDate, localDateOf(first, loaded.timezone)));
  const rule = shiftRule(loaded.rule, oldFirstDate, startsOn, loaded.affected.length);
  if (rule.end.kind === "until" && rule.end.date < startsOn) throw new ApiError(400, "validation_error", "The new first day is after the end date of this series.");
  const { visits, capped } = buildVisits(rule, startsOn, time, loaded.timezone, durationMinutes);
  return { rule, startsOn, time, durationMinutes, practitionerId, visits, capped };
}

/** Whole calendar days from one `YYYY-MM-DD` to another (negative when it is earlier). */
function daysBetween(from: string, to: string): number {
  const at = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return Math.round((at(to) - at(from)) / 86_400_000);
}

class PreviewDone extends Error {
  constructor(readonly preview: SeriesPreview) { super("preview"); }
}

async function releaseReservations(transaction: KalendrTransaction, tenantId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await transaction.update(resourceReservations).set({ state: "released", updatedAt: new Date() })
    .where(and(eq(resourceReservations.tenantId, tenantId), inArray(resourceReservations.appointmentId, ids)));
}

/**
 * What a change would book, with every visit checked. The visits it would replace are let go inside the transaction first
 * (so they cannot block their own new times), and the transaction is then rolled back: nothing is saved.
 */
export async function previewSeriesChange(context: StaffContext, seriesId: string, input: SeriesChangePreviewInput): Promise<SeriesPreview> {
  requirePermission(context, "series.manage");
  if (context.preview) throw new ApiError(404, "series_not_found", "That repeating series was not found.");
  try {
    await withTenant(context.tenantId, async (transaction) => {
      const loaded = await loadForChange(transaction, context.tenantId, seriesId, input, new Date(), context);
      if (loaded.affected.length === 0) throw conflict("nothing_to_change", "Every visit from here on is already finished, checked in or cancelled.");
      await releaseReservations(transaction, context.tenantId, loaded.affected.map((visit) => visit.id));
      const plan = planChange(loaded, input);
      if (plan.visits.length === 0) throw new ApiError(400, "validation_error", "That rule does not produce any visits. Check the end date.");
      const spec = specFor(context.tenantId, loaded, plan.practitionerId, plan.durationMinutes);
      const checked = await checkVisits(transaction, spec, plan.visits);
      throw new PreviewDone({
        timezone: loaded.timezone, startsOn: plan.startsOn, timeOfDay: plan.time, ruleText: ruleText(plan.rule, plan.startsOn), visits: checked, capped: plan.capped,
        freeCount: checked.filter((visit) => visit.state === "free").length, clashCount: checked.filter((visit) => visit.state === "clash").length,
      });
    });
  } catch (error: unknown) {
    if (error instanceof PreviewDone) return error.preview;
    throw error;
  }
  throw new Error("Preview did not finish");
}

/** Cancels open visits without a message of their own: one message for the whole change goes out instead. */
async function cancelOpenVisits(transaction: KalendrTransaction, context: StaffContext, seriesId: string, rows: VisitRecord[], scope: string): Promise<void> {
  const run = drizzleRunner(transaction);
  await releaseReservations(transaction, context.tenantId, rows.map((row) => row.id));
  for (const row of rows) {
    const [updated] = await transaction.update(appointments).set({
      status: "cancelled",
      confirmationStatus: row.status === "requested" ? "declined" : undefined,
      cancelledAt: new Date(),
      version: row.version + 1,
      updatedAt: new Date(),
    }).where(and(eq(appointments.tenantId, context.tenantId), eq(appointments.id, row.id))).returning({ version: appointments.version });
    if (!updated) throw new Error("Appointment update did not return a row");
    await writeSeriesAudit(transaction, context, "appointment.status.cancelled", { version: updated.version, seriesId, scope }, row.id);
    // The row is still written, so the calendar write and any later handler see the cancel; `seriesBatch` stops the per-visit message.
    await transaction.insert(outboxEvents).values({
      tenantId: context.tenantId, aggregateType: "appointment", aggregateId: row.id, eventType: "appointment.status.cancelled",
      payload: { appointmentId: row.id, version: updated.version, seriesBatch: true },
      dedupeKey: `appointment.status.cancelled:${row.id}:${updated.version}`, traceParent: currentTraceParent(),
    });
    await planAppointment(run, context.tenantId, row.id); // pending reminders for this visit are cancelled
  }
}

async function offerFreedTimes(transaction: KalendrTransaction, tenantId: string, rows: VisitRecord[]): Promise<void> {
  for (const row of rows) {
    await offerFreedSlot(transaction, tenantId, {
      locationId: row.location_id, serviceId: row.service_id, practitionerId: row.practitioner_id,
      startsAt: new Date(row.starts_at), endsAt: new Date(row.ends_at), excludePatientId: row.patient_id,
    });
  }
}

/** The last day the old series still has a visit on: the latest visit it keeps. */
function lastKeptDate(loaded: Loaded): string {
  const affected = new Set(loaded.affected.map((visit) => visit.id));
  const kept = loaded.visits.filter((visit) => !affected.has(visit.id) && Number(visit.series_index) < Number(loaded.affected[0]?.series_index ?? Infinity));
  const last = kept.at(-1);
  return last ? localDateOf(new Date(last.starts_at).getTime(), loaded.timezone) : loaded.series.starts_on;
}

export async function changeSeries(context: StaffContext, seriesId: string, input: SeriesChangeInput, idempotencyKey: string): Promise<SeriesChangeResult> {
  requirePermission(context, "series.manage");
  if (context.preview || !context.userId) throw new ApiError(404, "series_not_found", "That repeating series was not found.");
  const route = `/api/staff/series/${seriesId}`;
  try {
    return await inSerializableTransaction(context.tenantId, async (transaction) => {
      const claim = await claimKey<SeriesChangeResult>(transaction, context.tenantId, route, idempotencyKey, input);
      if ("replay" in claim) return claim.replay;
      const loaded = await loadForChange(transaction, context.tenantId, seriesId, input, new Date(), context);
      if (loaded.affected.length === 0) throw conflict("nothing_to_change", "Every visit from here on is already finished, checked in or cancelled.");
      const affectedIds = loaded.affected.map((visit) => visit.id);
      const keptCount = loaded.visits.length - loaded.affected.length;
      const endOld = {
        untilOn: lastKeptDate(loaded), occurrenceCount: null, version: loaded.series.version + 1, updatedAt: new Date(),
      };

      if (input.action === "cancel") {
        await cancelOpenVisits(transaction, context, seriesId, loaded.affected, input.scope);
        await transaction.update(appointmentSeries).set({ ...endOld, status: keptCount === 0 ? "cancelled" : "ended" })
          .where(and(eq(appointmentSeries.tenantId, context.tenantId), eq(appointmentSeries.id, seriesId)));
        await writeSeriesAudit(transaction, context, "series.cancelled", { seriesId, scope: input.scope, cancelled: affectedIds.length, kept: keptCount });
        await queueSeriesMessage(transaction, context.tenantId, seriesId, "cancelled", affectedIds, loaded.series.version + 1);
        await offerFreedTimes(transaction, context.tenantId, loaded.affected);
        const result: SeriesChangeResult = { changed: true, seriesId, newSeriesId: null, cancelledCount: affectedIds.length, bookedCount: 0, keptCount };
        await finishKey(transaction, claim.claimId, result);
        return result;
      }

      const plan = planChange(loaded, input);
      const visits = applyResolutions(plan.visits, input.resolutions, loaded.timezone, plan.durationMinutes);
      if (visits.length === 0) throw new ApiError(400, "validation_error", "Nothing is left to book. Keep at least one visit.");
      await cancelOpenVisits(transaction, context, seriesId, loaded.affected, input.scope);
      const newSeriesId = randomUUID();
      const booked = await bookVisits(transaction, context, templateFor(context, loaded, plan.practitionerId), newSeriesId, visits, plan.durationMinutes);
      await transaction.insert(appointmentSeries).values({
        id: newSeriesId, tenantId: context.tenantId, patientId: loaded.series.patient_id, serviceId: loaded.series.service_id,
        practitionerId: plan.practitionerId, locationId: loaded.series.location_id, ruleText: ruleText(plan.rule, plan.startsOn), rule: plan.rule,
        startsOn: plan.startsOn, timeOfDay: plan.time, durationMinutes: plan.durationMinutes, continuedFromId: seriesId,
        ...(plan.rule.end.kind === "until" ? { untilOn: plan.rule.end.date } : { occurrenceCount: plan.rule.end.count }),
      });
      await transaction.update(appointmentSeries).set({ ...endOld, status: "ended" })
        .where(and(eq(appointmentSeries.tenantId, context.tenantId), eq(appointmentSeries.id, seriesId)));
      await writeSeriesAudit(transaction, context, "series.changed", {
        seriesId, newSeriesId, scope: input.scope, replaced: affectedIds.length, booked: booked.appointmentIds.length, kept: keptCount,
      }, booked.appointmentIds[0]);
      await queueSeriesMessage(transaction, context.tenantId, newSeriesId, "changed", booked.appointmentIds, 1);
      await offerFreedTimes(transaction, context.tenantId, loaded.affected);
      const result: SeriesChangeResult = {
        changed: true, seriesId, newSeriesId, cancelledCount: affectedIds.length, bookedCount: booked.appointmentIds.length, keptCount,
      };
      await finishKey(transaction, claim.claimId, result);
      return result;
    });
  } catch (error: unknown) {
    if (!(error instanceof SeriesVisitFailure) || input.action !== "change") throw error;
    // Nothing was saved: the old visits are still there. Show the list as it is now, with the failed visit marked.
    const preview = await previewSeriesChange(context, seriesId, input);
    return { changed: false, preview: { ...preview, visits: preview.visits.map((visit) => visit.index === error.index && visit.state === "free" ? { ...visit, state: "clash" as const, reason: error.code, reasonLabel: error.message } : visit) } };
  }
}
