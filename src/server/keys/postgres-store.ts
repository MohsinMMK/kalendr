/** tenant_data_keys through postgres.js, for the worker. The web app uses the Drizzle store in record-crypto.ts. */
import type postgres from "postgres";

import type { DataKeyStore, StoredDataKey } from "./ring";

export function postgresDataKeyStore(tenantDb: postgres.TransactionSql): DataKeyStore {
  return {
    async list(tenantId) {
      const rows = await tenantDb<{
        version: number;
        provider: StoredDataKey["provider"];
        wrapped_key: Buffer | null;
        master_key_id: string | null;
        created_at: Date;
        retired_at: Date | null;
      }[]>`
        select version, provider, wrapped_key, master_key_id, created_at, retired_at
        from tenant_data_keys where tenant_id = ${tenantId} order by version
      `;
      return rows.map((row) => ({
        version: row.version,
        provider: row.provider,
        wrappedKey: row.wrapped_key,
        masterKeyId: row.master_key_id,
        createdAt: row.created_at,
        retiredAt: row.retired_at,
      }));
    },
    async insert(tenantId, key) {
      const inserted = await tenantDb`
        insert into tenant_data_keys (tenant_id, version, provider, wrapped_key, master_key_id, retired_at)
        values (${tenantId}, ${key.version}, ${key.provider}, ${key.wrappedKey}, ${key.masterKeyId},
          ${key.retired ? new Date() : null})
        on conflict (tenant_id, version) do nothing
        returning version
      `;
      return inserted.length > 0;
    },
  };
}
