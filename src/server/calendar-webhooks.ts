import "server-only";

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase, withTenant } from "@/db/client";
import { calendarWebhookEvents } from "@/db/schema";
import { CALENDAR_SYNC_EVENT } from "@/lib/calendar-sync";
import { webhookTokenMatches } from "@/server/calendars";
import { webhookSecret } from "@/server/calendars/runtime";

import { ApiError } from "./api-error";

/** Notifications carry no calendar data, only "something changed", so a small cap is plenty. */
const MAX_CALENDAR_WEBHOOK_BYTES = 64 * 1_024;

export async function readRawBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_CALENDAR_WEBHOOK_BYTES) throw new ApiError(413, "request_too_large", "The request is too large.");
  const body = await request.text();
  if (Buffer.byteLength(body) > MAX_CALENDAR_WEBHOOK_BYTES) throw new ApiError(413, "request_too_large", "The request is too large.");
  return body;
}

/** Constant-time check of the shared secret both providers echo back. No secret configured means every request fails. */
export function notificationTokenValid(received: string | null | undefined): boolean {
  const secret = webhookSecret();
  return Boolean(secret) && webhookTokenMatches(received, secret ?? "");
}

export type IngestResult = "queued" | "duplicate" | "unknown_channel" | "ignored";

/**
 * Steps 3 and 4 of the webhook rules: note the provider's notification id (a repeat is answered and dropped),
 * and write the outbox row in the same transaction. Nothing else happens here; the worker reads the calendar.
 * A channel we do not know (already closed, or from another system) is acknowledged and ignored.
 */
export async function ingestNotification(input: { provider: "google" | "microsoft"; channelId: string; eventKey: string; handshake?: boolean }): Promise<IngestResult> {
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "Business data is unavailable.");
  const found = await database.execute<{ tenant_id: string; selection_id: string }>(sql`select tenant_id, selection_id from kalendr_resolve_calendar_channel(${input.channelId})`);
  const target = found[0];
  if (!target) return "unknown_channel";
  return withTenant(target.tenant_id, async (transaction): Promise<IngestResult> => {
    const recorded = await transaction.insert(calendarWebhookEvents).values({
      tenantId: target.tenant_id, provider: input.provider, eventKey: input.eventKey.slice(0, 400), selectionId: target.selection_id,
    }).onConflictDoNothing().returning({ id: calendarWebhookEvents.id });
    if (recorded.length === 0) return "duplicate";
    // Google's first message just says the channel exists.
    if (input.handshake) return "ignored";
    // One waiting read per calendar is enough: it reads everything changed so far. A read already running does not count.
    await transaction.execute(sql`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      select ${target.tenant_id}, 'calendar_selection', ${target.selection_id}, ${CALENDAR_SYNC_EVENT},
        jsonb_build_object('selectionId', ${target.selection_id}::text), ${`calendar.sync:${target.selection_id}:wh:${input.eventKey}`.slice(0, 200)}
      where not exists (
        select 1 from outbox_events as waiting
        where waiting.tenant_id = ${target.tenant_id} and waiting.aggregate_id = ${target.selection_id}
          and waiting.event_type = ${CALENDAR_SYNC_EVENT} and waiting.status = 'pending'
      )
      on conflict (tenant_id, dedupe_key) do nothing`);
    return "queued";
  });
}

const graphNotificationSchema = z.object({
  subscriptionId: z.string().min(1).max(200),
  clientState: z.string().optional(),
}).passthrough();

export const graphPayloadSchema = z.object({ value: z.array(graphNotificationSchema).max(100) });

/** Microsoft sends no id of its own, so a repeat is recognised by the notification's own content (which includes its etag). */
export function graphEventKey(notification: unknown): string {
  return createHash("sha256").update(JSON.stringify(notification)).digest("hex");
}
