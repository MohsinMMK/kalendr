import type { WebhookEventType } from "../../lib/api-scopes";
import { publicEventFor } from "../../server/webhooks/payloads";
import { fanOutApps } from "../apps/fanout";
import type { EventHandler, OutboxEvent, TenantDb } from "../handlers/types";
import { buildEnvelope } from "./build";

/**
 * Turns one change into webhook deliveries (feature 34), the way withCalendarWrite turns it into a calendar write:
 * the fan-out is its own rows (one delivery plus one `webhook.deliver` outbox row per subscribed, active address), so
 * a slow or failing receiver never holds up, or repeats, the customer's message.
 *
 * Safe to run again: a delivery is unique per address and event id, and its outbox row has a fixed dedupe key, so a
 * retried change adds nothing the second time.
 */

export const WEBHOOK_DELIVER_EVENT = "webhook.deliver";

async function subscribedEndpoints(tenantDb: TenantDb, tenantId: string, type: WebhookEventType): Promise<number> {
  const rows = await tenantDb`
    select count(*)::integer as count from webhook_endpoints
    where tenant_id = ${tenantId} and status = 'active' and ${type} = any(events)
  `;
  return Number((rows[0] as { count: number } | undefined)?.count ?? 0);
}

/** Queues the deliveries for one outbox row. Does nothing for events that have no public name or no subscriber. */
export async function fanOutWebhooks(tenantDb: TenantDb, event: OutboxEvent, now: Date): Promise<void> {
  const type = publicEventFor(event.eventType, event.dedupeKey);
  if (!type) return;
  // Installed apps hear about the same change, as rows of their own, so one failing never holds up another.
  await fanOutApps(tenantDb, event, type);
  if (await subscribedEndpoints(tenantDb, event.tenantId, type) === 0) return;
  const body = await buildEnvelope(tenantDb, event, type, now);
  if (!body) return;
  await tenantDb`
    with inserted as (
      insert into webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload, status)
      select ${event.tenantId}, endpoint.id, ${body.id}, ${type}, ${tenantDb.json(body)}, 'pending'
      from webhook_endpoints as endpoint
      where endpoint.tenant_id = ${event.tenantId} and endpoint.status = 'active' and ${type} = any(endpoint.events)
      on conflict (tenant_id, endpoint_id, event_id) where resend_of_id is null do nothing
      returning id
    )
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    select ${event.tenantId}, 'webhook_delivery', inserted.id, ${WEBHOOK_DELIVER_EVENT},
      jsonb_build_object('deliveryId', inserted.id), ${WEBHOOK_DELIVER_EVENT} || ':' || inserted.id || ':1'
    from inserted
    on conflict (tenant_id, dedupe_key) do nothing
  `;
}

/** Wraps the appointment-change handler so the same event also fans out to webhooks. */
export function withWebhookFanout(handler: EventHandler, now: () => Date): EventHandler {
  return async (tenantDb, event) => {
    if (event.aggregateType === "appointment") await fanOutWebhooks(tenantDb, event, now());
    return handler(tenantDb, event);
  };
}

/** For events that have no message of their own (customer.created, payment.captured): fan out and finish. */
export function webhookOnlyHandler(now: () => Date): EventHandler {
  return async (tenantDb, event) => {
    await fanOutWebhooks(tenantDb, event, now());
    return "delivered";
  };
}
