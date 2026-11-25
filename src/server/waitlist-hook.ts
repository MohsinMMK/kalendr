import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { getPostgresErrorCode } from "./api-error";
import { logger } from "./logger";
import { offerFreedRange, offerSlot, type FreedSlot, type OfferOptions } from "./waitlist-offers";
import { drizzleRunner } from "./workflows/runner";

/**
 * The one-line hooks the cancel, move-away and block-removal paths call (feature 21), inside the transaction that frees
 * the time. They run the offer in a savepoint and never throw: a waitlist problem must not stop a cancellation, so on any
 * error the savepoint is rolled back and the time simply goes to public booking.
 */
type Transaction = { execute(query: SQL): PromiseLike<unknown> };

async function guarded(transaction: Transaction, tenantId: string, what: string, work: () => Promise<unknown>): Promise<void> {
  const run = drizzleRunner(transaction);
  try {
    await run(sql`savepoint waitlist_hook`);
    await work();
    await run(sql`release savepoint waitlist_hook`);
  } catch (error: unknown) {
    // The database asking for a fresh start (two changes at once) is not a waitlist problem: let the whole change start
    // again, so an offer is never quietly skipped while the cancel itself goes through.
    const code = getPostgresErrorCode(error);
    if (code === "40001" || code === "40P01") throw error;
    await run(sql`rollback to savepoint waitlist_hook`).catch(() => undefined);
    logger().warn({ event: "waitlist.hook_failed", tenantId, what, name: error instanceof Error ? error.name : "unknown" }, "A waitlist offer could not be made");
  }
}

/** A booking was cancelled or moved away: offer its old time to the people waiting for it. */
export function offerFreedSlot(transaction: Transaction, tenantId: string, slot: FreedSlot, options?: OfferOptions): Promise<void> {
  return guarded(transaction, tenantId, "slot", () => offerSlot(drizzleRunner(transaction), tenantId, slot, options));
}

/** A closed time was removed or shortened: offer the times it opened up. */
export function offerFreedRangeHook(
  transaction: Transaction, tenantId: string,
  range: { practitionerId: string | null; locationId: string | null; startsAt: Date; endsAt: Date },
): Promise<void> {
  return guarded(transaction, tenantId, "range", () => offerFreedRange(drizzleRunner(transaction), tenantId, range));
}
