import "server-only";

/**
 * Resend's delivery webhook: verified with svix over the raw body, deduplicated on the svix
 * message id, and applied to one notification in one transaction.
 *
 * A hard bounce or a spam complaint puts a hash of the address on the business's suppression
 * list, and the worker checks that list before every send. Nothing here logs the address, the
 * subject or the payload.
 */
import { sql } from "drizzle-orm";
import { Webhook } from "svix";
import { z } from "zod";

import { requireDatabase, withTenant } from "@/db/client";

import { destinationHash } from "./suppression";

/** Large enough for any delivery event, small enough that a junk body is refused before parsing. */
export const MAX_WEBHOOK_BYTES = 64 * 1024;

const EVENT_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

export const resendEventSchema = z.object({
  type: z.string().min(1).max(60),
  data: z.object({
    email_id: z.string().min(1).max(200),
    to: z.array(z.string().max(320)).max(50).optional(),
    bounce: z.object({ type: z.string().max(40).optional() }).optional(),
  }),
});

export type ResendEvent = z.infer<typeof resendEventSchema>;

export class WebhookSignatureError extends Error {
  constructor() {
    super("The webhook signature is not valid.");
    this.name = "WebhookSignatureError";
  }
}

/**
 * Checks the svix signature over the exact bytes received (svix compares in constant time and
 * refuses timestamps more than five minutes off). Returns the event id and the parsed event.
 */
export function verifyResendWebhook(secret: string, rawBody: string, headers: Headers): { eventId: string; event: ResendEvent } {
  const eventId = headers.get("svix-id") ?? "";
  if (!EVENT_ID.test(eventId)) throw new WebhookSignatureError();
  let payload: unknown;
  try {
    // svix 2.x checks the signature and returns nothing; the body is parsed only once it passes.
    new Webhook(secret).verify(rawBody, {
      "svix-id": eventId,
      "svix-timestamp": headers.get("svix-timestamp") ?? "",
      "svix-signature": headers.get("svix-signature") ?? "",
    });
    payload = JSON.parse(rawBody);
  } catch {
    throw new WebhookSignatureError();
  }
  const parsed = resendEventSchema.safeParse(payload);
  if (!parsed.success) throw new WebhookSignatureError();
  return { eventId, event: parsed.data };
}

export interface DeliveryChange {
  status: "delivered" | "failed" | null;
  failureCode: string | null;
  suppress: "bounced" | "complained" | null;
}

/** What one Resend event does to its notification. Unknown event types change nothing. */
export function deliveryChange(event: ResendEvent): DeliveryChange {
  switch (event.type) {
    case "email.delivered":
      return { status: "delivered", failureCode: null, suppress: null };
    case "email.bounced": {
      // "Permanent" is a hard bounce: the address doesn't exist. Anything else may work later.
      const hard = (event.data.bounce?.type ?? "Permanent") === "Permanent";
      return { status: "failed", failureCode: hard ? "bounced" : "bounced_soft", suppress: hard ? "bounced" : null };
    }
    case "email.complained":
      // It arrived, then the customer marked it as spam: keep it delivered, never send again.
      return { status: null, failureCode: null, suppress: "complained" };
    case "email.failed":
      return { status: "failed", failureCode: "provider_failed", suppress: null };
    default:
      return { status: null, failureCode: null, suppress: null };
  }
}

export type WebhookResult = "applied" | "duplicate" | "unknown_message";

/**
 * Finds the notification by the provider's message id (through a narrow SECURITY DEFINER
 * lookup that returns ids only), then, inside that business's scope, records the event once
 * and applies it.
 */
export async function applyResendEvent(eventId: string, event: ResendEvent): Promise<WebhookResult> {
  const found = await requireDatabase().execute<{ tenant_id: string; notification_id: string }>(
    sql`select tenant_id, notification_id from kalendr_resolve_email_notification(${event.data.email_id})`,
  );
  const target = found[0];
  if (!target) return "unknown_message";

  const change = deliveryChange(event);
  return withTenant(target.tenant_id, async (transaction) => {
    const recorded = await transaction.execute<{ id: string }>(sql`
      insert into message_delivery_events (tenant_id, provider, provider_event_id, notification_id, event_type)
      values (${target.tenant_id}, 'resend', ${eventId}, ${target.notification_id}, ${event.type})
      on conflict (tenant_id, provider, provider_event_id) do nothing
      returning id
    `);
    if (recorded.length === 0) return "duplicate";

    if (change.status === "delivered") {
      // Never undoes a bounce that arrived first.
      await transaction.execute(sql`
        update notifications set status = 'delivered', delivered_at = now(), updated_at = now()
        where tenant_id = ${target.tenant_id} and id = ${target.notification_id}
          and status in ('queued', 'sending')
      `);
    } else if (change.status === "failed") {
      await transaction.execute(sql`
        update notifications set status = 'failed', failed_at = now(), failure_code = ${change.failureCode},
          updated_at = now()
        where tenant_id = ${target.tenant_id} and id = ${target.notification_id}
          and status in ('queued', 'sending', 'delivered')
      `);
    }

    const address = event.data.to?.[0];
    if (change.suppress && address) {
      await transaction.execute(sql`
        insert into message_suppressions (tenant_id, channel, destination_hash, reason, notification_id)
        values (${target.tenant_id}, 'email', ${destinationHash("email", address)}, ${change.suppress}, ${target.notification_id})
        on conflict (tenant_id, channel, destination_hash) do nothing
      `);
    }
    return "applied";
  });
}
