import { randomUUID } from "node:crypto";

import type postgres from "postgres";

import type { HandlerRegistry } from "@/worker/handlers";
import { processClaimedEvent } from "@/worker/outbox-worker";

/**
 * Works one business's due outbox rows until nothing is due, the way the worker does, without touching any other
 * business's rows. Tests share one database and run files side by side, so the worker's all-business claim would
 * let one test's drain take another test's rows.
 */
export async function drainTenantOutbox(database: postgres.Sql, tenantId: string, handlers: HandlerRegistry, rounds = 40): Promise<number> {
  let handled = 0;
  for (let round = 0; round < rounds; round += 1) {
    const token = `test:${randomUUID()}`;
    const claimed = await database.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${tenantId}, true)`;
      const rows = await transaction<{ id: string }[]>`
        with due as (
          select id from outbox_events
          where tenant_id = ${tenantId} and status in ('pending', 'failed') and available_at <= now()
          order by available_at, id
          for update skip locked
          limit 1
        )
        update outbox_events as event
        set status = 'processing', locked_at = now(), locked_by = ${token}, attempt_count = event.attempt_count + 1, updated_at = now()
        from due where event.tenant_id = ${tenantId} and event.id = due.id
        returning event.id
      `;
      return rows[0];
    });
    if (!claimed) return handled;
    await processClaimedEvent(database, { tenantId, id: claimed.id, leaseToken: token }, { handlers });
    handled += 1;
  }
  return handled;
}
