import type { FileStore } from "@/server/file-store";

import { importLimits } from "./contracts";
import { importerFor } from "./importers";
import {
  auditImport,
  failJob,
  forgetParsedFile,
  importSettings,
  jobKind,
  loadParsedFile,
  lockJob,
  queueImportEvent,
  readJobSettings,
  recountJob,
  writeRows,
  type JobRow,
  type RowOutcome,
  type TenantDb,
} from "./job-db";
import type { ParsedFile } from "./parse";
import { newCheckState, type CheckState, type ImportContext } from "./kinds";

/**
 * The three worker events behind an import. Each handles one chunk (check, 500 rows) or batch (commit and undo, 200 rows)
 * inside the transaction the outbox gives it, then queues the next one, so totals move forward as the job runs and one
 * event never holds a long transaction. Every step rereads the job and the rows by their current status, so a retried
 * event repeats nothing.
 */

export interface ImportDeps {
  databaseUrl?: string;
  store?: FileStore;
}

// What the check has seen so far, kept between the chunks of one job. A chunk that finds nothing here rebuilds it.
let checkMemory: { key: string; state: CheckState } | undefined;

function cloneState(state: CheckState): CheckState {
  return {
    nextRow: state.nextRow,
    phones: new Set(state.phones),
    emails: new Set(state.emails),
    names: new Set(state.names),
    booked: new Map([...state.booked].map(([key, spans]) => [key, spans.map(([from, to]): [number, number] => [from, to])])),
  };
}

async function buildContext(tenantDb: TenantDb, tenantId: string, job: JobRow, deps: ImportDeps, withFile: boolean): Promise<ImportContext | "failed"> {
  const kind = jobKind(job);
  const settings = readJobSettings(job);
  if (!kind || !settings) {
    await failJob(tenantDb, tenantId, job.id, "import_failed");
    return "failed";
  }
  let file: ParsedFile = { format: "csv", headers: [], rows: [] };
  if (withFile) {
    const loaded = await loadParsedFile(tenantDb, tenantId, job, deps.store);
    if (!loaded.ok) {
      await failJob(tenantDb, tenantId, job.id, loaded.code);
      return "failed";
    }
    file = loaded.file;
  }
  return {
    tenantDb, tenantId, job, file, mapping: settings.mapping, options: settings.options,
    settings: await importSettings(tenantDb, tenantId, settings.options), databaseUrl: deps.databaseUrl, store: deps.store,
  };
}

export async function runCheck(tenantDb: TenantDb, tenantId: string, request: { jobId: string; index: number }, deps: ImportDeps): Promise<void> {
  const job = await lockJob(tenantDb, tenantId, request.jobId);
  if (!job || job.status !== "checking") return;
  const context = await buildContext(tenantDb, tenantId, job, deps, true);
  if (context === "failed") return;
  const kind = jobKind(job);
  if (!kind) return;
  const importer = await importerFor(kind);
  const total = context.file.rows.length;
  const start = request.index * importLimits.checkChunk;
  const end = Math.min(start + importLimits.checkChunk, total);
  if (request.index === 0) {
    await tenantDb`delete from import_rows where tenant_id = ${tenantId} and job_id = ${job.id}`;
    await tenantDb`update import_jobs set row_count = ${total}, updated_at = now() where tenant_id = ${tenantId} and id = ${job.id}`;
  }

  const memoryKey = `${tenantId}:${job.id}:${job.version}`;
  let state: CheckState;
  if (checkMemory?.key === memoryKey && checkMemory.state.nextRow === start) {
    state = cloneState(checkMemory.state);
  } else {
    // Another worker took the earlier chunks (or this one restarted): replay them to learn which rows came first.
    state = newCheckState();
    for (let from = 0; from < start; from += importLimits.checkChunk) {
      await importer.check(context, from, Math.min(from + importLimits.checkChunk, start), state);
    }
  }
  const outcomes: RowOutcome[] = await importer.check(context, start, end, state);
  state.nextRow = end;
  await writeRows(tenantDb, tenantId, job.id, outcomes);
  await recountJob(tenantDb, tenantId, job.id);
  checkMemory = { key: memoryKey, state };
  if (end < total) {
    await queueImportEvent(tenantDb, tenantId, job.id, "import.check", request.index + 1, job.version);
    return;
  }
  checkMemory = undefined;
  forgetParsedFile();
  await tenantDb`update import_jobs set status = 'checked', updated_at = now() where tenant_id = ${tenantId} and id = ${job.id}`;
}

export async function runCommit(tenantDb: TenantDb, tenantId: string, request: { jobId: string; index: number }, deps: ImportDeps): Promise<void> {
  const job = await lockJob(tenantDb, tenantId, request.jobId);
  if (!job || (job.status !== "queued" && job.status !== "running")) return;
  const context = await buildContext(tenantDb, tenantId, job, deps, true);
  if (context === "failed") return;
  const kind = jobKind(job);
  if (!kind) return;
  if (job.status === "queued") {
    await tenantDb`update import_jobs set status = 'running', updated_at = now() where tenant_id = ${tenantId} and id = ${job.id}`;
  }
  const importer = await importerFor(kind);
  const from = request.index * importLimits.commitBatch;
  const rows = await tenantDb<{ row_number: number; status: "ready" | "will_update"; entity_id: string | null }[]>`
    select row_number, status, entity_id from import_rows
    where tenant_id = ${tenantId} and job_id = ${job.id} and row_number > ${from} and row_number <= ${from + importLimits.commitBatch}
      and status in ('ready', 'will_update')
    order by row_number`;
  const results = await importer.commit(context, rows.map((row) => ({ rowNumber: row.row_number, status: row.status, entityId: row.entity_id })));
  await writeRows(tenantDb, tenantId, job.id, results.map((result) => ({
    rowNumber: result.rowNumber, status: result.status, code: result.code, field: result.field, entityId: result.entityId,
  })));
  await recountJob(tenantDb, tenantId, job.id);
  const total = context.file.rows.length;
  if (from + importLimits.commitBatch < total) {
    await queueImportEvent(tenantDb, tenantId, job.id, "import.commit", request.index + 1);
    return;
  }
  // Rows the check chose to leave alone are now final: they were skipped.
  await tenantDb`update import_rows set status = 'skipped', updated_at = now() where tenant_id = ${tenantId} and job_id = ${job.id} and status = 'will_skip'`;
  await recountJob(tenantDb, tenantId, job.id);
  await tenantDb`
    update import_jobs set status = 'done', finished_at = now(), undo_until = now() + ${importLimits.undoDays} * interval '1 day', updated_at = now()
    where tenant_id = ${tenantId} and id = ${job.id}`;
  const [counts] = await tenantDb<{ created_count: number; updated_count: number; skipped_count: number; failed_count: number; error_count: number }[]>`
    select created_count, updated_count, skipped_count, failed_count, error_count from import_jobs where tenant_id = ${tenantId} and id = ${job.id}`;
  await auditImport(tenantDb, tenantId, "import.finished", job.started_by_user_id, {
    importId: job.id, kind, created: counts?.created_count ?? 0, updated: counts?.updated_count ?? 0,
    skipped: counts?.skipped_count ?? 0, failed: counts?.failed_count ?? 0, errors: counts?.error_count ?? 0,
  });
  forgetParsedFile();
}

export async function runUndo(tenantDb: TenantDb, tenantId: string, request: { jobId: string; index: number }, deps: ImportDeps): Promise<void> {
  const job = await lockJob(tenantDb, tenantId, request.jobId);
  if (!job || job.status !== "undoing") return;
  // No file is needed: the rows name what the import made.
  const context = await buildContext(tenantDb, tenantId, job, deps, false);
  if (context === "failed") return;
  const kind = jobKind(job);
  if (!kind) return;
  const importer = await importerFor(kind);
  const from = request.index * importLimits.commitBatch;
  const rows = await tenantDb<{ row_number: number; entity_id: string; updated_at: Date }[]>`
    select row_number, entity_id, updated_at from import_rows
    where tenant_id = ${tenantId} and job_id = ${job.id} and row_number > ${from} and row_number <= ${from + importLimits.commitBatch}
      and status = 'created' and error_code is null and entity_id is not null
    order by row_number`;
  const results = await importer.undo(context, rows.map((row) => ({ rowNumber: row.row_number, entityId: row.entity_id, at: row.updated_at })));
  for (const result of results) {
    // A removed row is marked undone. A kept one stays "created" with a fixed reason, so a repeat does not look at it again.
    if (result.outcome === "removed") {
      await tenantDb`update import_rows set status = 'undone', updated_at = now() where tenant_id = ${tenantId} and job_id = ${job.id} and row_number = ${result.rowNumber}`;
    } else {
      await tenantDb`update import_rows set error_code = 'in_use', updated_at = now() where tenant_id = ${tenantId} and job_id = ${job.id} and row_number = ${result.rowNumber}`;
    }
  }
  await recountJob(tenantDb, tenantId, job.id);
  if (from + importLimits.commitBatch < job.row_count) {
    await queueImportEvent(tenantDb, tenantId, job.id, "import.undo", request.index + 1);
    return;
  }
  const [tally] = await tenantDb<{ removed: number; kept: number }[]>`
    select count(*) filter (where status = 'undone')::int as removed,
      count(*) filter (where status = 'created' and error_code = 'in_use')::int as kept
    from import_rows where tenant_id = ${tenantId} and job_id = ${job.id}`;
  await tenantDb`update import_jobs set status = 'undone', undone_at = now(), updated_at = now() where tenant_id = ${tenantId} and id = ${job.id}`;
  await auditImport(tenantDb, tenantId, "import.undone", job.started_by_user_id, {
    importId: job.id, kind, removed: tally?.removed ?? 0, kept: tally?.kept ?? 0,
  });
}
