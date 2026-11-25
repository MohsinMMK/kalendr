import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents, dataRequests, outboxEvents, patients } from "@/db/schema";

import { ApiError } from "../api-error";
import { claimKey, finishKey } from "../idempotent";
import { requirePermission, requireRecentStepUp, type StaffContext } from "../staff-context";
import {
  daysRemaining,
  decisionReasons,
  isOpenRequest,
  isOverdue,
  refusalReasons,
  type DataRequestStatus,
  type DataRequestType,
  type DecisionReason,
} from "./rules";

export const requestInputSchema = z.object({
  type: z.enum(["export", "erasure", "correction"]),
  /** The customer's own words, up to 500 characters. Staff read it; it never goes into the audit log. */
  note: z.string().trim().max(500).optional(),
}).strict();
export type RequestInput = z.infer<typeof requestInputSchema>;

export const decisionInputSchema = z.object({
  decision: z.enum(["approve", "refuse"]),
  reason: z.enum(decisionReasons),
  /** Extra words for the customer. Kept on the request, never in the audit log. */
  note: z.string().trim().max(500).optional(),
  /** The version the screen saw. A different one means someone else decided first. */
  version: z.number().int().min(1),
}).strict();
export type DecisionInput = z.infer<typeof decisionInputSchema>;

export const requestFilterSchema = z.object({
  status: z.enum(["open", "closed", "all"]).default("open"),
  type: z.enum(["export", "erasure", "correction"]).optional(),
  overdue: z.enum(["true", "false"]).optional(),
});
export type RequestFilter = z.infer<typeof requestFilterSchema>;

export interface DataRequestView {
  id: string;
  type: DataRequestType;
  status: DataRequestStatus;
  createdAt: string;
  dueAt: string;
  /** Whole days left; negative once overdue. Null once the request is closed. */
  daysRemaining: number | null;
  overdue: boolean;
  decisionReason: DecisionReason | null;
  decisionNote: string | null;
  decidedAt: string | null;
  completedAt: string | null;
  /** What the customer wrote. Staff only. */
  note?: string | null;
  summary: { removed: string[]; kept: string[] } | null;
  version: number;
}

export interface StaffRequestView extends DataRequestView {
  patientId: string;
  /** "Erased customer" once the customer has been erased. */
  customerName: string;
  requestedVia: string;
  handledByUserId: string | null;
}

interface RequestRow {
  id: string;
  type: DataRequestType;
  status: DataRequestStatus;
  createdAt: Date;
  dueAt: Date;
  decisionReason: string | null;
  decisionNote: string | null;
  decidedAt: Date | null;
  completedAt: Date | null;
  note: string | null;
  resultSummary: Record<string, unknown> | null;
  version: number;
}

function readSummary(value: Record<string, unknown> | null): { removed: string[]; kept: string[] } | null {
  if (!value) return null;
  const lines = (entry: unknown) => Array.isArray(entry) ? entry.filter((line): line is string => typeof line === "string") : [];
  return { removed: lines(value.removed), kept: lines(value.kept) };
}

export function toRequestView(row: RequestRow, now: Date = new Date(), includeNote = false): DataRequestView {
  const open = isOpenRequest(row.status);
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    daysRemaining: open ? daysRemaining(row.dueAt, now) : null,
    overdue: isOverdue(row, now),
    decisionReason: (decisionReasons as readonly string[]).includes(row.decisionReason ?? "") ? row.decisionReason as DecisionReason : null,
    decisionNote: row.decisionNote,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    ...(includeNote ? { note: row.note } : {}),
    summary: readSummary(row.resultSummary),
    version: row.version,
  };
}

const requestColumns = {
  id: dataRequests.id,
  type: dataRequests.type,
  status: dataRequests.status,
  createdAt: dataRequests.createdAt,
  dueAt: dataRequests.dueAt,
  decisionReason: dataRequests.decisionReason,
  decisionNote: dataRequests.decisionNote,
  decidedAt: dataRequests.decidedAt,
  completedAt: dataRequests.completedAt,
  note: dataRequests.note,
  resultSummary: dataRequests.resultSummary,
  version: dataRequests.version,
};

export interface CreateRequestResult {
  request: DataRequestView;
  /** False when the customer already had an open request of this type: the same one is returned. */
  created: boolean;
}

/**
 * Makes a request for one customer. An export needs no decision, so it starts approved and the worker builds it; an
 * erasure or a correction waits for staff. Asking again while one is open returns the open one and changes nothing.
 */
export async function createDataRequestIn(
  transaction: KalendrTransaction,
  tenantId: string,
  patientId: string,
  input: RequestInput,
  via: "portal" | "staff" | "email" = "portal",
): Promise<CreateRequestResult> {
  const approvedAtOnce = input.type === "export";
  const inserted = await transaction.execute<{ id: string }>(sql`
    insert into data_requests (tenant_id, patient_id, type, status, requested_via, note, decision_reason, decided_at)
    values (${tenantId}, ${patientId}, ${input.type}, ${approvedAtOnce ? "approved" : "requested"}, ${via}, ${input.note ?? null},
      ${approvedAtOnce ? "verified" : null}, ${approvedAtOnce ? sql`now()` : null})
    on conflict (tenant_id, patient_id, type) where status in ('requested', 'approved', 'processing') do nothing
    returning id
  `);
  const createdId = inserted[0]?.id;
  const [row] = await transaction.select(requestColumns).from(dataRequests).where(and(
    eq(dataRequests.tenantId, tenantId),
    createdId
      ? eq(dataRequests.id, createdId)
      : and(eq(dataRequests.patientId, patientId), eq(dataRequests.type, input.type), inArray(dataRequests.status, ["requested", "approved", "processing"])),
  )).limit(1);
  if (!row) throw new ApiError(409, "request_conflict", "That request could not be saved. Try again.");
  if (createdId) {
    await transaction.insert(auditEvents).values({
      tenantId,
      actorType: via === "staff" ? "staff" : "patient",
      action: "privacy.request.created",
      outcome: "success",
      metadata: { requestId: createdId, type: input.type, patientId, via },
    });
    if (approvedAtOnce) {
      await transaction.insert(outboxEvents).values({
        tenantId,
        aggregateType: "data_request",
        aggregateId: createdId,
        eventType: "privacy.export.requested",
        payload: { requestId: createdId },
        dedupeKey: `privacy.export.requested:${createdId}`,
      }).onConflictDoNothing();
    }
  }
  return { request: toRequestView(row, new Date(), false), created: Boolean(createdId) };
}

export async function listPatientRequestsIn(transaction: KalendrTransaction, tenantId: string, patientId: string): Promise<DataRequestView[]> {
  const rows = await transaction.select(requestColumns).from(dataRequests)
    .where(and(eq(dataRequests.tenantId, tenantId), eq(dataRequests.patientId, patientId)))
    .orderBy(desc(dataRequests.createdAt))
    .limit(20);
  const now = new Date();
  return rows.map((row) => toRequestView(row, now));
}

function requirePrivacy(context: StaffContext): void {
  requirePermission(context, "privacy.manage");
}

function requireLive(context: StaffContext): void {
  if (context.preview) throw new ApiError(409, "preview_only", "Privacy requests are not available in the preview.");
}

/** Open requests first, oldest due date first, with days remaining. */
export async function listStaffRequests(context: StaffContext, filter: RequestFilter): Promise<{ requests: StaffRequestView[]; counts: { open: number; overdue: number } }> {
  requirePrivacy(context);
  if (context.preview) return { requests: [], counts: { open: 0, overdue: 0 } };
  const now = new Date();
  return withTenant(context.tenantId, async (transaction) => {
    const conditions = [eq(dataRequests.tenantId, context.tenantId)];
    if (filter.status === "open") conditions.push(inArray(dataRequests.status, ["requested", "approved", "processing"]));
    if (filter.status === "closed") conditions.push(inArray(dataRequests.status, ["refused", "completed", "failed"]));
    if (filter.type) conditions.push(eq(dataRequests.type, filter.type));
    const rows = await transaction
      .select({
        ...requestColumns,
        patientId: dataRequests.patientId,
        requestedVia: dataRequests.requestedVia,
        handledByUserId: dataRequests.handledByUserId,
        firstName: patients.firstName,
        lastName: patients.lastName,
        erasedAt: patients.erasedAt,
      })
      .from(dataRequests)
      .innerJoin(patients, and(eq(patients.tenantId, dataRequests.tenantId), eq(patients.id, dataRequests.patientId)))
      .where(and(...conditions))
      .orderBy(dataRequests.dueAt)
      .limit(200);
    let requests = rows.map((row): StaffRequestView => ({
      ...toRequestView(row, now, true),
      patientId: row.patientId,
      customerName: row.erasedAt ? "Erased customer" : `${row.firstName} ${row.lastName}`.trim(),
      requestedVia: row.requestedVia,
      handledByUserId: row.handledByUserId,
    }));
    if (filter.overdue) requests = requests.filter((request) => request.overdue === (filter.overdue === "true"));
    const [counts] = await transaction.execute<{ open: number; overdue: number }>(sql`
      select count(*)::int as open, count(*) filter (where due_at < now())::int as overdue
      from data_requests where tenant_id = ${context.tenantId} and status in ('requested', 'approved', 'processing')
    `);
    return { requests, counts: { open: counts?.open ?? 0, overdue: counts?.overdue ?? 0 } };
  });
}

/**
 * Staff approve or refuse a request. Takes an Idempotency-Key and the version the screen saw, so a double click or a
 * stale screen never decides twice. Approving an erasure needs a recent second-factor check, and queues the worker
 * (no data is changed inside this request); refusing needs a reason from the fixed list.
 */
export async function decideRequest(context: StaffContext, requestId: string, input: DecisionInput, idempotencyKey: string): Promise<StaffRequestView> {
  requirePrivacy(context);
  requireLive(context);
  if (input.decision === "refuse" && !refusalReasons.includes(input.reason)) {
    throw new ApiError(400, "validation_error", "Choose a reason for refusing.", { reason: ["Choose a reason for refusing."] });
  }
  if (input.decision === "approve" && input.reason !== "verified") {
    throw new ApiError(400, "validation_error", "Approving uses the reason \"verified\".", { reason: ["Approving uses the reason \"verified\"."] });
  }
  return withTenant(context.tenantId, async (transaction) => {
    const claim = await claimKey<StaffRequestView>(transaction, context.tenantId, `staff.privacy.decide:${requestId}`, idempotencyKey, input);
    if ("replay" in claim) return claim.replay;

    const [row] = await transaction.execute<{ id: string; type: DataRequestType; status: DataRequestStatus; version: number; patient_id: string }>(sql`
      select id, type, status, version, patient_id from data_requests
      where tenant_id = ${context.tenantId} and id = ${requestId} for update
    `);
    if (!row) throw new ApiError(404, "not_found", "That request was not found.");
    if (row.version !== input.version) {
      throw new ApiError(409, "version_conflict", "Someone else changed this request. Reload and look again.");
    }
    if (row.status !== "requested") throw new ApiError(409, "already_decided", "This request has already been dealt with.");
    // The check comes after the lookup so a refused erasure needs no second factor, only an approval does.
    if (input.decision === "approve" && row.type === "erasure") requireRecentStepUp(context);

    const now = new Date();
    const status: DataRequestStatus = input.decision === "refuse" ? "refused" : row.type === "erasure" ? "approved" : "completed";
    await transaction.update(dataRequests).set({
      status,
      handledByUserId: context.userId,
      decidedAt: now,
      decisionReason: input.reason,
      decisionNote: input.note ?? null,
      completedAt: status === "completed" ? now : null,
      version: row.version + 1,
      updatedAt: now,
    }).where(and(eq(dataRequests.tenantId, context.tenantId), eq(dataRequests.id, requestId)));

    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action: input.decision === "approve" ? "privacy.request.approved" : "privacy.request.refused",
      outcome: "success",
      // Ids and the fixed reason word only: what the person typed stays on the request, not in the log.
      metadata: { requestId, type: row.type, reason: input.reason, patientId: row.patient_id },
    });
    if (input.decision === "approve" && row.type === "erasure") {
      await transaction.insert(outboxEvents).values({
        tenantId: context.tenantId,
        aggregateType: "data_request",
        aggregateId: requestId,
        eventType: "privacy.erasure.approved",
        payload: { requestId },
        dedupeKey: `privacy.erasure.approved:${requestId}`,
      }).onConflictDoNothing();
    }

    const [view] = (await listStaffRequestsIn(transaction, context.tenantId, requestId));
    if (!view) throw new ApiError(404, "not_found", "That request was not found.");
    await finishKey(transaction, claim.claimId, view);
    return view;
  });
}

async function listStaffRequestsIn(transaction: KalendrTransaction, tenantId: string, requestId: string): Promise<StaffRequestView[]> {
  const rows = await transaction
    .select({
      ...requestColumns,
      patientId: dataRequests.patientId,
      requestedVia: dataRequests.requestedVia,
      handledByUserId: dataRequests.handledByUserId,
      firstName: patients.firstName,
      lastName: patients.lastName,
      erasedAt: patients.erasedAt,
    })
    .from(dataRequests)
    .innerJoin(patients, and(eq(patients.tenantId, dataRequests.tenantId), eq(patients.id, dataRequests.patientId)))
    .where(and(eq(dataRequests.tenantId, tenantId), eq(dataRequests.id, requestId)));
  const now = new Date();
  return rows.map((row) => ({
    ...toRequestView(row, now, true),
    patientId: row.patientId,
    customerName: row.erasedAt ? "Erased customer" : `${row.firstName} ${row.lastName}`.trim(),
    requestedVia: row.requestedVia,
    handledByUserId: row.handledByUserId,
  }));
}
