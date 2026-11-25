import "server-only";

import { createHmac } from "node:crypto";

import { sql } from "drizzle-orm";

import { type KalendrTransaction, withTenant } from "@/db/client";
import { auditEvents, idempotencyKeys } from "@/db/schema";
import { type BlocklistKind, contactKeys } from "@/lib/spam-contact";

import { ApiError } from "./api-error";
import { env } from "./env";

/**
 * The booking-path half of spam protection (feature 44). Kept free of the booking code's imports so the commit can call
 * it without a cycle. Staff-side reporting and the blocklist screens are in `spam.ts`.
 */

/** The same keyed hash for every caller, so a value hashed when it is added matches the one hashed at booking. */
export function blockValueHash(tenantId: string, kind: BlocklistKind, normalized: string): string {
  const secret = env().BETTER_AUTH_SECRET;
  if (!secret) throw new ApiError(503, "spam_unavailable", "Spam protection is unavailable right now.");
  const tenantKey = createHmac("sha256", secret).update(`blocklist-key\0${tenantId}`).digest();
  return createHmac("sha256", tenantKey).update(`${kind}\0${normalized}`).digest("hex");
}

/** The kind of the first blocklist entry the contact matches, or null. Email is checked before phone, then the domain. */
export async function findBlockMatch(
  transaction: KalendrTransaction,
  tenantId: string,
  contact: { email?: string | null; phone?: string | null },
): Promise<BlocklistKind | null> {
  const keys = contactKeys(contact);
  if (keys.length === 0) return null;
  const hashes = keys.map((key) => ({ kind: key.kind, hash: blockValueHash(tenantId, key.kind, key.value) }));
  const rows = await transaction.execute<{ kind: BlocklistKind }>(sql`
    select kind from blocklist_entries
    where tenant_id = ${tenantId}
      and (kind, value_hash) in (${sql.join(hashes.map((entry) => sql`(${entry.kind}, ${entry.hash})`), sql`, `)})
  `);
  const found = new Set(rows.map((row) => row.kind));
  return (["email", "phone", "email_domain"] as const).find((kind) => found.has(kind)) ?? null;
}

/**
 * Thrown from inside the booking transaction once every step of a real booking has run, so the work (and the time it
 * takes) is the same, and the transaction rolls back. It carries the success body the caller sees.
 */
export class SilentRefusal extends Error {
  constructor(
    readonly response: Record<string, unknown>,
    readonly matched: BlocklistKind,
    readonly ownHoldId: string | null,
  ) {
    super("silent_refusal");
    this.name = "SilentRefusal";
  }
}

/**
 * After the rollback: one audit row with no contact details, the stored response so a retry with the same key replays it,
 * and the customer's own hold released (the rollback brought it back).
 */
export async function recordSilentRefusal(
  tenantId: string,
  refusal: SilentRefusal,
  idempotency: { route: string; key: string; requestHash: string },
): Promise<void> {
  await withTenant(tenantId, async (transaction) => {
    await transaction.insert(auditEvents).values({
      tenantId,
      actorType: "patient",
      action: "booking.refused_blocklist",
      outcome: "refused",
      metadata: { source: "public_booking", matched: refusal.matched },
    });
    await transaction.insert(idempotencyKeys).values({
      tenantId,
      route: idempotency.route,
      key: idempotency.key,
      requestHash: idempotency.requestHash,
      responseStatus: 201,
      responseBody: refusal.response,
    }).onConflictDoNothing();
    if (refusal.ownHoldId) {
      await transaction.execute(sql`delete from slot_holds where tenant_id = ${tenantId} and id = ${refusal.ownHoldId}`);
    }
  });
}
