import { fileStoreKey, getFileStore, isFileStoreKey, type FileStore } from "../../server/file-store";
import { loadDataKeys } from "../../server/keys/ring";
import { postgresDataKeyStore } from "../../server/keys/postgres-store";
import { openBytes } from "../../server/keys/records";
import { configuredScanner, type Scanner } from "../../server/scan/clamav";
import type { EventHandler, TenantDb } from "./types";

export interface ScanFileDependencies {
  /** Null when no scanner is set up: the event waits and is retried. */
  scanner?: () => Scanner | null;
  store?: () => FileStore;
}

type ScanTable = "visit_record_files" | "media_assets";

interface PendingFile {
  id: string;
  storage_key: string;
  scan_status: string;
}

function readPayload(payload: unknown): { table: ScanTable; id: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const { table, id } = payload as { table?: unknown; id?: unknown };
  if (table !== "visit_record_files" && table !== "media_assets") return null;
  if (typeof id !== "string" || id.length === 0 || id.length > 100) return null;
  return { table, id };
}

async function lockFile(tenantDb: TenantDb, tenantId: string, table: ScanTable, id: string): Promise<PendingFile | undefined> {
  const rows = table === "visit_record_files"
    ? await tenantDb<PendingFile[]>`
        select id, storage_key, scan_status from visit_record_files
        where tenant_id = ${tenantId} and id = ${id} for update`
    : await tenantDb<PendingFile[]>`
        select id, storage_key, scan_status from media_assets
        where tenant_id = ${tenantId} and id = ${id} and storage_key is not null for update`;
  return rows[0];
}

/**
 * Queues the stored object for removal once this change commits, like the web app does.
 * purge also removes the bucket's earlier versions, for a file that carried a virus.
 */
export async function queueFileRemoval(tenantDb: TenantDb, tenantId: string, key: string, options: { purge?: boolean } = {}): Promise<void> {
  const payload = options.purge ? { key, purge: true } : { key };
  await tenantDb`
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    values (${tenantId}, 'file', ${key}, 'file.remove', ${tenantDb.json(payload)}, ${`file.remove:${key}`.slice(0, 200)})
    on conflict (tenant_id, dedupe_key) do nothing
  `;
}

/**
 * Scans one uploaded file with ClamAV. Until this runs the file is "pending": nobody can
 * open, share or see it. A clean file becomes usable. An infected file's bytes are removed;
 * a record file stays listed as "removed, virus found" so the person who added it knows,
 * and a picture is deleted. Both write an audit row naming the signature only.
 */
export function scanFileHandler(dependencies: ScanFileDependencies = {}): EventHandler {
  const scannerFor = dependencies.scanner ?? configuredScanner;
  const storeFor = dependencies.store ?? getFileStore;
  return async (tenantDb, event) => {
    const target = readPayload(event.payload);
    if (!target) return { outcome: "dead", code: "invalid_payload" };
    const file = await lockFile(tenantDb, event.tenantId, target.table, target.id);
    // Removed since, or already scanned: nothing to do.
    if (!file || file.scan_status !== "pending") return "delivered";
    const scanner = scannerFor();
    if (!scanner) return { outcome: "retry", code: "scanner_unavailable" };

    await loadDataKeys(postgresDataKeyStore(tenantDb), event.tenantId);
    let plain: Buffer;
    try {
      plain = openBytes(event.tenantId, await storeFor().get(file.storage_key));
    } catch {
      return { outcome: "retry", code: "file_unreadable" };
    }
    let result;
    try {
      result = await scanner.scan(plain);
    } catch {
      return { outcome: "retry", code: "scanner_unreachable" };
    }

    if (result.status === "clean") {
      if (target.table === "visit_record_files") {
        await tenantDb`
          update visit_record_files set scan_status = 'clean', scanned_at = now()
          where tenant_id = ${event.tenantId} and id = ${file.id}`;
      } else {
        await tenantDb`update media_assets set scan_status = 'clean' where tenant_id = ${event.tenantId} and id = ${file.id}`;
      }
      return "delivered";
    }

    await queueFileRemoval(tenantDb, event.tenantId, file.storage_key, { purge: true });
    if (target.table === "visit_record_files") {
      const [row] = await tenantDb<{ record_id: string; uploaded_by_user_id: string | null }[]>`
        update visit_record_files set scan_status = 'infected', scanned_at = now()
        where tenant_id = ${event.tenantId} and id = ${file.id}
        returning record_id, uploaded_by_user_id`;
      await tenantDb`
        insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
        values (${event.tenantId}, 'system', 'record.file.infected', 'denied', ${tenantDb.json({
          recordId: row?.record_id ?? null,
          fileId: file.id,
          uploadedByUserId: row?.uploaded_by_user_id ?? null,
          signature: result.signature.slice(0, 200),
        })})`;
    } else {
      const [row] = await tenantDb<{ kind: string; owner_id: string }[]>`
        delete from media_assets where tenant_id = ${event.tenantId} and id = ${file.id}
        returning kind, owner_id`;
      await tenantDb`
        insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
        values (${event.tenantId}, 'system', 'media.infected', 'denied', ${tenantDb.json({
          mediaId: file.id,
          kind: row?.kind ?? null,
          ownerId: row?.owner_id ?? null,
          signature: result.signature.slice(0, 200),
        })})`;
    }
    return "delivered";
  };
}

/** Removes a stored object whose row was deleted. Safe to repeat: removing a missing object succeeds. */
export function fileRemoveHandler(dependencies: Pick<ScanFileDependencies, "store"> = {}): EventHandler {
  const storeFor = dependencies.store ?? getFileStore;
  return async (tenantDb, event) => {
    const payload = event.payload as { key?: unknown; purge?: unknown } | null;
    const key = payload?.key;
    // Only this business's own objects: tenant/{id}/… now, and {id}/… for files from before feature 10.
    const ownPrefix = fileStoreKey(event.tenantId, "media", "-").slice(0, -"media/-".length);
    const legacyPrefix = ownPrefix.slice("tenant/".length);
    if (typeof key !== "string" || !isFileStoreKey(key) || !(key.startsWith(ownPrefix) || (key.split("/").length === 2 && key.startsWith(legacyPrefix)))) {
      return { outcome: "dead", code: "invalid_payload" };
    }
    // A row that still points at the key (a repeated upload of the same id) keeps its object.
    const [inUse] = await tenantDb`
      select 1 from visit_record_files where tenant_id = ${event.tenantId} and storage_key = ${key} and scan_status <> 'infected'
      union all
      select 1 from media_assets where tenant_id = ${event.tenantId} and storage_key = ${key}
      limit 1`;
    if (inUse) return "delivered";
    try {
      await storeFor().remove(key, { allVersions: payload?.purge === true });
    } catch {
      return { outcome: "retry", code: "store_unavailable" };
    }
    return "delivered";
  };
}
