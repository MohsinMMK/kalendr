import "server-only";

import { sql } from "drizzle-orm";

import type { KalendrTransaction as TenantTransaction } from "@/db/client";
import { idempotencyKeys } from "@/db/schema";

import { ApiError } from "./api-error";
import { canonicalJsonHash } from "./crypto";

/**
 * Claims an Idempotency-Key for this route. Returns the stored answer when the same request
 * was already made (a double click, a retried network call), or the claim to finish.
 */
export async function claimKey<T>(transaction: TenantTransaction, tenantId: string, route: string, key: string, request: unknown): Promise<{ replay: T } | { claimId: string }> {
  const requestHash = canonicalJsonHash(request);
  const [claim] = await transaction.insert(idempotencyKeys).values({ tenantId, route, key, requestHash })
    .onConflictDoNothing().returning({ id: idempotencyKeys.id });
  if (claim) return { claimId: claim.id };
  const [existing] = await transaction.execute<{ request_hash: string; response_body: T | null }>(sql`
    select request_hash, response_body from idempotency_keys
    where tenant_id = ${tenantId} and route = ${route} and key = ${key}
    for update
  `);
  if (!existing || existing.request_hash !== requestHash || existing.response_body === null) {
    throw new ApiError(409, "idempotency_conflict", "That Idempotency-Key was already used for a different request.");
  }
  return { replay: existing.response_body };
}

/** Saves the answer so a repeat of the same request gets it back instead of acting twice. */
export async function finishKey(transaction: TenantTransaction, claimId: string, response: unknown): Promise<void> {
  await transaction.execute(sql`
    update idempotency_keys set response_status = 200, response_body = ${JSON.stringify(response)}::jsonb where id = ${claimId}
  `);
}
