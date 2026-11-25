import "server-only";

import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";

import { type KalendrTransaction, withTenant } from "@/db/client";
import { appointmentSeries, appointments, auditEvents, blocklistEntries, bookingReports, resourceReservations } from "@/db/schema";
import { isFreeMailAddress } from "@/lib/approval";
import {
  type BlocklistEntryInput,
  type BlocklistEntryView,
  type BookingReportView,
  type DecideReportInput,
  type SpamReasonCode,
  blockHint,
  contactKeys,
  normalizeBlockValue,
} from "@/lib/spam-contact";
import { ApiError } from "@/server/api-error";
import { canTransitionAppointment } from "@/server/appointment-state";
import type { AppointmentRow } from "@/server/appointment-tx";
import { mutationResultFromRow, recordMutation } from "@/server/appointment-repository";
import type { Actor } from "@/server/approval";
import type { AppointmentMutationResult } from "@/server/preview-repository";
import { blockValueHash } from "@/server/spam-check";
import { type StaffContext, requirePermission } from "@/server/staff-context";

/**
 * Staff side of spam protection (feature 44): reporting a booking, the review queue and the blocklist. A reported booking
 * and its future repeats are cancelled by the system without a word to the customer. Contacts are never logged, never put
 * in audit metadata, and the blocklist holds only keyed hashes with a masked hint.
 */

const OPEN_STATUSES = ["requested", "booked", "reschedule_requested", "pending_payment"] as const;

async function cancelQuietly(transaction: KalendrTransaction, row: AppointmentRow, actorUserId: string | undefined, extra: Record<string, unknown>): Promise<AppointmentRow> {
  await transaction.update(resourceReservations)
    .set({ state: "released", updatedAt: new Date() })
    .where(and(eq(resourceReservations.tenantId, row.tenantId), eq(resourceReservations.appointmentId, row.id)));
  const [updated] = await transaction.update(appointments).set({
    status: "cancelled",
    confirmationStatus: row.status === "requested" ? "declined" : row.confirmationStatus,
    cancelledAt: new Date(),
    cancelledBy: "system",
    cancelReasonCode: "spam",
    spamState: "reported",
    rescheduleRequestedAt: null,
    version: row.version + 1,
    updatedAt: new Date(),
  }).where(and(eq(appointments.tenantId, row.tenantId), eq(appointments.id, row.id))).returning();
  if (!updated) throw new Error("Appointment update did not return a row");
  // `notifyCustomer: false` makes the worker send nothing and start no workflow for this cancel.
  await recordMutation(transaction, row.tenantId, row.id, "staff", "appointment.status.cancelled", updated.version, actorUserId, {
    cancelledBy: "system", reasonCode: "spam", notifyCustomer: false, ...extra,
  });
  return updated;
}

/** Staff report a booking. It is cancelled quietly with every open repeat after it, and a report opens in the review queue. */
export async function reportBookingIn(
  transaction: KalendrTransaction,
  current: AppointmentRow,
  actor: Actor,
  input: { reasonCode: SpamReasonCode },
): Promise<AppointmentMutationResult> {
  if (current.spamState !== "none") throw new ApiError(409, "already_reported", "This booking was already reported as spam.");
  if (current.status === "entered_in_error") throw new ApiError(409, "invalid_status_transition", "This booking was marked as a mistake and can't be reported.");
  const [report] = await transaction.insert(bookingReports).values({
    tenantId: current.tenantId,
    appointmentId: current.id,
    patientId: current.patientId,
    reportedByUserId: actor.userId ?? null,
    reasonCode: input.reasonCode,
  }).onConflictDoNothing().returning({ id: bookingReports.id });
  if (!report) throw new ApiError(409, "already_reported", "This booking was already reported as spam.");

  let result: AppointmentRow = current;
  if (OPEN_STATUSES.includes(current.status as (typeof OPEN_STATUSES)[number]) && canTransitionAppointment(current.status, "cancelled")) {
    result = await cancelQuietly(transaction, current, actor.userId, { spamReason: input.reasonCode });
  } else {
    const [marked] = await transaction.update(appointments).set({ spamState: "reported", version: current.version + 1, updatedAt: new Date() })
      .where(and(eq(appointments.tenantId, current.tenantId), eq(appointments.id, current.id))).returning();
    if (!marked) throw new Error("Appointment update did not return a row");
    result = marked;
    await recordMutation(transaction, current.tenantId, current.id, "staff", "appointment.spam_reported", marked.version, actor.userId, { spamReason: input.reasonCode });
  }

  let repeatsCancelled = 0;
  if (current.seriesId) {
    const repeats = await transaction.select().from(appointments).where(and(
      eq(appointments.tenantId, current.tenantId),
      eq(appointments.seriesId, current.seriesId),
      ne(appointments.id, current.id),
      gt(appointments.startsAt, new Date()),
      inArray(appointments.status, [...OPEN_STATUSES]),
    )).for("update");
    for (const repeat of repeats) {
      await cancelQuietly(transaction, repeat, actor.userId, { spamReason: input.reasonCode, seriesId: current.seriesId });
      repeatsCancelled += 1;
    }
    const [{ remaining } = { remaining: 0 }] = await transaction.execute<{ remaining: number }>(sql`
      select count(*)::int as remaining from appointments
      where tenant_id = ${current.tenantId} and series_id = ${current.seriesId} and status <> 'cancelled'
    `);
    const [series] = await transaction.select({ version: appointmentSeries.version }).from(appointmentSeries)
      .where(and(eq(appointmentSeries.tenantId, current.tenantId), eq(appointmentSeries.id, current.seriesId))).for("update");
    if (series) {
      await transaction.update(appointmentSeries).set({ status: remaining === 0 ? "cancelled" : "ended", version: series.version + 1, updatedAt: new Date() })
        .where(and(eq(appointmentSeries.tenantId, current.tenantId), eq(appointmentSeries.id, current.seriesId)));
    }
  }
  await transaction.insert(auditEvents).values({
    tenantId: current.tenantId,
    appointmentId: current.id,
    actorUserId: actor.userId ?? null,
    actorType: "staff",
    action: "booking.spam_reported",
    outcome: "success",
    metadata: { reportId: report.id, reasonCode: input.reasonCode, repeatsCancelled },
  });
  return mutationResultFromRow(result);
}

async function nameOf(transaction: KalendrTransaction, userIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((value): value is string => Boolean(value)))];
  if (ids.length === 0) return new Map();
  const rows = await transaction.execute<{ id: string; name: string }>(sql`select id, name from auth_users where id in (${sql.join(ids.map((value) => sql`${value}`), sql`, `)})`);
  return new Map(rows.map((row) => [row.id, row.name]));
}

export async function listBlocklist(context: StaffContext): Promise<BlocklistEntryView[]> {
  requirePermission(context, "spam.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.select().from(blocklistEntries).where(eq(blocklistEntries.tenantId, context.tenantId)).orderBy(sql`${blocklistEntries.createdAt} desc`).limit(500);
    const names = await nameOf(transaction, rows.map((row) => row.addedByUserId));
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as BlocklistEntryView["kind"],
      hint: row.hint,
      reasonCode: row.reasonCode as SpamReasonCode,
      addedByName: row.addedByUserId ? names.get(row.addedByUserId) ?? null : null,
      createdAt: row.createdAt.toISOString(),
    }));
  });
}

/** Adds one normalised value. A whole free-mail provider can't be blocked: it would turn away everyone who uses it. */
export async function addBlocklistValue(
  transaction: KalendrTransaction,
  tenantId: string,
  actorUserId: string | null,
  kind: BlocklistEntryInput["kind"],
  rawValue: string,
  reasonCode: SpamReasonCode,
): Promise<{ id: string; created: boolean }> {
  const normalized = normalizeBlockValue(kind, rawValue);
  if (!normalized) {
    throw new ApiError(400, "validation_error", "That does not look like a valid value to block.", { value: [kind === "email_domain" ? "Enter a domain such as example.com." : kind === "phone" ? "Enter a full phone number." : "Enter an email address."] });
  }
  if (kind === "email_domain" && isFreeMailAddress(`x@${normalized}`)) {
    throw new ApiError(409, "domain_too_broad", `${normalized} is a free email provider used by many real people. Block the single address instead.`);
  }
  const [row] = await transaction.insert(blocklistEntries).values({
    tenantId,
    kind,
    valueHash: blockValueHash(tenantId, kind, normalized),
    hint: blockHint(kind, normalized),
    reasonCode,
    addedByUserId: actorUserId,
  }).onConflictDoNothing().returning({ id: blocklistEntries.id });
  if (row) {
    await transaction.insert(auditEvents).values({
      tenantId, actorUserId, actorType: "staff", action: "blocklist.added", outcome: "success", metadata: { entryId: row.id, kind, reasonCode },
    });
    return { id: row.id, created: true };
  }
  const [existing] = await transaction.select({ id: blocklistEntries.id }).from(blocklistEntries).where(and(
    eq(blocklistEntries.tenantId, tenantId), eq(blocklistEntries.kind, kind), eq(blocklistEntries.valueHash, blockValueHash(tenantId, kind, normalized)),
  ));
  if (!existing) throw new Error("Blocklist entry vanished");
  return { id: existing.id, created: false };
}

export async function addBlocklistEntry(context: StaffContext, input: BlocklistEntryInput): Promise<{ id: string }> {
  requirePermission(context, "spam.manage");
  const result = await withTenant(context.tenantId, (transaction) => addBlocklistValue(transaction, context.tenantId, context.userId, input.kind, input.value, input.reasonCode));
  return { id: result.id };
}

/** Removing an entry never brings back a booking that was cancelled because of it. */
export async function removeBlocklistEntry(context: StaffContext, entryId: string): Promise<{ removed: true }> {
  requirePermission(context, "spam.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.delete(blocklistEntries).where(and(eq(blocklistEntries.tenantId, context.tenantId), eq(blocklistEntries.id, entryId)))
      .returning({ id: blocklistEntries.id, kind: blocklistEntries.kind });
    if (!row) throw new ApiError(404, "blocklist_entry_not_found", "That entry is already gone.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "blocklist.removed", outcome: "success", metadata: { entryId: row.id, kind: row.kind },
    });
    return { removed: true as const };
  });
}

interface ReportRow extends Record<string, unknown> {
  id: string;
  appointment_id: string;
  reason_code: SpamReasonCode;
  status: BookingReportView["status"];
  reported_by_user_id: string | null;
  created_at: Date;
  decided_at: Date | null;
  email: string;
  phone: string;
  starts_at: Date;
  booking_count: number;
}

export async function listBookingReports(context: StaffContext, status: "open" | "decided"): Promise<BookingReportView[]> {
  requirePermission(context, "spam.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.execute<ReportRow>(sql`
      select report.id, report.appointment_id, report.reason_code, report.status, report.reported_by_user_id,
        report.created_at, report.decided_at, patient.email, patient.phone, appointment.starts_at,
        (select count(*)::int from appointments as other where other.tenant_id = report.tenant_id and other.patient_id = report.patient_id) as booking_count
      from booking_reports as report
      join appointments as appointment on appointment.tenant_id = report.tenant_id and appointment.id = report.appointment_id
      join patients as patient on patient.tenant_id = report.tenant_id and patient.id = report.patient_id
      where report.tenant_id = ${context.tenantId}
        and ${status === "open" ? sql`report.status = 'open'` : sql`report.status <> 'open'`}
      order by report.created_at desc
      limit 200
    `);
    const names = await nameOf(transaction, rows.map((row) => row.reported_by_user_id));
    return rows.map((row) => {
      const keys = contactKeys({ email: row.email, phone: row.phone });
      const email = keys.find((key) => key.kind === "email");
      const phone = keys.find((key) => key.kind === "phone");
      return {
        id: row.id,
        appointmentId: row.appointment_id,
        reasonCode: row.reason_code,
        status: row.status,
        reportedByName: row.reported_by_user_id ? names.get(row.reported_by_user_id) ?? null : null,
        createdAt: new Date(row.created_at).toISOString(),
        decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
        emailHint: email ? blockHint("email", email.value) : null,
        phoneHint: phone ? blockHint("phone", phone.value) : null,
        bookingCount: row.booking_count,
        startsAt: new Date(row.starts_at).toISOString(),
      };
    });
  });
}

/** Ignore closes the report. Block adds the reported email, phone or the address's whole domain to the blocklist. */
export async function decideBookingReport(context: StaffContext, reportId: string, input: DecideReportInput): Promise<{ status: "ignored" | "blocked"; blockedEntryId: string | null }> {
  requirePermission(context, "spam.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const [report] = await transaction.select().from(bookingReports)
      .where(and(eq(bookingReports.tenantId, context.tenantId), eq(bookingReports.id, reportId))).for("update");
    if (!report) throw new ApiError(404, "report_not_found", "That report no longer exists.");
    if (report.status !== "open") throw new ApiError(409, "report_decided", "Someone already decided this report.");
    let blockedEntryId: string | null = null;
    if (input.decision === "block") {
      const [patient] = await transaction.execute<{ email: string; phone: string }>(sql`
        select email, phone from patients where tenant_id = ${context.tenantId} and id = ${report.patientId}
      `);
      if (!patient) throw new ApiError(404, "patient_not_found", "The customer record is gone.");
      const value = input.kind === "phone" ? patient.phone : patient.email;
      blockedEntryId = (await addBlocklistValue(transaction, context.tenantId, context.userId, input.kind, value, report.reasonCode as SpamReasonCode)).id;
    }
    const status = input.decision === "block" ? "blocked" : "ignored";
    await transaction.update(bookingReports).set({ status, decidedByUserId: context.userId, decidedAt: new Date() })
      .where(and(eq(bookingReports.tenantId, context.tenantId), eq(bookingReports.id, reportId)));
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, appointmentId: report.appointmentId, actorUserId: context.userId, actorType: "staff",
      action: "booking_report.decided", outcome: "success", metadata: { reportId, decision: status, ...(input.decision === "block" ? { kind: input.kind } : {}) },
    });
    return { status, blockedEntryId };
  });
}
