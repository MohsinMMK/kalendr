import type postgres from "postgres";

import { getFileStore, type FileStore } from "@/server/file-store";
import { postgresDataKeyStore } from "@/server/keys/postgres-store";
import { openBytes } from "@/server/keys/records";
import { loadDataKeys } from "@/server/keys/ring";

import {
  defaultImportOptions,
  importOptionsSchema,
  importFileErrorCodes,
  isImportKind,
  mappingSchema,
  type ImportErrorCode,
  type ImportFileErrorCode,
  type ImportKind,
  type ImportMapping,
  type ImportOptions,
  type ImportRowStatus,
} from "./contracts";
import { todayIn } from "./dates";
import { parseImportFile, ImportParseError, type ParsedFile } from "./parse";
import type { RowSettings } from "./validate";

/**
 * Worker-side helpers for an import job: reading it, reading its encrypted file, writing row outcomes and keeping the
 * totals true. Written with postgres.js against the transaction the outbox hands each handler, so a batch's rows and
 * totals commit or roll back together. Nothing here logs; none of it ever holds a cell value in the database.
 */

export type TenantDb = postgres.TransactionSql;

export interface JobRow {
  id: string;
  kind: string;
  file_format: string;
  file_key: string | null;
  row_count: number;
  mapping: unknown;
  options: unknown;
  status: string;
  started_by_user_id: string | null;
  version: number;
  undo_until: Date | null;
}

export async function lockJob(tenantDb: TenantDb, tenantId: string, jobId: string): Promise<JobRow | undefined> {
  const rows = await tenantDb<JobRow[]>`
    select id, kind, file_format, file_key, row_count, mapping, options, status, started_by_user_id, version, undo_until
    from import_jobs where tenant_id = ${tenantId} and id = ${jobId} for update`;
  return rows[0];
}

export function jobKind(job: Pick<JobRow, "kind">): ImportKind | null {
  return isImportKind(job.kind) ? job.kind : null;
}

export function readJobSettings(job: Pick<JobRow, "mapping" | "options">): { mapping: ImportMapping; options: ImportOptions } | null {
  const mapping = mappingSchema.safeParse(job.mapping);
  const options = importOptionsSchema.safeParse({ ...defaultImportOptions, ...(typeof job.options === "object" && job.options ? job.options : {}) });
  return mapping.success && options.success ? { mapping: mapping.data, options: options.data } : null;
}

/** The country numbers without a +code belong to: the owner's choice, else the business's holiday country, else India. */
export async function importSettings(tenantDb: TenantDb, tenantId: string, options: ImportOptions): Promise<RowSettings> {
  const [row] = await tenantDb<{ country: string | null; timezone: string }[]>`
    select (select country from holiday_settings where tenant_id = tenant.id) as country, tenant.timezone
    from tenants as tenant where tenant.id = ${tenantId}`;
  return {
    dateFormat: options.dateFormat,
    region: options.defaultCountry ?? row?.country?.toUpperCase() ?? "IN",
    today: todayIn(row?.timezone ?? "UTC"),
  };
}

// One parsed file is kept between the batches of one job, so a 20,000 row file is not decrypted and read 100 times.
let cached: { key: string; file: ParsedFile } | undefined;

export function forgetParsedFile(): void {
  cached = undefined;
}

export type LoadedFile = { ok: true; file: ParsedFile } | { ok: false; code: ImportFileErrorCode };

export async function loadParsedFile(
  tenantDb: TenantDb,
  tenantId: string,
  job: Pick<JobRow, "id" | "file_key">,
  store: FileStore = getFileStore(),
): Promise<LoadedFile> {
  if (!job.file_key) return { ok: false, code: "file_missing" };
  const key = `${tenantId}:${job.id}:${job.file_key}`;
  if (cached?.key === key) return { ok: true, file: cached.file };
  let bytes: Buffer;
  try {
    await loadDataKeys(postgresDataKeyStore(tenantDb), tenantId);
    bytes = openBytes(tenantId, await store.get(job.file_key));
  } catch {
    return { ok: false, code: "file_missing" };
  }
  try {
    const file = await parseImportFile(bytes);
    cached = { key, file };
    return { ok: true, file };
  } catch (error) {
    return { ok: false, code: error instanceof ImportParseError ? error.code : "unreadable_file" };
  }
}

export interface RowOutcome {
  rowNumber: number;
  status: ImportRowStatus;
  code: ImportErrorCode | null;
  field: string | null;
  entityId: string | null;
}

/** Writes outcomes for a set of rows, replacing any earlier outcome for the same row (a re-check, or a retried batch). */
export async function writeRows(tenantDb: TenantDb, tenantId: string, jobId: string, outcomes: readonly RowOutcome[]): Promise<void> {
  for (let start = 0; start < outcomes.length; start += 500) {
    const values = outcomes.slice(start, start + 500).map((outcome) => ({
      tenant_id: tenantId,
      job_id: jobId,
      row_number: outcome.rowNumber,
      status: outcome.status,
      error_code: outcome.code,
      error_field: outcome.field,
      entity_id: outcome.entityId,
    }));
    await tenantDb`
      insert into import_rows ${tenantDb(values, "tenant_id", "job_id", "row_number", "status", "error_code", "error_field", "entity_id")}
      on conflict (tenant_id, job_id, row_number) do update
      set status = excluded.status, error_code = excluded.error_code, error_field = excluded.error_field,
        entity_id = excluded.entity_id, updated_at = now()`;
  }
}

/** Sets every total from the rows themselves, so a replayed batch can never count a row twice. */
export async function recountJob(tenantDb: TenantDb, tenantId: string, jobId: string): Promise<void> {
  await tenantDb`
    update import_jobs as job set
      ready_count = counted.ready, update_count = counted.will_update, skip_count = counted.will_skip, error_count = counted.error,
      created_count = counted.created, updated_count = counted.updated, skipped_count = counted.skipped, failed_count = counted.failed,
      updated_at = now()
    from (
      select
        count(*) filter (where status = 'ready')::int as ready,
        count(*) filter (where status = 'will_update')::int as will_update,
        count(*) filter (where status = 'will_skip')::int as will_skip,
        count(*) filter (where status = 'error')::int as error,
        count(*) filter (where status = 'created')::int as created,
        count(*) filter (where status = 'updated')::int as updated,
        count(*) filter (where status = 'skipped')::int as skipped,
        count(*) filter (where status = 'failed')::int as failed
      from import_rows where tenant_id = ${tenantId} and job_id = ${jobId}
    ) as counted
    where job.tenant_id = ${tenantId} and job.id = ${jobId}`;
}

export async function failJob(tenantDb: TenantDb, tenantId: string, jobId: string, code: ImportFileErrorCode): Promise<void> {
  const safe = importFileErrorCodes.includes(code) ? code : "import_failed";
  // A failed job's rows are not needed again: do not keep them in memory.
  forgetParsedFile();
  await tenantDb`
    update import_jobs set status = 'failed', failure_code = ${safe}, updated_at = now()
    where tenant_id = ${tenantId} and id = ${jobId}`;
}

export type ImportEvent = "import.check" | "import.commit" | "import.undo";

/** Queues the next chunk or batch. The dedupe key makes queueing it twice harmless. */
export async function queueImportEvent(
  tenantDb: TenantDb,
  tenantId: string,
  jobId: string,
  event: ImportEvent,
  index: number,
  version = 0,
): Promise<void> {
  const payload = { jobId, index };
  await tenantDb`
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    values (${tenantId}, 'import_job', ${jobId}, ${event}, ${tenantDb.json(payload)}, ${version === 0 ? `${event}:${jobId}:${index}` : `${event}:${jobId}:${version}:${index}`})
    on conflict (tenant_id, dedupe_key) do nothing`;
}

export function readEventPayload(payload: unknown): { jobId: string; index: number } | null {
  if (!payload || typeof payload !== "object") return null;
  const { jobId, index } = payload as { jobId?: unknown; index?: unknown };
  if (typeof jobId !== "string" || jobId.length === 0 || jobId.length > 100) return null;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return null;
  return { jobId, index };
}

export async function auditImport(
  tenantDb: TenantDb,
  tenantId: string,
  action: "import.started" | "import.finished" | "import.undone",
  actorUserId: string | null,
  metadata: Record<string, string | number>,
): Promise<void> {
  await tenantDb`
    insert into audit_events (tenant_id, actor_type, actor_user_id, action, outcome, metadata)
    values (${tenantId}, ${actorUserId ? "staff" : "system"}, ${actorUserId}, ${action}, 'success', ${tenantDb.json(metadata)})`;
}
