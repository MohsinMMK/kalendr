import "server-only";

/**
 * What a provider webhook does once its signature has passed: find the business each event
 * belongs to, and queue one outbox row per event. Nothing else happens in the request; the
 * worker applies the event (src/worker/handlers/channel-events.ts).
 *
 * Outbox payloads hold ids and short codes only, never a number or a message body. The outbox
 * dedupe key is the provider's event id, so a repeated delivery of the same callback queues
 * nothing the second time.
 */
import { sql } from "drizzle-orm";

import { requireDatabase, withTenant } from "@/db/client";
import { outboxEvents } from "@/db/schema";
import { currentTraceParent } from "../tracing";
import type { ChannelId, DeliveryState, StatusEvent } from "./types";

export const CHANNEL_STATUS_EVENT = "channel.status";

export interface StatusPayload {
  channel: ChannelId;
  providerMessageId: string;
  state: DeliveryState;
  failureCode: string | null;
  costCategory: string | null;
  notificationId: string | null;
  messageId: string | null;
  threadId: string | null;
}

export interface IntakeResult {
  queued: number;
  /** Events for a message we have no record of (an old message, or another environment). Dropped, never an error. */
  unknown: number;
}

/** Queues each status event for the business that sent the message. Safe to call twice with the same events. */
export async function intakeStatuses(channel: Exclude<ChannelId, "email">, events: StatusEvent[]): Promise<IntakeResult> {
  const result: IntakeResult = { queued: 0, unknown: 0 };
  for (const event of events) {
    const found = await requireDatabase().execute<{
      tenant_id: string; notification_id: string | null; message_id: string | null; thread_id: string | null;
    }>(sql`select tenant_id, notification_id, message_id, thread_id from kalendr_resolve_provider_message(${channel}, ${event.providerMessageId})`);
    const target = found[0];
    if (!target) {
      result.unknown += 1;
      continue;
    }
    const payload: StatusPayload = {
      channel,
      providerMessageId: event.providerMessageId,
      state: event.state,
      failureCode: event.failureCode ?? null,
      costCategory: event.costCategory ?? null,
      notificationId: target.notification_id,
      messageId: target.message_id,
      threadId: target.thread_id,
    };
    const inserted = await withTenant(target.tenant_id, (transaction) => transaction.insert(outboxEvents).values({
      tenantId: target.tenant_id,
      aggregateType: "channel_message",
      aggregateId: (target.notification_id ?? target.message_id ?? event.providerMessageId).slice(0, 200),
      eventType: CHANNEL_STATUS_EVENT,
      payload: { ...payload },
      dedupeKey: `${channel}:status:${event.eventId}`.slice(0, 200),
      traceParent: currentTraceParent(),
    }).onConflictDoNothing().returning({ id: outboxEvents.id }));
    if (inserted.length > 0) result.queued += 1;
  }
  return result;
}
