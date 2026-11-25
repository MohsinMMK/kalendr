import "server-only";

import { and, desc, eq, lt, sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents, outboxEvents, reportExports, tenants } from "@/db/schema";
import {
  daysBetween, exportRequestSchema, REPORT_EXPORT_EVENT, reportParamsSchema, SYNC_EXPORT_MAX_DAYS, type ExportRequest, type ExportStatus, type ReportKey, type ReportParams, type ReportResult,
} from "@/lib/reports";
import { ApiError } from "@/server/api-error";
import { requireFeature } from "@/server/entitlements";
import { claimKey, finishKey } from "@/server/idempotent";
import { currentTraceParent } from "@/server/tracing";
import { assertNotReadOnlyImpersonation, can, requirePermission, type StaffContext } from "@/server/staff-context";
import { drizzleRunner } from "@/server/workflows/runner";

import { allowedLocationIds } from "@/server/location-scope";
import type { ReportContext, ReportScope } from "./common";
import { reportToCsv, reportFilename } from "./csv";
import { buildReport } from "./index";

const EXPORT_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** What this person may see, worked out on the server: a practitioner's numbers are theirs alone, whatever the request says. */
export interface Visibility { practitionerId?: string; canSeeRevenue: boolean }

export async function resolveVisibility(context: StaffContext, transaction: KalendrTransaction): Promise<Visibility> {
  const canSeeRevenue = can(context, "reports.revenue");
  if (context.role !== "practitioner") return { canSeeRevenue };
  // A person with no profile in this business sees nothing rather than everything.
  const rows = await transaction.execute<{ id: string }>(sql`select id from practitioners where tenant_id = ${context.tenantId} and auth_user_id = ${context.userId ?? ""} limit 1`);
  return { practitionerId: Array.from(rows)[0]?.id ?? "none", canSeeRevenue };
}

function previewRefusal(context: StaffContext): void {
  if (context.preview) throw new ApiError(409, "preview_only", "Reports need real bookings, so they are not available in the preview.");
}

function checkAccess(context: StaffContext, report: ReportKey): void {
  requireFeature(context, "reports");
  requirePermission(context, "reports.view");
  if (report === "revenue") requirePermission(context, "reports.revenue");
}

function scopeFor(context: StaffContext, params: ReportParams, visibility: Visibility): ReportScope {
  return {
    tenantId: context.tenantId,
    locationId: params.locationId,
    ...(allowedLocationIds(context) ? { locationIds: allowedLocationIds(context) ?? [] } : {}),
    // A practitioner's own id replaces whatever staff filter the request carried.
    practitionerId: visibility.practitionerId ?? params.practitionerId,
    forcedPractitioner: Boolean(visibility.practitionerId),
    canSeeRevenue: visibility.canSeeRevenue,
  };
}

export async function runReport(context: StaffContext, report: ReportKey, rawParams: unknown): Promise<ReportResult> {
  checkAccess(context, report);
  previewRefusal(context);
  const params = reportParamsSchema.parse(rawParams);
  return withTenant(context.tenantId, async (transaction) => {
    const visibility = await resolveVisibility(context, transaction);
    const [tenant] = await transaction.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, context.tenantId)).limit(1);
    const reportContext: ReportContext = { run: drizzleRunner(transaction), scope: scopeFor(context, params, visibility), params, timezone: tenant?.timezone ?? "Asia/Kolkata", now: new Date() };
    const result = await buildReport(report, reportContext);
    return { ...result, scopedToPerson: Boolean(reportContext.scope.practitionerId) };
  });
}

export type ExportOutcome = { kind: "file"; filename: string; body: string } | { kind: "queued"; id: string };

/**
 * Exports a report as CSV. A short range is built right here; a long one is queued for the worker and downloaded from a link.
 * Either way the request is audited, and the job keeps the visibility the person had so the worker never exports more.
 */
export async function requestExport(context: StaffContext, rawRequest: unknown, idempotencyKey: string): Promise<ExportOutcome> {
  assertNotReadOnlyImpersonation(context);
  const request: ExportRequest = exportRequestSchema.parse(rawRequest);
  checkAccess(context, request.report);
  requirePermission(context, "reports.export");
  previewRefusal(context);
  if (!context.userId) throw new ApiError(403, "forbidden", "Exports need a signed-in person.");
  const userId = context.userId;
  const route = "staff.reports.export";

  return withTenant(context.tenantId, async (transaction) => {
    const claim = await claimKey<ExportOutcome>(transaction, context.tenantId, route, idempotencyKey, { report: request.report, params: request.params });
    if ("replay" in claim) return claim.replay;
    const visibility = await resolveVisibility(context, transaction);
    const scope = scopeFor(context, request.params, visibility);
    const days = daysBetween(request.params.from, request.params.to) + 1;
    let outcome: ExportOutcome;
    if (days <= SYNC_EXPORT_MAX_DAYS) {
      const [tenant] = await transaction.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, context.tenantId)).limit(1);
      const result = await buildReport(request.report, { run: drizzleRunner(transaction), scope, params: request.params, timezone: tenant?.timezone ?? "Asia/Kolkata", now: new Date() });
      outcome = { kind: "file", filename: reportFilename(request.report, request.params.from, request.params.to), body: reportToCsv(result) };
    } else {
      // Old files go first, so the table does not grow with every export.
      await transaction.delete(reportExports).where(and(eq(reportExports.tenantId, context.tenantId), lt(reportExports.expiresAt, new Date())));
      const [row] = await transaction.insert(reportExports).values({
        tenantId: context.tenantId, requestedByUserId: userId, report: request.report, params: request.params,
        scope: { practitionerId: scope.practitionerId ?? null, locationId: scope.locationId ?? null, locationIds: scope.locationIds ?? null, canSeeRevenue: scope.canSeeRevenue },
        expiresAt: new Date(Date.now() + EXPORT_LIFETIME_MS),
      }).returning({ id: reportExports.id });
      if (!row) throw new ApiError(500, "export_not_saved", "The export could not be started.");
      await transaction.insert(outboxEvents).values({
        tenantId: context.tenantId, aggregateType: "report_export", aggregateId: row.id, eventType: REPORT_EXPORT_EVENT,
        payload: { exportId: row.id }, dedupeKey: `report.export:${row.id}`, traceParent: currentTraceParent(),
      });
      outcome = { kind: "queued", id: row.id };
    }
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: userId, actorType: "staff", action: "reports.exported", outcome: "success",
      metadata: { report: request.report, from: request.params.from, to: request.params.to, days, queued: outcome.kind === "queued" },
    });
    await finishKey(transaction, claim.claimId, outcome);
    return outcome;
  });
}

function toStatus(row: typeof reportExports.$inferSelect): ExportStatus {
  return { id: row.id, report: row.report as ReportKey, status: row.status as ExportStatus["status"], filename: row.filename, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString() };
}

/** The person's own recent exports, so the screen can show "ready, download" for a queued one. */
export async function listExports(context: StaffContext): Promise<ExportStatus[]> {
  requireFeature(context, "reports");
  requirePermission(context, "reports.export");
  if (context.preview || !context.userId) return [];
  const userId = context.userId;
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.select().from(reportExports)
      .where(and(eq(reportExports.tenantId, context.tenantId), eq(reportExports.requestedByUserId, userId), sql`${reportExports.expiresAt} > now()`))
      .orderBy(desc(reportExports.createdAt)).limit(10);
    return rows.map(toStatus);
  });
}

/** The finished CSV, only for the person who asked for it. */
export async function downloadExport(context: StaffContext, id: string): Promise<{ filename: string; body: string }> {
  requireFeature(context, "reports");
  requirePermission(context, "reports.export");
  if (context.preview || !context.userId) throw new ApiError(404, "export_not_found", "That export is not available.");
  const userId = context.userId;
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.select().from(reportExports)
      .where(and(eq(reportExports.tenantId, context.tenantId), eq(reportExports.id, id), eq(reportExports.requestedByUserId, userId))).limit(1);
    if (!row || row.expiresAt.getTime() <= Date.now()) throw new ApiError(404, "export_not_found", "That export has expired. Export the report again.");
    if (row.status === "pending") throw new ApiError(409, "export_pending", "The export is still being prepared. Try again in a moment.");
    if (row.status !== "ready" || row.body === null) throw new ApiError(422, "export_failed", "The export could not be built. Export the report again.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: userId, actorType: "staff", action: "reports.export.downloaded", outcome: "success", metadata: { report: row.report },
    });
    return { filename: row.filename ?? "report.csv", body: row.body };
  });
}

