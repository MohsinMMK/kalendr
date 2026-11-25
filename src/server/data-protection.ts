import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { withTenant } from "@/db/client";
import { auditEvents, idempotencyKeys } from "@/db/schema";

import { ApiError } from "./api-error";
import { canonicalJsonHash } from "./crypto";
import { isPreviewMode } from "./preview-repository";
import { rotateDataKey } from "./keys/ring";
import { drizzleDataKeyStore } from "./record-crypto";
import { uploadScanMode } from "./scan/clamav";
import { requirePermission, type StaffContext } from "./staff-context";

/**
 * Settings → Data protection: the business's encryption key and file checks, and the
 * owner's "Replace key now". Counts only: nothing here reads a record.
 */
export interface DataProtectionStatus {
  /** The key version new data is sealed with. 0 means nothing has been written with a business key yet. */
  keyVersion: number;
  keyCreatedAt: string | null;
  /** Rows and files still sealed with an older key. The worker moves them every few minutes. */
  itemsOnOlderKeys: number;
  filesWaitingForScan: number;
  scanning: "on" | "off" | "required";
  canRotate: boolean;
}

export const rotateInput = z.object({ keyVersion: z.number().int().min(0).max(1_000_000) }).strict();
export type RotateInput = z.infer<typeof rotateInput>;

const ROTATE_ROUTE = "staff.settings.data_protection.rotate";

function canRotate(context: StaffContext): boolean {
  return context.role === "owner" || context.role === "admin";
}

const previewStatus: DataProtectionStatus = {
  keyVersion: 1,
  keyCreatedAt: null,
  itemsOnOlderKeys: 0,
  filesWaitingForScan: 0,
  scanning: "off",
  canRotate: false,
};

export async function getDataProtectionStatus(context: StaffContext): Promise<DataProtectionStatus> {
  requirePermission(context, "settings.manage");
  if (context.preview || isPreviewMode()) return previewStatus;
  const mode = uploadScanMode();
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.execute<{ version: number | null; created_at: Date | string | null; on_older: string; pending: string }>(sql`
      with current_key as (
        select version, created_at from tenant_data_keys
        where tenant_id = ${context.tenantId} and version > 0 and retired_at is null
        order by version desc limit 1
      ), target as (select coalesce((select version from current_key), 1) as version)
      select (select version from current_key) as version, (select created_at from current_key) as created_at,
        (select count(*) from visit_records, target where tenant_id = ${context.tenantId} and key_version < target.version)
          + (select count(*) from forms, target where tenant_id = ${context.tenantId} and response_ciphertext is not null and key_version < target.version)
          + (select count(*) from visit_record_files, target where tenant_id = ${context.tenantId} and key_version < target.version and scan_status in ('clean', 'skipped'))
          + (select count(*) from media_assets, target where tenant_id = ${context.tenantId} and storage_key is not null and key_version < target.version and scan_status in ('clean', 'skipped'))
          as on_older,
        (select count(*) from visit_record_files where tenant_id = ${context.tenantId} and scan_status = 'pending')
          + (select count(*) from media_assets where tenant_id = ${context.tenantId} and scan_status = 'pending') as pending
    `);
    const createdAt = row?.created_at ? new Date(row.created_at).toISOString() : null;
    return {
      keyVersion: Number(row?.version ?? 0),
      keyCreatedAt: createdAt,
      itemsOnOlderKeys: Number(row?.on_older ?? 0),
      filesWaitingForScan: Number(row?.pending ?? 0),
      scanning: mode === "scan" ? "on" : mode === "refuse" ? "required" : "off",
      canRotate: canRotate(context),
    };
  });
}

export interface RotateResult {
  keyVersion: number;
}

/**
 * Makes a new key for the business. New data uses it at once; the worker re-encrypts older
 * data in batches. `keyVersion` is the version the screen showed, so a double click or a stale
 * screen can't rotate twice; the Idempotency-Key makes a retried request return the same answer.
 */
export async function rotateBusinessKey(context: StaffContext, input: RotateInput, idempotencyKey: string): Promise<RotateResult> {
  requirePermission(context, "settings.manage");
  if (context.preview || isPreviewMode()) throw new ApiError(409, "preview_only", "Keys are not used in the preview.");
  if (!canRotate(context)) throw new ApiError(403, "forbidden", "Only the owner or an admin can replace the key.");
  const requestHash = canonicalJsonHash({ keyVersion: input.keyVersion });
  return withTenant(context.tenantId, async (transaction) => {
    const key = await transaction.insert(idempotencyKeys).values({
      tenantId: context.tenantId,
      route: ROTATE_ROUTE,
      key: idempotencyKey,
      requestHash,
    }).onConflictDoNothing().returning({ id: idempotencyKeys.id });
    if (key.length === 0) {
      const [existing] = await transaction.execute<{ request_hash: string; response_body: { keyVersion?: number } | null }>(sql`
        select request_hash, response_body from idempotency_keys
        where tenant_id = ${context.tenantId} and route = ${ROTATE_ROUTE} and key = ${idempotencyKey}
        for update
      `);
      if (existing?.request_hash !== requestHash || typeof existing.response_body?.keyVersion !== "number") {
        throw new ApiError(409, "idempotency_conflict", "That Idempotency-Key was already used for a different request.");
      }
      return { keyVersion: existing.response_body.keyVersion };
    }

    // One rotation at a time per business; the version check below then sees the winner's key.
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext('kalendr.keys.rotate'), hashtext(${context.tenantId}))`);
    const store = drizzleDataKeyStore(transaction);
    const current = (await store.list(context.tenantId))
      .filter((row) => row.version > 0 && row.retiredAt === null)
      .reduce((highest, row) => Math.max(highest, row.version), 0);
    if (current !== input.keyVersion) {
      throw new ApiError(409, "key_changed", "The key was replaced since this screen loaded. Refresh and try again.");
    }
    const keyVersion = await rotateDataKey(store, context.tenantId);
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action: "security.keys.rotated",
      outcome: "success",
      metadata: { version: keyVersion, previousVersion: current, reason: "admin" },
    });
    await transaction.execute(sql`
      update idempotency_keys set response_status = 200, response_body = ${JSON.stringify({ keyVersion })}::jsonb
      where id = ${key[0]!.id}
    `);
    return { keyVersion };
  });
}
