import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { rolloutRowSchema, type RolloutRow, rolloutInputSchema } from "@/lib/admin-contracts";

import { adminCall, isoTime } from "./db";

const rowSchema = z.object({
  feature_key: z.string(),
  mode: z.enum(["off", "listed", "percent", "all"]),
  percent: z.number().int(),
  tenant_ids: z.array(z.string()),
  updated_at: isoTime,
});

/** The runtime role may read `feature_rollouts` (it only says which features are on, for whom). */
export async function listRollouts(): Promise<RolloutRow[]> {
  const rows = await adminCall((database) => database.execute(sql`select feature_key, mode, percent, tenant_ids, updated_at from feature_rollouts order by feature_key`));
  return z.array(rowSchema).parse([...rows]).map((row) => rolloutRowSchema.parse({ featureKey: row.feature_key, mode: row.mode, percent: row.percent, tenantIds: row.tenant_ids, updatedAt: row.updated_at }));
}

export async function setRollout(adminUserId: string, input: z.infer<typeof rolloutInputSchema>): Promise<void> {
  // A list only means something in "listed" mode; keeping stale ids around in other modes would surprise whoever switches back.
  const tenantIds = input.mode === "listed" ? input.tenantIds : [];
  const percent = input.mode === "percent" ? input.percent : 0;
  const array = sql`array[${sql.join(tenantIds.map((id) => sql`${id}`), sql`, `)}]::text[]`;
  await adminCall((database) => database.execute(sql`
    select admin_set_feature_rollout(${adminUserId}, ${input.featureKey}, ${input.mode}, ${percent}, ${tenantIds.length ? array : sql`'{}'::text[]`}, ${input.reason})
  `));
}
