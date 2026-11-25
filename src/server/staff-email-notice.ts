import "server-only";

import { eq } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import { outboxEvents, tenants } from "@/db/schema";
import {
  ACCOUNT_EMAIL_NOTICE_EVENT,
  ACCOUNT_EMAIL_NOTICE_PURPOSE,
  accountEmailNoticePayloadSchema,
  accountEmailNoticeSecretSchema,
  type AccountEmailNoticeKind,
} from "@/lib/staff-email";

import { ApiError } from "./api-error";
import { sealPrivate } from "./messaging/sealed-link";
import { currentTraceParent } from "./tracing";

/**
 * Queues one "your sign-in email changed" notice through the outbox, inside the transaction that made the change, so the notice
 * exists exactly when the change does. The worker sends it (`src/worker/handlers/account-email-notice.ts`).
 *
 * The address it goes to rides in the payload sealed, tied to this business and this row, so a copy of the outbox table holds
 * no readable address. Nothing here puts an address in the dedupe key, the aggregate id or a log line.
 */
export async function queueEmailNotice(
  transaction: KalendrTransaction,
  tenantId: string,
  notice: { kind: AccountEmailNoticeKind; to: string; name: string; at: Date },
): Promise<void> {
  const [tenant] = await transaction.select({ name: tenants.name, timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const rowId = crypto.randomUUID();
  const secret = accountEmailNoticeSecretSchema.parse({
    email: notice.to.trim().toLowerCase(),
    name: notice.name.trim().slice(0, 160),
    business: tenant?.name ?? "",
    when: new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: tenant?.timezone ?? "Asia/Kolkata" }).format(notice.at),
  });
  const sealed = sealPrivate(ACCOUNT_EMAIL_NOTICE_PURPOSE, tenantId, rowId, JSON.stringify(secret));
  if (!sealed) throw new ApiError(503, "notice_unavailable", "We can't send email notices right now. Please try again shortly.");
  await transaction.insert(outboxEvents).values({
    tenantId,
    aggregateType: "account_email",
    aggregateId: rowId,
    eventType: ACCOUNT_EMAIL_NOTICE_EVENT,
    payload: accountEmailNoticePayloadSchema.parse({ kind: notice.kind, sealed }),
    dedupeKey: `${ACCOUNT_EMAIL_NOTICE_EVENT}:${rowId}`,
    traceParent: currentTraceParent(),
  });
}
