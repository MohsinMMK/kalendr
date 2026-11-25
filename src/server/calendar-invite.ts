import "server-only";

import { type KalendrTransaction, withTenant } from "@/db/client";
import { customerEntry } from "@/lib/event-wording";

import { loadWordingContext } from "./calendar-wording";
import { loadRecordKeys } from "./record-crypto";
import { drizzleRunner } from "./workflows/runner";

/**
 * The customer's calendar invite for one appointment, in the business's own wording (feature 50). Returns nothing when
 * the service sets no wording, so the usual invite is written unchanged. The web routes use this; the worker builds the
 * same entry from the same context.
 */
export async function customerInviteEntry(tenantId: string, appointmentId: string, options: { hidePlace?: boolean } = {}): Promise<{ title: string; description: string | null } | undefined> {
  return withTenant(tenantId, async (transaction: KalendrTransaction) => {
    const run = drizzleRunner(transaction);
    // Keys are only needed when a question's answer is used; loading them is cheap and never fails the invite.
    await loadRecordKeys(transaction, tenantId).catch(() => undefined);
    const context = await loadWordingContext(run, tenantId, appointmentId, options);
    if (!context || (!context.wording.customerTitle?.trim() && !context.wording.description?.trim())) return undefined;
    return customerEntry(context.wording, context.values, `${context.values.service} · ${context.values.business}`, "", context.questionKeys);
  });
}
