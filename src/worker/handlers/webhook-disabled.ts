import { z } from "zod";

import { appOrigin } from "../../server/env";
import { deliveryToHandlerOutcome, type HandlerDependencies } from "./appointment-message";
import type { EventHandler } from "./types";

const payloadSchema = z.object({ endpointId: z.string().min(1) });

/**
 * Emails the business when an address was switched off for repeated failure (feature 34). The message names the host
 * only: not the full address (it can carry a secret path) and nothing the receiver replied.
 */
export function webhookDisabledHandler({ sink, now }: Pick<HandlerDependencies, "sink" | "now">): EventHandler {
  return async (tenantDb, event) => {
    const parsed = payloadSchema.safeParse(event.payload);
    if (!parsed.success) return { outcome: "dead", code: "invalid_payload" };
    const rows = await tenantDb<{ url: string; email: string | null; owner_email: string | null; name: string }[]>`
      select endpoint.url, tenant.email, tenant.name,
        (select account.email from memberships as membership
          join auth_users as account on account.id = membership.user_id
          where membership.tenant_id = tenant.id and membership.role = 'owner' and membership.is_active
          order by membership.created_at limit 1) as owner_email
      from webhook_endpoints as endpoint join tenants as tenant on tenant.id = endpoint.tenant_id
      where endpoint.tenant_id = ${event.tenantId} and endpoint.id = ${parsed.data.endpointId}
    `;
    const row = rows[0];
    if (!row) return "delivered";
    const address = row.owner_email?.trim() || row.email?.trim();
    if (!address) return { outcome: "dead", code: "no_destination" };
    let host = "your server";
    try {
      host = new URL(row.url).host;
    } catch {
      // keep the generic wording
    }
    const at = now();
    return deliveryToHandlerOutcome(await sink.deliver(tenantDb, {
      tenantId: event.tenantId,
      appointmentId: null,
      patientId: "",
      channel: "email",
      message: {
        semanticKey: `local:webhook:disabled:${event.dedupeKey}`.slice(0, 200),
        templateKey: "webhook.disabled",
        body: JSON.stringify({ host, staffUrl: `${appOrigin()}/dashboard` }),
        scheduledAt: at,
      },
      recipient: { email: address, name: row.name },
    }, at));
  };
}
