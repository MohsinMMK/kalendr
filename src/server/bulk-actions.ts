import { BULK_MAX, type BulkInput, type BulkResult } from "@/lib/bookings-list";
import { ApiError } from "@/server/api-error";
import { withLockedStaffAppointment } from "@/server/appointment-tx";
import { approveRequestIn } from "@/server/approval";
import { cancelByStaffIn } from "@/server/cancel-actions";
import { reportBookingIn } from "@/server/spam";
import { sendQuickMessage } from "@/server/quick-messages";
import { requirePermission, type StaffContext } from "@/server/staff-context";
import { markNoShowIn, reassignIn } from "@/server/visit-actions";

/**
 * Bulk actions on up to 100 bookings (feature 43). Every booking runs through the same single-booking function a
 * person would use, in its own transaction with its own version check, so one failure never undoes the rest. The
 * answer lists what worked and what did not, with a reason in plain words for each failure.
 */

function reasonFor(error: unknown): { code: string; message: string } {
  if (error instanceof ApiError) return { code: error.code, message: error.message };
  // Anything unexpected is reported without its details; those belong in the server's logs, not on a screen.
  return { code: "unexpected_error", message: "Something went wrong with this one. Try it again on its own." };
}

export async function runBulkAction(context: StaffContext, input: BulkInput, idempotencyKey: string): Promise<BulkResult> {
  requirePermission(context, input.action === "mark_no_show" || input.action === "message" ? "appointments.status" : "appointments.book");
  if (context.preview) throw new ApiError(400, "preview_only", "Bulk actions need a database.");
  if (input.items.length > BULK_MAX) throw new ApiError(400, "validation_error", `Choose up to ${BULK_MAX} bookings at a time.`);
  const actor = { type: "staff" as const, ...(context.userId ? { userId: context.userId } : {}) };
  const seen = new Set<string>();
  const results: BulkResult["results"] = [];
  for (const item of input.items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    try {
      switch (input.action) {
        case "confirm":
          await withLockedStaffAppointment(context, item.id, item.expectedVersion, (transaction, current) => approveRequestIn(transaction, current, actor));
          break;
        case "cancel":
          await withLockedStaffAppointment(context, item.id, item.expectedVersion, (transaction, current) =>
            cancelByStaffIn(transaction, current, actor, { ...(input.presetId ? { presetId: input.presetId } : {}), ...(input.notifyCustomers === false ? { notifyCustomer: false } : {}) }));
          break;
        case "report_spam":
          await withLockedStaffAppointment(context, item.id, item.expectedVersion, (transaction, current) =>
            reportBookingIn(transaction, current, actor, { reasonCode: input.reasonCode ?? "other" }));
          break;
        case "mark_no_show":
          await withLockedStaffAppointment(context, item.id, item.expectedVersion, (transaction, current) => markNoShowIn(transaction, current, actor, "customer"));
          break;
        case "reassign":
          await withLockedStaffAppointment(context, item.id, item.expectedVersion, (transaction, current) =>
            reassignIn(transaction, current, actor, { practitionerId: input.practitionerId ?? "" }));
          break;
        case "message":
          await sendQuickMessage(
            context, item.id,
            input.messageKind === "running_late" ? { kind: "running_late", delayMinutes: input.delayMinutes ?? 15 } : { kind: "call_us" },
            // One key per booking and per bulk request, so repeating the request sends nothing twice.
            `${idempotencyKey}:${item.id}`.slice(0, 120),
          );
          break;
      }
      results.push({ id: item.id, ok: true });
    } catch (error: unknown) {
      results.push({ id: item.id, ok: false, ...reasonFor(error) });
    }
  }
  const succeeded = results.filter((result) => result.ok).length;
  return { results, succeeded, failed: results.length - succeeded };
}
