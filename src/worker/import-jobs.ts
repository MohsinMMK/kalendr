import type postgres from "postgres";

import { getFileStore, isFileStoreKey, type FileStore } from "../server/file-store";

/**
 * Keeps uploaded import files from lingering (feature 12). The file is kept while an import can still be undone; once
 * the undo window has closed, the import failed or was undone, or an upload sat unfinished for two days, the stored
 * object is removed and the job forgets where it was. Like the storage jobs, it finds businesses with work through a
 * definer function that returns ids only (kalendr_import_tenants), then works inside each business's own scope.
 */

const PURGE_BATCH = 50;

export interface ImportPurgeSummary {
  tenants: number;
  files: number;
}

export async function purgeImportFiles(database: postgres.Sql, options: { store?: FileStore } = {}): Promise<ImportPurgeSummary> {
  const store = options.store ?? getFileStore();
  const tenants = await database<{ tenant_id: string }[]>`select tenant_id from kalendr_import_tenants() as tenant_id`;
  let files = 0;
  for (const { tenant_id: tenantId } of tenants) {
    files += await database.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      const jobs = await tenantDb<{ id: string; file_key: string; status: string }[]>`
        select id, file_key, status from import_jobs
        where tenant_id = ${tenantId} and file_key is not null
          and (status in ('failed', 'undone')
            or (status = 'done' and undo_until < now())
            or (status in ('uploaded', 'mapped', 'checked') and updated_at < now() - interval '2 days'))
        order by updated_at limit ${PURGE_BATCH} for update skip locked`;
      let removed = 0;
      for (const job of jobs) {
        // A key that is not this business's own import object is never touched.
        if (isFileStoreKey(job.file_key) && job.file_key.startsWith(`tenant/${tenantId.replace(/[^A-Za-z0-9_-]/g, "_")}/import/`)) {
          await store.remove(job.file_key);
        }
        // An upload nobody finished can no longer be used: say so, so the screen shows why.
        await tenantDb`
          update import_jobs set file_key = null,
            status = case when status in ('uploaded', 'mapped', 'checked') then 'failed' else status end,
            failure_code = case when status in ('uploaded', 'mapped', 'checked') then 'expired' else failure_code end,
            updated_at = now()
          where tenant_id = ${tenantId} and id = ${job.id}`;
        removed += 1;
      }
      return removed;
    }) as number;
  }
  return { tenants: tenants.length, files };
}
