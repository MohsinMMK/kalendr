import type { KalendrTransaction } from "@/db/client";
import { ApiError } from "@/server/api-error";
import { assertSlotOfferable, type CommitSlotCheck, type CommitSlotResult } from "@/server/slot-engine/commit";

/**
 * Staff booking into a time the engine says is not open (feature 43, step 10). Only the soft rules can be gone past:
 * how soon, how far ahead and the booking limits. Hours, time off, other bookings and rooms still apply, and the
 * database overlap constraint still refuses a true double booking of the same person.
 *
 * Without an override reason, a time that is closed only by a soft rule is refused with `outside_booking_rules` (a
 * message the screen answers by asking for a reason), instead of the plain "no longer available". With one, the
 * soft rules are left out and the caller records the reason code (a fixed list, never free text) in the audit trail.
 */
export async function assertOfferableOrOverride(
  transaction: KalendrTransaction,
  check: CommitSlotCheck,
  overridden: boolean,
): Promise<CommitSlotResult> {
  // A walk-in already ignores notice and window.
  if (check.mode !== "standard") return assertSlotOfferable(transaction, overridden ? { ...check, overrideLimits: true } : check);
  if (overridden) return assertSlotOfferable(transaction, { ...check, mode: "existing", overrideLimits: true });
  try {
    return await assertSlotOfferable(transaction, check);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "slot_unavailable") throw error;
    try {
      await assertSlotOfferable(transaction, { ...check, mode: "existing", overrideLimits: true });
    } catch {
      // Closed for a reason that is not a soft rule (hours, someone else's booking): the first answer stands.
      throw error;
    }
    throw new ApiError(409, "outside_booking_rules", error.message);
  }
}
