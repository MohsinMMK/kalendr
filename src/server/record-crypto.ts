import "server-only";

import { eq } from "drizzle-orm";

import { type KalendrTransaction, withTenant } from "@/db/client";
import { tenantDataKeys } from "@/db/schema";

import { loadDataKeys, type DataKeyStore, type StoredDataKey } from "./keys/ring";

/**
 * Record encryption for the web app. Each business has its own data keys (see
 * src/server/keys/). Before sealing or opening, load the business's keys inside the same
 * transaction that reads or writes the rows:
 *
 *   await loadRecordKeys(transaction, tenantId, { forWrite: true });
 *   const sealed = sealText(tenantId, body);
 *
 * Records written before feature 10 carry the "v1" header and open with KALENDR_RECORDS_KEY
 * (key version 0) without any loading.
 */
export {
  keyVersionOf,
  keyVersionOfText,
  openBytes,
  openText,
  sealBytes,
  sealText,
  writeKeyVersion,
} from "./keys/records";

export function drizzleDataKeyStore(transaction: KalendrTransaction): DataKeyStore {
  return {
    async list(tenantId) {
      const rows = await transaction
        .select()
        .from(tenantDataKeys)
        .where(eq(tenantDataKeys.tenantId, tenantId))
        .orderBy(tenantDataKeys.version);
      return rows.map((row) => ({
        version: row.version,
        provider: row.provider as StoredDataKey["provider"],
        wrappedKey: row.wrappedKey ? Buffer.from(row.wrappedKey) : null,
        masterKeyId: row.masterKeyId,
        createdAt: row.createdAt,
        retiredAt: row.retiredAt,
      }));
    },
    async insert(tenantId, key) {
      const inserted = await transaction
        .insert(tenantDataKeys)
        .values({
          tenantId,
          version: key.version,
          provider: key.provider,
          wrappedKey: key.wrappedKey,
          masterKeyId: key.masterKeyId,
          retiredAt: key.retired ? new Date() : null,
        })
        .onConflictDoNothing()
        .returning({ version: tenantDataKeys.version });
      return inserted.length > 0;
    },
  };
}

/** Loads a business's data keys inside a transaction. With forWrite, makes its first key if it has none. */
export function loadRecordKeys(
  transaction: KalendrTransaction,
  tenantId: string,
  options: { forWrite?: boolean } = {},
): Promise<number> {
  return loadDataKeys(drizzleDataKeyStore(transaction), tenantId, options);
}

/** The same, in a short transaction of its own (for work that seals before its main transaction starts). */
export function prepareRecordKeys(tenantId: string, options: { forWrite?: boolean } = {}): Promise<number> {
  return withTenant(tenantId, (transaction) => loadRecordKeys(transaction, tenantId, options));
}
