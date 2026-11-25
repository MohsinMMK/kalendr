import { createHash } from "node:crypto";

import { z } from "zod";

import type { WebhookEventType } from "../../lib/api-scopes";
import { APP_DELIVER_EVENT } from "../../server/apps/events";
import { getApp } from "../../server/apps/registry";
import type { OutboxEvent, TenantDb } from "../handlers/types";

/**
 * Turns one booking change into one delivery per installed app that listens for it (feature 55). Each delivery is an
 * outbox row of its own, so a slow or failing app never holds up the customer's message, a webhook or another app.
 * Running it again adds nothing: the row's dedupe key is fixed by the app and the event.
 */
export async function fanOutApps(tenantDb: TenantDb, event: OutboxEvent, type: WebhookEventType): Promise<void> {
  const installs = await tenantDb<{ id: string; app_key: string; settings: unknown }[]>`
    select id, app_key, settings from app_installs where tenant_id = ${event.tenantId} and status = 'active'
  `;
  if (installs.length === 0) return;
  // Keys are limited to 200 characters; a long source key is shortened to a hash so two events never share one.
  const source = createHash("sha256").update(event.dedupeKey).digest("hex").slice(0, 32);
  for (const install of installs) {
    const app = getApp(install.app_key);
    if (!app || !app.listensTo(install.settings).includes(type)) continue;
    await tenantDb`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      values (${event.tenantId}, 'app_install', ${install.id}, ${APP_DELIVER_EVENT},
        ${tenantDb.json({ installId: install.id, type, aggregateId: event.aggregateId, source: z.json().catch(null).parse(event.payload), attempt: 1 })},
        ${`${APP_DELIVER_EVENT}:${install.id}:${source}:1`})
      on conflict (tenant_id, dedupe_key) do nothing
    `;
  }
}
