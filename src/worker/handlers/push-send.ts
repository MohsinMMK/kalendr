import { PUSH_SECRET_PURPOSE, pushJobSchema, storedSubscriptionSchema, type PushMessage, type StoredSubscription } from "../../lib/staff-alerts";
import { postgresDataKeyStore } from "../../server/keys/postgres-store";
import { openSecret } from "../../server/keys/secrets";
import { loadDataKeys } from "../../server/keys/ring";
import type { PushSender } from "../push";
import type { EventHandler } from "./types";

interface SubscriptionRow {
  id: string;
  subscription_ciphertext: string;
}

/**
 * Sends one alert to every device its owner subscribed. The text is short and holds no names or
 * contact details. A device the push service reports as gone is forgotten. With no sender (push not
 * set up) the event is simply finished: the bell still has the alert.
 */
export function pushSendHandler(sender: PushSender | undefined): EventHandler {
  return async (tenantDb, event) => {
    if (!sender) return "delivered";
    const parsed = pushJobSchema.safeParse(event.payload);
    if (!parsed.success) return { outcome: "dead", code: "invalid_push" };
    const job = parsed.data;

    const rows = job.membershipId
      ? await tenantDb<SubscriptionRow[]>`
          select id, subscription_ciphertext from push_subscriptions
          where tenant_id = ${event.tenantId} and membership_id = ${job.membershipId}`
      : await tenantDb<SubscriptionRow[]>`
          select id, subscription_ciphertext from push_subscriptions
          where tenant_id = ${event.tenantId} and patient_id = ${job.patientId ?? ""}`;
    if (!rows.length) return "delivered";

    await loadDataKeys(postgresDataKeyStore(tenantDb), event.tenantId);
    const message: PushMessage = { title: job.title, ...(job.body ? { body: job.body } : {}), ...(job.link ? { link: job.link } : {}), kind: job.kind };
    let sent = 0;
    let retry = false;
    for (const row of rows) {
      const subscription = openStored(event.tenantId, row.subscription_ciphertext);
      if (!subscription) {
        await forget(tenantDb, event.tenantId, row.id);
        continue;
      }
      const result = await sender.send(subscription, message);
      if (result === "sent") {
        sent += 1;
        await tenantDb`update push_subscriptions set last_success_at = now() where tenant_id = ${event.tenantId} and id = ${row.id}`;
      } else if (result === "gone") {
        await forget(tenantDb, event.tenantId, row.id);
      } else if (result === "retry") {
        retry = true;
      }
    }
    // A repeat would alert the devices that already got it, so only retry when nothing went out.
    if (retry && sent === 0) return { outcome: "retry", code: "push_unavailable" };
    return "delivered";
  };
}

function openStored(tenantId: string, sealed: string): StoredSubscription | null {
  try {
    const parsed = storedSubscriptionSchema.safeParse(JSON.parse(openSecret(tenantId, PUSH_SECRET_PURPOSE, sealed)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function forget(tenantDb: Parameters<EventHandler>[0], tenantId: string, id: string): Promise<void> {
  await tenantDb`delete from push_subscriptions where tenant_id = ${tenantId} and id = ${id}`;
}
