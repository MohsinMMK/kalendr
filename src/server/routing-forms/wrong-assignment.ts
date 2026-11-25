import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents, wrongAssignmentReports } from "@/db/schema";
import type { WrongAssignmentInput, WrongAssignmentView } from "@/lib/routing-forms";
import { ApiError } from "@/server/api-error";
import { loadRecordKeys, openText, sealText, writeKeyVersion } from "@/server/record-crypto";
import { requirePermission, type StaffContext } from "@/server/staff-context";

/**
 * "This should have gone to Dr Shah." Any staff member can flag a routed booking; an admin reviews the list and fixes the
 * routes. The note is the staff member's own words, so it is sealed and kept out of audit rows.
 */

function requireLive(context: StaffContext): void {
  if (context.preview) throw new ApiError(400, "preview_only", "Reports are unavailable in preview mode.");
}

export async function reportWrongAssignment(context: StaffContext, input: WrongAssignmentInput): Promise<{ id: string }> {
  requirePermission(context, "routing.report");
  requireLive(context);
  if (!context.userId) throw new ApiError(403, "forbidden", "Sign in to report a booking.");
  const userId = context.userId;
  return withTenant(context.tenantId, async (transaction) => {
    const [routed] = await transaction.execute<{ practitioner_id: string }>(sql`
      select appointment.practitioner_id from appointments as appointment
      join routing_responses as response on response.tenant_id = appointment.tenant_id and response.appointment_id = appointment.id
      where appointment.tenant_id = ${context.tenantId} and appointment.id = ${input.appointmentId}
    `);
    if (!routed) throw new ApiError(404, "not_routed", "That booking was not made through a routing form.");
    if (input.correctPractitionerId) {
      const [person] = await transaction.execute<{ id: string }>(sql`select id from practitioners where tenant_id = ${context.tenantId} and id = ${input.correctPractitionerId}`);
      if (!person) throw new ApiError(400, "validation_error", "Choose someone from your team.", { correctPractitionerId: ["Choose someone from your team."] });
    }
    // The same person flagging the same booking twice would only fill the review list with copies.
    const [dup] = await transaction.execute<{ id: string }>(sql`
      select id from wrong_assignment_reports where tenant_id = ${context.tenantId} and appointment_id = ${input.appointmentId} and reported_by_user_id = ${userId} and status = 'open'
    `);
    if (dup) return { id: dup.id };
    let note: { noteCiphertext: string; keyVersion: number } | null = null;
    if (input.note) {
      await loadRecordKeys(transaction, context.tenantId, { forWrite: true });
      note = { noteCiphertext: sealText(context.tenantId, input.note), keyVersion: writeKeyVersion(context.tenantId) };
    }
    const [row] = await transaction.insert(wrongAssignmentReports).values({
      tenantId: context.tenantId, appointmentId: input.appointmentId, reportedByUserId: userId, correctPractitionerId: input.correctPractitionerId ?? null, ...(note ?? {}),
    }).returning({ id: wrongAssignmentReports.id });
    if (!row) throw new Error("Report insert returned no row");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: userId, actorType: "staff", action: "routing.wrong_assignment.reported", outcome: "success",
      metadata: { reportId: row.id, appointmentId: input.appointmentId },
    });
    return { id: row.id };
  });
}

export async function listWrongAssignments(context: StaffContext, status: "open" | "all" = "open"): Promise<WrongAssignmentView[]> {
  requirePermission(context, "routing.manage");
  requireLive(context);
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.execute<{
      id: string; appointment_id: string; starts_at: Date | string; service_name: string; assigned_name: string; correct_name: string | null; note_ciphertext: string | null;
      route_name: string | null; reported_by: string | null; status: "open" | "fixed" | "dismissed"; version: number; created_at: Date | string;
    }>(sql`
      select report.id, report.appointment_id, appointment.starts_at, service.name as service_name, assigned.name as assigned_name, correct.name as correct_name,
        report.note_ciphertext, response.route_name, reporter.name as reported_by, report.status, report.version, report.created_at
      from wrong_assignment_reports as report
      join appointments as appointment on appointment.tenant_id = report.tenant_id and appointment.id = report.appointment_id
      join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
      join practitioners as assigned on assigned.tenant_id = appointment.tenant_id and assigned.id = appointment.practitioner_id
      left join practitioners as correct on correct.tenant_id = report.tenant_id and correct.id = report.correct_practitioner_id
      left join routing_responses as response on response.tenant_id = report.tenant_id and response.appointment_id = report.appointment_id
      left join auth_users as reporter on reporter.id = report.reported_by_user_id
      where report.tenant_id = ${context.tenantId} ${status === "open" ? sql`and report.status = 'open'` : sql``}
      order by report.created_at desc limit 200
    `);
    if (rows.some((row) => row.note_ciphertext)) await loadRecordKeys(transaction, context.tenantId);
    return rows.map((row) => ({
      id: row.id, appointmentId: row.appointment_id, startsAt: new Date(row.starts_at).toISOString(), serviceName: row.service_name, assignedName: row.assigned_name,
      correctName: row.correct_name, note: row.note_ciphertext ? openText(context.tenantId, row.note_ciphertext) : null, routeName: row.route_name,
      reportedBy: row.reported_by ?? "A team member", status: row.status, version: Number(row.version), createdAt: new Date(row.created_at).toISOString(),
    }));
  });
}

export async function reviewWrongAssignment(context: StaffContext, reportId: string, input: { status: "fixed" | "dismissed"; expectedVersion: number }): Promise<{ status: "fixed" | "dismissed" }> {
  requirePermission(context, "routing.manage");
  requireLive(context);
  return withTenant(context.tenantId, async (transaction) => {
    const [current] = await transaction.select().from(wrongAssignmentReports)
      .where(and(eq(wrongAssignmentReports.tenantId, context.tenantId), eq(wrongAssignmentReports.id, reportId))).for("update").limit(1);
    if (!current) throw new ApiError(404, "report_not_found", "That report could not be found.");
    if (current.version !== input.expectedVersion || current.status !== "open") throw new ApiError(409, "version_conflict", "Someone else already reviewed this report.");
    await transaction.update(wrongAssignmentReports).set({ status: input.status, version: current.version + 1, reviewedByUserId: context.userId ?? null, reviewedAt: new Date() })
      .where(and(eq(wrongAssignmentReports.tenantId, context.tenantId), eq(wrongAssignmentReports.id, reportId)));
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId ?? null, actorType: "staff", action: "routing.wrong_assignment.reviewed", outcome: "success", metadata: { reportId, status: input.status },
    });
    return { status: input.status };
  });
}
