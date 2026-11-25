import "server-only";

import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents, importJobs, importRows, outboxEvents } from "@/db/schema";
import { ApiError } from "@/server/api-error";
import { fileStoreKey, getFileStore } from "@/server/file-store";
import { loadRecordKeys, openBytes, sealBytes, writeKeyVersion } from "@/server/record-crypto";
import { requirePermission, type StaffContext } from "@/server/staff-context";
import { currentTraceParent } from "@/server/tracing";

import {
  defaultImportOptions,
  importErrorCodes,
  importFileErrorCodes,
  importIdSchema,
  importRowStatuses,
  importStatuses,
  importLimits,
  importOptionsSchema,
  isImportKind,
  mappingSchema,
  type ImportFileErrorCode,
  type ImportJobView,
  type ImportKind,
  type ImportMapping,
  type ImportPreviewRow,
  type ImportRowStatus,
  type ImportRowView,
  type ImportUpdateInput,
  type ImportUploadResult,
} from "./contracts";
import { buildErrorCsv } from "./errors-csv";
import { fieldViews, guessMapping, importFields, missingRequiredFields } from "./map";
import { ImportParseError, parseImportFile, sniffFormat, type ParsedFile } from "./parse";
import { fileErrorText } from "./reasons";
import { previewRows, regionFor } from "./preview";

/**
 * Data import for staff (feature 12). Everything runs in the business's own scope and needs the settings permission.
 * The uploaded file is encrypted with the business's data key and kept in the file store; the database holds only the
 * choices made and the outcome of each row. Checking and importing happen in the worker, one chunk at a time.
 */

type JobRow = typeof importJobs.$inferSelect;

/** The id from a route's path: anything that is not a plain id is simply not found. */
export function importIdOf(raw: string): string {
  const parsed = importIdSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(404, "import_not_found", "That import was not found.");
  return parsed.data;
}

const unavailable = () => new ApiError(503, "database_unavailable", "Importing is not available right now.");
const notFound = () => new ApiError(404, "import_not_found", "That import was not found.");
const versionConflict = () => new ApiError(409, "version_conflict", "This import changed in another window. Reload it and try again.");

function guard(context: StaffContext): void {
  requirePermission(context, "settings.manage");
  if (context.preview) throw unavailable();
}

export function jobView(row: JobRow, undo?: { removed: number; kept: number }): ImportJobView {
  const mapping = mappingSchema.safeParse(row.mapping);
  const options = importOptionsSchema.safeParse(row.options);
  return {
    id: row.id,
    kind: isImportKind(row.kind) ? row.kind : "customers",
    fileFormat: row.fileFormat === "xlsx" ? "xlsx" : "csv",
    status: importStatuses.find((status) => status === row.status) ?? "failed",
    rowCount: row.rowCount,
    counts: {
      ready: row.readyCount, update: row.updateCount, skip: row.skipCount, error: row.errorCount,
      created: row.createdCount, updated: row.updatedCount, skipped: row.skippedCount, failed: row.failedCount,
    },
    options: options.success ? options.data : null,
    mapping: mapping.success && Object.keys(mapping.data).length > 0 ? mapping.data : null,
    failureCode: importFileErrorCodes.find((code) => code === row.failureCode) ?? null,
    undoUntil: row.undoUntil?.toISOString() ?? null,
    undoneAt: row.undoneAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    ...(undo ? { undo } : {}),
  };
}

async function loadJob(transaction: KalendrTransaction, tenantId: string, id: string, lock = false): Promise<JobRow> {
  const query = transaction.select().from(importJobs).where(and(eq(importJobs.tenantId, tenantId), eq(importJobs.id, id))).limit(1);
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound();
  return row;
}

async function undoTally(transaction: KalendrTransaction, job: JobRow): Promise<{ removed: number; kept: number } | undefined> {
  if (job.status !== "undoing" && job.status !== "undone") return undefined;
  const [tally] = await transaction.execute<{ removed: number; kept: number }>(sql`
    select count(*) filter (where status = 'undone')::int as removed,
      count(*) filter (where status = 'created' and error_code = 'in_use')::int as kept
    from import_rows where tenant_id = ${job.tenantId} and job_id = ${job.id}`);
  return tally;
}

/** Reads the stored file back, decrypting in memory. Nothing is written anywhere. */
async function readStoredFile(transaction: KalendrTransaction, job: JobRow): Promise<ParsedFile> {
  if (!job.fileKey) throw new ApiError(410, "file_missing", fileErrorText("file_missing"));
  await loadRecordKeys(transaction, job.tenantId);
  let bytes: Buffer;
  try {
    bytes = openBytes(job.tenantId, await getFileStore().get(job.fileKey));
  } catch {
    throw new ApiError(410, "file_missing", fileErrorText("file_missing"));
  }
  return parseOrRefuse(bytes);
}

async function parseOrRefuse(bytes: Uint8Array): Promise<ParsedFile> {
  try {
    return await parseImportFile(bytes);
  } catch (error) {
    const code: ImportFileErrorCode = error instanceof ImportParseError ? error.code : "unreadable_file";
    throw new ApiError(code === "file_too_large" ? 413 : 400, code, fileErrorText(code));
  }
}

function queueEvent(transaction: KalendrTransaction, tenantId: string, jobId: string, eventType: string, dedupeKey: string) {
  return transaction.insert(outboxEvents).values({
    tenantId, aggregateType: "import_job", aggregateId: jobId, eventType, payload: { jobId, index: 0 },
    dedupeKey: dedupeKey.slice(0, 200), traceParent: currentTraceParent(),
  }).onConflictDoNothing();
}

export async function createImport(context: StaffContext, input: { bytes: Uint8Array; kind: unknown }): Promise<ImportUploadResult> {
  guard(context);
  if (typeof input.kind !== "string" || !isImportKind(input.kind)) {
    throw new ApiError(400, "validation_error", "Choose what you are importing.", { kind: ["Choose customers, services or appointments."] });
  }
  const kind: ImportKind = input.kind;
  if (input.bytes.length > importLimits.maxBytes) throw new ApiError(413, "file_too_large", fileErrorText("file_too_large"));
  // The type comes from the bytes. A renamed picture or PDF is refused here, whatever its name says.
  let format: "csv" | "xlsx";
  try {
    format = sniffFormat(input.bytes);
  } catch {
    throw new ApiError(400, "unreadable_file", fileErrorText("unreadable_file"));
  }
  const file = await parseOrRefuse(input.bytes);
  const id = randomUUID();
  const storageKey = fileStoreKey(context.tenantId, "import", id);
  const store = getFileStore();
  let stored = false;
  try {
    const row = await withTenant(context.tenantId, async (transaction) => {
      await loadRecordKeys(transaction, context.tenantId, { forWrite: true });
      await store.put(storageKey, sealBytes(context.tenantId, input.bytes));
      stored = true;
      const [created] = await transaction.insert(importJobs).values({
        id, tenantId: context.tenantId, kind, fileFormat: format, fileKey: storageKey, keyVersion: writeKeyVersion(context.tenantId),
        fileBytes: input.bytes.length, rowCount: file.rows.length, startedByUserId: context.userId,
      }).returning();
      if (!created) throw new Error("Import insert returned no row");
      return created;
    });
    return { job: jobView(row), headers: file.headers, suggestedMapping: guessMapping(file.headers, kind), fields: fieldViews(kind) };
  } catch (error) {
    if (stored) await store.remove(storageKey).catch(() => undefined);
    throw error;
  }
}

export async function listImports(context: StaffContext): Promise<{ jobs: ImportJobView[] }> {
  guard(context);
  const rows = await withTenant(context.tenantId, (transaction) => transaction.select().from(importJobs)
    .where(eq(importJobs.tenantId, context.tenantId)).orderBy(desc(importJobs.createdAt)).limit(50));
  return { jobs: rows.map((row) => jobView(row)) };
}

export async function getImport(context: StaffContext, id: string): Promise<{ job: ImportJobView }> {
  guard(context);
  return withTenant(context.tenantId, async (transaction) => {
    const job = await loadJob(transaction, context.tenantId, id);
    return { job: jobView(job, await undoTally(transaction, job)) };
  });
}

/** Only before the import has started. The file goes with it. */
export async function deleteImport(context: StaffContext, id: string): Promise<{ deleted: true }> {
  guard(context);
  return withTenant(context.tenantId, async (transaction) => {
    const job = await loadJob(transaction, context.tenantId, id, true);
    if (!["uploaded", "mapped", "checked", "failed"].includes(job.status)) {
      throw new ApiError(409, "import_in_progress", "This import is running or finished, so it can't be removed now.");
    }
    if (job.fileKey) {
      await transaction.insert(outboxEvents).values({
        tenantId: context.tenantId, aggregateType: "file", aggregateId: job.fileKey, eventType: "file.remove",
        payload: { key: job.fileKey }, dedupeKey: `file.remove:${job.fileKey}`.slice(0, 200), traceParent: currentTraceParent(),
      }).onConflictDoNothing();
    }
    await transaction.delete(importJobs).where(and(eq(importJobs.tenantId, context.tenantId), eq(importJobs.id, id)));
    return { deleted: true as const };
  });
}

function checkMapping(kind: ImportKind, mapping: ImportMapping, headers: readonly string[]): void {
  const known = new Set(importFields[kind].map((field) => field.key));
  const problems: string[] = [];
  for (const [key, index] of Object.entries(mapping)) {
    if (!known.has(key)) problems.push(`${key} is not something you can import here.`);
    else if (index !== null && index >= headers.length) problems.push(`${key} points at a column that is not in the file.`);
  }
  for (const key of missingRequiredFields(kind, mapping)) {
    const label = importFields[kind].find((field) => field.key === key)?.label ?? key;
    problems.push(`Choose a column for ${label}.`);
  }
  if (problems.length > 0) throw new ApiError(400, "validation_error", "Please check the highlighted fields.", { mapping: problems });
}

export async function updateImport(context: StaffContext, id: string, input: ImportUpdateInput): Promise<{ job: ImportJobView; preview: ImportPreviewRow[] }> {
  guard(context);
  return withTenant(context.tenantId, async (transaction) => {
    const job = await loadJob(transaction, context.tenantId, id, true);
    if (job.version !== input.expectedVersion) throw versionConflict();
    if (!["uploaded", "mapped", "checked"].includes(job.status)) {
      throw new ApiError(409, "import_in_progress", "This import can't be changed any more.");
    }
    const kind: ImportKind = isImportKind(job.kind) ? job.kind : "customers";
    const file = await readStoredFile(transaction, job);
    checkMapping(kind, input.mapping, file.headers);
    // Changing the choices voids an earlier check: it described a different import.
    await transaction.delete(importRows).where(and(eq(importRows.tenantId, context.tenantId), eq(importRows.jobId, id)));
    const [updated] = await transaction.update(importJobs).set({
      mapping: input.mapping, options: input.options, status: "mapped", version: job.version + 1,
      readyCount: 0, updateCount: 0, skipCount: 0, errorCount: 0, updatedAt: new Date(),
    }).where(and(eq(importJobs.tenantId, context.tenantId), eq(importJobs.id, id))).returning();
    if (!updated) throw notFound();
    const region = await regionFor(transaction, context.tenantId, input.options);
    return { job: jobView(updated), preview: previewRows(kind, file, input.mapping, { dateFormat: input.options.dateFormat, region, today: new Date().toISOString().slice(0, 10) }) };
  });
}

export async function startCheck(context: StaffContext, id: string): Promise<{ job: ImportJobView }> {
  guard(context);
  return withTenant(context.tenantId, async (transaction) => {
    const job = await loadJob(transaction, context.tenantId, id, true);
    if (!["mapped", "checked"].includes(job.status) || Object.keys(job.mapping).length === 0) {
      throw new ApiError(409, "mapping_needed", "Choose which column is which first.");
    }
    const [updated] = await transaction.update(importJobs).set({ status: "checking", version: job.version + 1, updatedAt: new Date() })
      .where(and(eq(importJobs.tenantId, context.tenantId), eq(importJobs.id, id))).returning();
    if (!updated) throw notFound();
    await queueEvent(transaction, context.tenantId, id, "import.check", `import.check:${id}:${updated.version}:0`);
    return { job: jobView(updated) };
  });
}

export async function listImportRows(
  context: StaffContext,
  id: string,
  query: { status?: ImportRowStatus; cursor?: number; limit: number },
): Promise<{ rows: ImportRowView[]; nextCursor: number | null }> {
  guard(context);
  return withTenant(context.tenantId, async (transaction) => {
    await loadJob(transaction, context.tenantId, id);
    const rows = await transaction.select().from(importRows).where(and(
      eq(importRows.tenantId, context.tenantId), eq(importRows.jobId, id),
      gt(importRows.rowNumber, query.cursor ?? 0),
      ...(query.status ? [eq(importRows.status, query.status)] : []),
    )).orderBy(asc(importRows.rowNumber)).limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    return {
      rows: page.map((row) => ({
        rowNumber: row.rowNumber, status: importRowStatuses.find((status) => status === row.status) ?? "failed",
        errorCode: importErrorCodes.find((code) => code === row.errorCode) ?? null, errorField: row.errorField,
      })),
      nextCursor: rows.length > query.limit ? (page[page.length - 1]?.rowNumber ?? null) : null,
    };
  });
}

export async function startCommit(context: StaffContext, id: string, expectedVersion: number): Promise<{ job: ImportJobView }> {
  guard(context);
  if (!context.userId) throw new ApiError(403, "forbidden", "Sign in as a person to start an import.");
  return withTenant(context.tenantId, async (transaction) => {
    const job = await loadJob(transaction, context.tenantId, id, true);
    if (job.version !== expectedVersion) throw versionConflict();
    if (job.status !== "checked") throw new ApiError(409, "check_needed", "Check the file first, then import.");
    const mapping = mappingSchema.safeParse(job.mapping);
    const options = importOptionsSchema.safeParse({ ...defaultImportOptions, ...job.options });
    if (!mapping.success || !options.success) throw new ApiError(409, "mapping_needed", "Choose which column is which first.");
    // Consent is a promise the owner makes. A consent column with no ticked box does not start.
    if (job.kind === "customers" && (mapping.data.messagingConsent ?? null) !== null && !options.data.consentConfirmed) {
      throw new ApiError(400, "consent_not_confirmed", "Tick the box to confirm your customers agreed to text messages, or remove that column.", { consentConfirmed: ["Confirm you hold this consent."] });
    }
    if (job.readyCount + job.updateCount === 0) throw new ApiError(400, "nothing_to_import", "No rows are ready to import. Fix the errors and upload the file again.");
    const [updated] = await transaction.update(importJobs).set({
      status: "queued", version: job.version + 1, startedAt: new Date(), startedByUserId: context.userId,
      createdCount: 0, updatedCount: 0, skippedCount: 0, failedCount: 0, updatedAt: new Date(),
    }).where(and(eq(importJobs.tenantId, context.tenantId), eq(importJobs.id, id))).returning();
    if (!updated) throw notFound();
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "import.started", outcome: "success",
      metadata: { importId: id, kind: job.kind, ready: job.readyCount, update: job.updateCount, skip: job.skipCount, errors: job.errorCount },
    });
    await queueEvent(transaction, context.tenantId, id, "import.commit", `import.commit:${id}:0`);
    return { job: jobView(updated) };
  });
}

export async function startUndo(context: StaffContext, id: string): Promise<{ job: ImportJobView }> {
  guard(context);
  return withTenant(context.tenantId, async (transaction) => {
    const job = await loadJob(transaction, context.tenantId, id, true);
    if (job.status !== "done" || !job.undoUntil || job.undoUntil.getTime() <= Date.now()) {
      throw new ApiError(409, "undo_unavailable", "This import can no longer be undone.");
    }
    const [updated] = await transaction.update(importJobs).set({ status: "undoing", version: job.version + 1, updatedAt: new Date() })
      .where(and(eq(importJobs.tenantId, context.tenantId), eq(importJobs.id, id))).returning();
    if (!updated) throw notFound();
    await queueEvent(transaction, context.tenantId, id, "import.undo", `import.undo:${id}:0`);
    return { job: jobView(updated) };
  });
}

/** The rows that failed, as a CSV to fix and upload again. Built here from the encrypted file; no copy is kept. */
export async function importErrorFile(context: StaffContext, id: string): Promise<{ csv: string; filename: string }> {
  guard(context);
  return withTenant(context.tenantId, async (transaction) => {
    const job = await loadJob(transaction, context.tenantId, id);
    const failed = await transaction.select({ rowNumber: importRows.rowNumber, code: importRows.errorCode, field: importRows.errorField })
      .from(importRows).where(and(eq(importRows.tenantId, context.tenantId), eq(importRows.jobId, id), inArray(importRows.status, ["error", "failed"])))
      .orderBy(asc(importRows.rowNumber));
    const file = await readStoredFile(transaction, job);
    const kind: ImportKind = isImportKind(job.kind) ? job.kind : "customers";
    return {
      csv: buildErrorCsv(kind, file, failed.map((row) => ({ rowNumber: row.rowNumber, code: importErrorCodes.find((code) => code === row.code) ?? null, field: row.field }))),
      filename: `${kind}-rows-to-fix.csv`,
    };
  });
}
