import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { withTenant } from "@/db/client";
import { outboxEvents } from "@/db/schema";

import { ApiError } from "../api-error";
import { sha256 } from "../crypto";
import { adminCall } from "./db";

/** Pauses or resumes a business's public pages. The database function also writes the business's own activity row. */
export async function setTenantPaused(adminUserId: string, tenantId: string, paused: boolean, reason: string): Promise<void> {
  await adminCall((database) => database.execute(sql`select admin_set_tenant_paused(${adminUserId}, ${tenantId}, ${paused}, ${reason})`));
}

// The worker handler (src/worker/handlers/verification-resend.ts) owns the same name; kept as a literal so the web app does not import worker code.
export const VERIFICATION_RESEND_EVENT = "account.verification.resend";

const ownerSchema = z.object({ user_id: z.string(), email_verified: z.boolean() });

/**
 * "Resend verification email" for the business's owner. The console never sees the address: this records the action,
 * then queues an outbox event the worker answers with its own database role. The Idempotency-Key becomes the outbox
 * dedupe key, so a double click queues one email and records one action.
 */
export async function queueVerificationResend(adminUserId: string, tenantId: string, reason: string, idempotencyKey: string): Promise<{ queued: boolean; alreadyVerified: boolean }> {
  const rows = await adminCall((database) => database.execute(sql`select * from admin_tenant_owner(${adminUserId}, ${tenantId})`));
  const owner = z.array(ownerSchema).parse([...rows])[0];
  if (!owner) throw new ApiError(404, "not_found", "That business has no owner to email.");
  if (owner.email_verified) return { queued: false, alreadyVerified: true };
  const inserted = await withTenant(tenantId, (transaction) => transaction.insert(outboxEvents).values({
    tenantId,
    aggregateType: "user",
    aggregateId: owner.user_id,
    eventType: VERIFICATION_RESEND_EVENT,
    payload: { userId: owner.user_id },
    dedupeKey: `admin-verify:${sha256(`${adminUserId}:${idempotencyKey}`).slice(0, 40)}`,
  }).onConflictDoNothing().returning({ id: outboxEvents.id }));
  if (inserted.length > 0) {
    await adminCall((database) => database.execute(sql`select admin_record_action(${adminUserId}, ${tenantId}, 'admin.tenant.resend_verification', ${reason}, ${JSON.stringify({ ownerId: owner.user_id })}::jsonb)`));
  }
  return { queued: true, alreadyVerified: false };
}
