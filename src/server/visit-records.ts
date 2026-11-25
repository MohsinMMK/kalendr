import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import {
  auditEvents,
  outboxEvents,
  patientRecordAccess,
  visitRecordFiles,
  visitRecords,
} from "@/db/schema";
import { maskContact, type PatientContactKind } from "@/lib/patient-contact";
import { cleanFileName, detectRecordContentType, maxRecordFileBytes } from "@/lib/record-files";
import type {
  RecordAccessEntry,
  RecordAccessRequest,
  RecordFileScanStatus,
  RecordFileSummary,
  RecordsList,
  VisitRecordDetail,
  VisitRecordInput,
  VisitRecordKind,
  VisitRecordStatus,
  VisitRecordSummary,
} from "@/lib/visit-records";

import { profileWords, type TermWords } from "@/lib/terminology";
import { visibleCustomerCondition } from "@/server/location-scope";

import { ApiError } from "./api-error";
import { loadBusinessProfileIn } from "./business-profile";
import { fileStoreKey, getFileStore } from "./file-store";
import { loadRecordKeys, openBytes, openText, sealBytes, sealText, writeKeyVersion } from "./record-crypto";
import { uploadScanMode } from "./scan/clamav";
import { currentTraceParent } from "./tracing";
import { can, requirePermission, type StaffContext } from "./staff-context";

export interface RecordFileContent {
  name: string;
  contentType: string;
  bytes: Buffer;
}

function requireRecordRole(context: StaffContext): void {
  if (context.preview) throw new ApiError(409, "preview_only", "The preview keeps records in this browser tab.");
  requirePermission(context, "records.view");
}

function notFound(): ApiError {
  return new ApiError(404, "record_not_found", "Record not found.");
}

export async function writeRecordAudit(
  transaction: KalendrTransaction,
  tenantId: string,
  actor: { type: "staff" | "patient"; id: string | null },
  action: string,
  metadata: Record<string, unknown>,
  outcome: "success" | "denied" = "success",
): Promise<void> {
  // Ids only. Titles, names and file names don't belong in the log.
  await transaction.insert(auditEvents).values({
    tenantId,
    actorType: actor.type,
    actorUserId: actor.id,
    action,
    outcome,
    metadata,
  });
}

/**
 * Doctors reach a patient's records through having seen that patient. A doctor login with no linked doctor profile
 * sees only what it wrote itself. Owners and admins see the clinic's records.
 */
async function ownPatientClause(transaction: KalendrTransaction, context: StaffContext, patientColumn: SQL): Promise<SQL> {
  // Someone limited to some locations reaches the records of the customers seen at those locations only.
  const atMyLocations = visibleCustomerCondition(context, patientColumn) ?? sql`true`;
  if (context.role !== "practitioner") return atMyLocations;
  const rows = await transaction.execute<{ id: string }>(sql`
    select id from practitioners where tenant_id = ${context.tenantId} and auth_user_id = ${context.userId} limit 1
  `);
  const practitionerId = rows[0]?.id ?? "";
  return sql`(exists (
    select 1 from appointments as seen
    where seen.tenant_id = ${context.tenantId} and seen.patient_id = ${patientColumn} and seen.practitioner_id = ${practitionerId}
  ) and ${atMyLocations})`;
}

async function recordScope(transaction: KalendrTransaction, context: StaffContext): Promise<SQL> {
  const ownPatient = await ownPatientClause(transaction, context, sql`record.patient_id`);
  return context.role === "practitioner"
    ? sql`(record.created_by_user_id = ${context.userId} or ${ownPatient})`
    : ownPatient;
}

interface RecordRow extends Record<string, unknown> {
  id: string;
  patient_id: string;
  first_name: string;
  last_name: string;
  appointment_id: string | null;
  practitioner_name: string | null;
  kind: VisitRecordKind;
  status: VisitRecordStatus;
  title_ciphertext: string;
  body_ciphertext: string;
  created_at: Date | string;
  shared_at: Date | string | null;
  first_shared_at: Date | string | null;
  file_count: number;
  pending_file_count: number;
}

const iso = (value: Date | string) => new Date(value).toISOString();

function selectRecords(where: SQL, limit: number): SQL {
  return sql`
    select record.id, record.patient_id, patient.first_name, patient.last_name, record.appointment_id,
      practitioner.name as practitioner_name, record.kind, record.status, record.title_ciphertext,
      record.body_ciphertext, record.created_at, record.shared_at, record.first_shared_at,
      (select count(*)::int from visit_record_files as file
        where file.tenant_id = record.tenant_id and file.record_id = record.id
          and file.scan_status in ('clean', 'skipped')) as file_count,
      (select count(*)::int from visit_record_files as file
        where file.tenant_id = record.tenant_id and file.record_id = record.id
          and file.scan_status = 'pending') as pending_file_count
    from visit_records as record
    join patients as patient on patient.tenant_id = record.tenant_id and patient.id = record.patient_id
    left join practitioners as practitioner
      on practitioner.tenant_id = record.tenant_id and practitioner.id = record.practitioner_id
    where ${where}
    order by record.created_at desc, record.id
    limit ${limit}
  `;
}

function toSummary(tenantId: string, row: RecordRow): VisitRecordSummary {
  return {
    id: row.id,
    patientId: row.patient_id,
    patientName: `${row.first_name} ${row.last_name}`.trim(),
    appointmentId: row.appointment_id,
    practitionerName: row.practitioner_name,
    kind: row.kind,
    status: row.status,
    title: openText(tenantId, row.title_ciphertext),
    createdAt: iso(row.created_at),
    sharedAt: row.shared_at ? iso(row.shared_at) : null,
    fileCount: row.file_count,
  };
}

export async function listVisitRecords(context: StaffContext, patientId?: string): Promise<RecordsList> {
  requireRecordRole(context);
  return withTenant(context.tenantId, async (transaction) => {
    await loadRecordKeys(transaction, context.tenantId);
    const scope = await recordScope(transaction, context);
    const ownPatient = await ownPatientClause(transaction, context, sql`access.patient_id`);
    const patientFilter = patientId ? sql`and record.patient_id = ${patientId}` : sql``;
    const rows = await transaction.execute<RecordRow>(selectRecords(
      sql`record.tenant_id = ${context.tenantId} ${patientFilter} and ${scope}`,
      200,
    ));
    const requests = await transaction.execute<{
      id: string;
      patient_id: string;
      first_name: string;
      last_name: string;
      contact_kind: PatientContactKind;
      contact_value: string;
      requested_at: Date | string;
    }>(sql`
      select access.id, access.patient_id, patient.first_name, patient.last_name,
        account.contact_kind, account.contact_value, access.requested_at
      from patient_record_access as access
      join patients as patient on patient.tenant_id = access.tenant_id and patient.id = access.patient_id
      join patient_accounts as account on account.id = access.account_id
      where access.tenant_id = ${context.tenantId}
        and access.requested_at is not null and access.confirmed_at is null and ${ownPatient}
      order by access.requested_at
      limit 50
    `);
    await writeRecordAudit(transaction, context.tenantId, { type: "staff", id: context.userId }, "record.list", {
      count: rows.length,
      ...(patientId ? { patientId } : {}),
    });
    const accessRequests: RecordAccessRequest[] = requests.map((row) => ({
      accessId: row.id,
      patientId: row.patient_id,
      patientName: `${row.first_name} ${row.last_name}`.trim(),
      contact: maskContact(row.contact_kind, row.contact_value),
      requestedAt: iso(row.requested_at),
    }));
    return { records: rows.map((row) => toSummary(context.tenantId, row)), accessRequests };
  });
}

async function loadScopedRecord(transaction: KalendrTransaction, context: StaffContext, recordId: string, lock = false): Promise<RecordRow> {
  const scope = await recordScope(transaction, context);
  if (lock) {
    await transaction.execute(sql`select id from visit_records where tenant_id = ${context.tenantId} and id = ${recordId} for update`);
  }
  const rows = await transaction.execute<RecordRow>(selectRecords(
    sql`record.tenant_id = ${context.tenantId} and record.id = ${recordId} and ${scope}`,
    1,
  ));
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/**
 * A record's files. Staff see every file with its scan state; readyOnly (the customer portal)
 * leaves out files still being checked and files removed for a virus. Needs the business's keys loaded.
 */
async function loadFiles(
  transaction: KalendrTransaction,
  tenantId: string,
  recordId: string,
  options: { readyOnly?: boolean } = {},
): Promise<RecordFileSummary[]> {
  const rows = await transaction
    .select()
    .from(visitRecordFiles)
    .where(and(
      eq(visitRecordFiles.tenantId, tenantId),
      eq(visitRecordFiles.recordId, recordId),
      options.readyOnly ? inArray(visitRecordFiles.scanStatus, ["clean", "skipped"]) : undefined,
    ))
    .orderBy(visitRecordFiles.createdAt, visitRecordFiles.id);
  return rows.map((row) => ({
    id: row.id,
    name: openText(tenantId, row.nameCiphertext),
    contentType: row.contentType,
    byteSize: row.byteSize,
    createdAt: row.createdAt.toISOString(),
    scanStatus: row.scanStatus as RecordFileScanStatus,
  }));
}

export { loadFiles as loadRecordFiles };

async function wordsIn(transaction: KalendrTransaction, tenantId: string): Promise<TermWords> {
  return profileWords(await loadBusinessProfileIn(transaction, tenantId));
}

function accessActionLabels(t: TermWords): Record<string, string> {
  return {
    "record.create": "Created",
    "record.edit": "Edited",
    "record.view": "Viewed",
    "record.share": `Shared with ${t.customer}`,
    "record.withdraw": `Withdrawn from ${t.customer}`,
    "record.file.add": "Added a file",
    "record.file.remove": "Removed a file",
    "record.file.view": "Opened a file",
  };
}

async function loadAccessLog(transaction: KalendrTransaction, tenantId: string, recordId: string): Promise<RecordAccessEntry[]> {
  const rows = await transaction.execute<{
    id: string;
    action: string;
    actor_type: string;
    actor_name: string | null;
    occurred_at: Date | string;
  }>(sql`
    select event.id, event.action, event.actor_type, auth_users.name as actor_name, event.occurred_at
    from audit_events as event
    left join auth_users on auth_users.id = event.actor_user_id
    where event.tenant_id = ${tenantId} and event.metadata ? 'recordId' and event.metadata->>'recordId' = ${recordId}
    order by event.occurred_at desc, event.id
    limit 50
  `);
  const t = await wordsIn(transaction, tenantId);
  const labels = accessActionLabels(t);
  return rows.map((row) => ({
    id: row.id,
    who: row.actor_type === "patient" ? t.Customer : row.actor_name ?? "Staff",
    action: labels[row.action] ?? row.action,
    occurredAt: iso(row.occurred_at),
  }));
}

export async function getVisitRecord(context: StaffContext, recordId: string): Promise<VisitRecordDetail> {
  requireRecordRole(context);
  return withTenant(context.tenantId, async (transaction) => {
    await loadRecordKeys(transaction, context.tenantId);
    const row = await loadScopedRecord(transaction, context, recordId);
    await writeRecordAudit(transaction, context.tenantId, { type: "staff", id: context.userId }, "record.view", { recordId });
    return {
      ...toSummary(context.tenantId, row),
      body: openText(context.tenantId, row.body_ciphertext),
      files: await loadFiles(transaction, context.tenantId, recordId),
      everShared: row.first_shared_at !== null,
      accessLog: can(context, "records.accessLog") ? await loadAccessLog(transaction, context.tenantId, recordId) : null,
    };
  });
}

export async function createVisitRecord(context: StaffContext, input: VisitRecordInput): Promise<{ id: string }> {
  requireRecordRole(context);
  return withTenant(context.tenantId, async (transaction) => {
    await loadRecordKeys(transaction, context.tenantId, { forWrite: true });
    const ownPatient = await ownPatientClause(transaction, context, sql`patient.id`);
    const patients = await transaction.execute(sql`
      select patient.id from patients as patient
      where patient.tenant_id = ${context.tenantId} and patient.id = ${input.patientId} and ${ownPatient}
    `);
    if (!patients.length) throw new ApiError(404, "patient_not_found", `${(await wordsIn(transaction, context.tenantId)).Customer} not found.`);
    let practitionerId: string | null = null;
    if (input.appointmentId) {
      const visits = await transaction.execute<{ practitioner_id: string }>(sql`
        select practitioner_id from appointments
        where tenant_id = ${context.tenantId} and id = ${input.appointmentId} and patient_id = ${input.patientId}
      `);
      if (!visits[0]) {
        const t = await wordsIn(transaction, context.tenantId);
        throw new ApiError(400, "validation_error", `That ${t.visit} belongs to a different ${t.customer}.`);
      }
      practitionerId = visits[0].practitioner_id;
    } else if (context.role === "practitioner") {
      const own = await transaction.execute<{ id: string }>(sql`
        select id from practitioners where tenant_id = ${context.tenantId} and auth_user_id = ${context.userId} limit 1
      `);
      practitionerId = own[0]?.id ?? null;
    }
    const [created] = await transaction.insert(visitRecords).values({
      tenantId: context.tenantId,
      patientId: input.patientId,
      appointmentId: input.appointmentId,
      practitionerId,
      kind: input.kind,
      titleCiphertext: sealText(context.tenantId, input.title),
      bodyCiphertext: sealText(context.tenantId, input.body),
      keyVersion: writeKeyVersion(context.tenantId),
      createdByUserId: context.userId,
    }).returning({ id: visitRecords.id });
    if (!created) throw new Error("Visit record insert did not return a row");
    await writeRecordAudit(transaction, context.tenantId, { type: "staff", id: context.userId }, "record.create", {
      recordId: created.id,
      patientId: input.patientId,
    });
    return created;
  });
}

async function assertDraft(transaction: KalendrTransaction, tenantId: string, row: RecordRow): Promise<void> {
  if (row.status !== "draft") {
    const t = await wordsIn(transaction, tenantId);
    throw new ApiError(409, "record_shared", `The ${t.customer} can see this. Withdraw it before changing it.`);
  }
}

export async function editVisitRecord(
  context: StaffContext,
  recordId: string,
  input: { kind: VisitRecordKind; title: string; body: string },
): Promise<void> {
  requireRecordRole(context);
  await withTenant(context.tenantId, async (transaction) => {
    await assertDraft(transaction, context.tenantId, await loadScopedRecord(transaction, context, recordId, true));
    await loadRecordKeys(transaction, context.tenantId, { forWrite: true });
    await transaction.update(visitRecords).set({
      kind: input.kind,
      titleCiphertext: sealText(context.tenantId, input.title),
      bodyCiphertext: sealText(context.tenantId, input.body),
      keyVersion: writeKeyVersion(context.tenantId),
      updatedAt: new Date(),
    }).where(and(eq(visitRecords.tenantId, context.tenantId), eq(visitRecords.id, recordId)));
    await writeRecordAudit(transaction, context.tenantId, { type: "staff", id: context.userId }, "record.edit", { recordId });
  });
}

export async function shareVisitRecord(context: StaffContext, recordId: string): Promise<void> {
  requireRecordRole(context);
  await withTenant(context.tenantId, async (transaction) => {
    const row = await loadScopedRecord(transaction, context, recordId, true);
    if (row.status === "shared") return;
    if (row.pending_file_count > 0) {
      throw new ApiError(409, "file_pending", "A file is still being checked. Share this once the check is done.");
    }
    await loadRecordKeys(transaction, context.tenantId);
    if (!openText(context.tenantId, row.body_ciphertext) && row.file_count === 0) {
      throw new ApiError(409, "record_empty", "Add a note or a file before sharing.");
    }
    const now = new Date();
    await transaction.update(visitRecords).set({
      status: "shared",
      sharedAt: now,
      firstSharedAt: row.first_shared_at ? new Date(row.first_shared_at) : now,
      updatedAt: now,
    }).where(and(eq(visitRecords.tenantId, context.tenantId), eq(visitRecords.id, recordId)));
    await writeRecordAudit(transaction, context.tenantId, { type: "staff", id: context.userId }, "record.share", { recordId });
    await transaction.insert(outboxEvents).values({
      tenantId: context.tenantId,
      aggregateType: "visit_record",
      aggregateId: recordId,
      eventType: "record.shared",
      payload: { recordId },
      dedupeKey: `record.shared:${recordId}:${now.getTime()}`,
      traceParent: currentTraceParent(),
    });
  });
}

export async function withdrawVisitRecord(context: StaffContext, recordId: string): Promise<void> {
  requireRecordRole(context);
  await withTenant(context.tenantId, async (transaction) => {
    const row = await loadScopedRecord(transaction, context, recordId, true);
    if (row.status === "draft") return;
    await transaction.update(visitRecords).set({ status: "draft", sharedAt: null, updatedAt: new Date() })
      .where(and(eq(visitRecords.tenantId, context.tenantId), eq(visitRecords.id, recordId)));
    await writeRecordAudit(transaction, context.tenantId, { type: "staff", id: context.userId }, "record.withdraw", { recordId });
  });
}

/** Only for a mistake nobody outside the clinic ever saw. Anything once shared stays on file. */
export async function deleteDraftVisitRecord(context: StaffContext, recordId: string): Promise<void> {
  requireRecordRole(context);
  const keys = await withTenant(context.tenantId, async (transaction) => {
    const row = await loadScopedRecord(transaction, context, recordId, true);
    await assertDraft(transaction, context.tenantId, row);
    if (row.first_shared_at) {
      const t = await wordsIn(transaction, context.tenantId);
      throw new ApiError(409, "record_was_shared", `This was shared with the ${t.customer}, so it stays on file.`);
    }
    const files = await transaction.select({ key: visitRecordFiles.storageKey }).from(visitRecordFiles)
      .where(and(eq(visitRecordFiles.tenantId, context.tenantId), eq(visitRecordFiles.recordId, recordId)));
    await transaction.delete(visitRecords).where(and(eq(visitRecords.tenantId, context.tenantId), eq(visitRecords.id, recordId)));
    await writeRecordAudit(transaction, context.tenantId, { type: "staff", id: context.userId }, "record.delete", { recordId });
    return files.map((file) => file.key);
  });
  const store = getFileStore();
  await Promise.all(keys.map((key) => store.remove(key)));
}

export async function addVisitRecordFile(
  context: StaffContext,
  recordId: string,
  upload: { name: string; bytes: Uint8Array },
): Promise<RecordFileSummary> {
  requireRecordRole(context);
  if (upload.bytes.byteLength === 0) throw new ApiError(400, "validation_error", "That file is empty.");
  if (upload.bytes.byteLength > maxRecordFileBytes) throw new ApiError(413, "request_too_large", "Files can be up to 15 MB.");
  const contentType = detectRecordContentType(upload.bytes);
  if (!contentType) throw new ApiError(415, "unsupported_file", "Upload a PDF, JPG, or PNG.");
  const name = cleanFileName(upload.name);
  // Production never takes a file it can't scan.
  const scanMode = uploadScanMode();
  if (scanMode === "refuse") {
    throw new ApiError(503, "scanner_unavailable", "Files can't be added until virus scanning is set up on this server.");
  }
  const store = getFileStore();
  // Checked before the bytes are stored, so someone without access can't fill the store.
  await withTenant(context.tenantId, async (transaction) => {
    await assertDraft(transaction, context.tenantId, await loadScopedRecord(transaction, context, recordId));
    await loadRecordKeys(transaction, context.tenantId, { forWrite: true });
  });
  const fileId = randomUUID();
  const storageKey = fileStoreKey(context.tenantId, "record", fileId);
  const sealed = sealBytes(context.tenantId, upload.bytes);
  const keyVersion = writeKeyVersion(context.tenantId);
  await store.put(storageKey, sealed);
  try {
    return await withTenant(context.tenantId, async (transaction) => {
      await assertDraft(transaction, context.tenantId, await loadScopedRecord(transaction, context, recordId, true));
      await loadRecordKeys(transaction, context.tenantId);
      const scanStatus: RecordFileScanStatus = scanMode === "scan" ? "pending" : "skipped";
      const [file] = await transaction.insert(visitRecordFiles).values({
        id: fileId,
        tenantId: context.tenantId,
        recordId,
        storageKey,
        nameCiphertext: sealText(context.tenantId, name),
        contentType,
        byteSize: upload.bytes.byteLength,
        sha256: createHash("sha256").update(upload.bytes).digest("hex"),
        keyVersion,
        scanStatus,
        uploadedByUserId: context.userId,
      }).returning();
      if (!file) throw new Error("Visit record file insert did not return a row");
      await writeRecordAudit(transaction, context.tenantId, { type: "staff", id: context.userId }, "record.file.add", { recordId, fileId: file.id });
      if (scanStatus === "pending") {
        await transaction.insert(outboxEvents).values({
          tenantId: context.tenantId,
          aggregateType: "visit_record_file",
          aggregateId: file.id,
          eventType: "file.scan",
          payload: { table: "visit_record_files", id: file.id },
          dedupeKey: `file.scan:visit_record_files:${file.id}`,
          traceParent: currentTraceParent(),
        });
      }
      return { id: file.id, name, contentType, byteSize: file.byteSize, createdAt: file.createdAt.toISOString(), scanStatus };
    });
  } catch (error: unknown) {
    await store.remove(storageKey);
    throw error;
  }
}


export async function removeVisitRecordFile(context: StaffContext, recordId: string, fileId: string): Promise<void> {
  requireRecordRole(context);
  const key = await withTenant(context.tenantId, async (transaction) => {
    await assertDraft(transaction, context.tenantId, await loadScopedRecord(transaction, context, recordId, true));
    const [removed] = await transaction.delete(visitRecordFiles)
      .where(and(eq(visitRecordFiles.tenantId, context.tenantId), eq(visitRecordFiles.recordId, recordId), eq(visitRecordFiles.id, fileId)))
      .returning({ key: visitRecordFiles.storageKey });
    if (!removed) throw notFound();
    await writeRecordAudit(transaction, context.tenantId, { type: "staff", id: context.userId }, "record.file.remove", { recordId, fileId });
    return removed.key;
  });
  await getFileStore().remove(key);
}

/** The view is logged and committed before any bytes leave, so no one reads a file without a trace. */
export async function readRecordFile(
  tenantId: string,
  recordId: string,
  fileId: string,
  actor: { type: "staff" | "patient"; id: string | null },
  check: (transaction: KalendrTransaction) => Promise<void>,
): Promise<RecordFileContent> {
  const file = await withTenant(tenantId, async (transaction) => {
    await check(transaction);
    const [row] = await transaction.select().from(visitRecordFiles)
      .where(and(eq(visitRecordFiles.tenantId, tenantId), eq(visitRecordFiles.recordId, recordId), eq(visitRecordFiles.id, fileId)))
      .limit(1);
    if (!row) throw notFound();
    // A file is opened only after the virus scan has passed (or, in development with no scanner, was skipped).
    if (row.scanStatus === "pending") {
      throw new ApiError(409, "file_pending", "This file is still being checked. Try again in a moment.");
    }
    if (row.scanStatus === "infected") {
      throw new ApiError(410, "file_infected", "This file was removed because it contained a virus.");
    }
    await loadRecordKeys(transaction, tenantId);
    await writeRecordAudit(transaction, tenantId, actor, "record.file.view", { recordId, fileId });
    return row;
  });
  const sealed = await getFileStore().get(file.storageKey);
  return { name: openText(tenantId, file.nameCiphertext), contentType: file.contentType, bytes: openBytes(tenantId, sealed) };
}

export async function readStaffRecordFile(context: StaffContext, recordId: string, fileId: string): Promise<RecordFileContent> {
  requireRecordRole(context);
  return readRecordFile(context.tenantId, recordId, fileId, { type: "staff", id: context.userId }, async (transaction) => {
    await loadScopedRecord(transaction, context, recordId);
  });
}

/** The clinic has checked this person's identity in person. */
export async function confirmRecordAccess(context: StaffContext, accessId: string): Promise<void> {
  requireRecordRole(context);
  await withTenant(context.tenantId, async (transaction) => {
    const ownPatient = await ownPatientClause(transaction, context, sql`access.patient_id`);
    const rows = await transaction.execute<{ id: string; patient_id: string }>(sql`
      select access.id, access.patient_id from patient_record_access as access
      where access.tenant_id = ${context.tenantId} and access.id = ${accessId}
        and access.requested_at is not null and access.confirmed_at is null and ${ownPatient}
      for update
    `);
    const row = rows[0];
    if (!row) throw new ApiError(404, "access_request_not_found", "That request is no longer open.");
    await transaction.update(patientRecordAccess).set({
      confirmedAt: new Date(),
      confirmedMethod: "clinic",
      confirmedByUserId: context.userId,
      failedAttempts: 0,
      updatedAt: new Date(),
    }).where(and(eq(patientRecordAccess.tenantId, context.tenantId), eq(patientRecordAccess.id, accessId)));
    await writeRecordAudit(transaction, context.tenantId, { type: "staff", id: context.userId }, "record.access.confirm", { patientId: row.patient_id });
  });
}

export function recordFileResponse(file: RecordFileContent, download: boolean): Response {
  const fallback = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
  const disposition = `${download ? "attachment" : "inline"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.name)}`;
  return new Response(new Uint8Array(file.bytes), {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": disposition,
      "Content-Length": String(file.bytes.byteLength),
      "Content-Type": file.contentType,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
