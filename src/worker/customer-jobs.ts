import type postgres from "postgres";

/**
 * Customer profiles (feature 27): a merge can be undone for 30 days. Once that time has passed the saved details of
 * the merged profile (its phone and email, sealed) are dropped, so they are not kept for no reason. The row stays as
 * the record that the merge happened.
 */
export interface CustomerJobSummary {
  tenants: number;
  rows: number;
}

export async function purgeMergeSnapshots(database: postgres.Sql): Promise<CustomerJobSummary> {
  const tenants = await database<{ tenant_id: string }[]>`select tenant_id from kalendr_crm_tenants('merge_purge') as tenant_id`;
  let rows = 0;
  for (const { tenant_id: tenantId } of tenants) {
    rows += await database.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      const purged = await tenantDb`
        update customer_merges set snapshot_ciphertext = null
        where tenant_id = ${tenantId} and snapshot_ciphertext is not null and undo_until < now()
        returning id`;
      return purged.length;
    }) as number;
  }
  return { tenants: tenants.length, rows };
}
