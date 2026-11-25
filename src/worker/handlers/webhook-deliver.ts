import { performance } from "node:perf_hooks";

import { z } from "zod";

import { postgresDataKeyStore } from "../../server/keys/postgres-store";
import { loadDataKeys } from "../../server/keys/ring";
import { openSecret } from "../../server/keys/secrets";
import { signatureHeader, WEBHOOK_SECRET_PURPOSE } from "../../server/webhooks/signature";
import {
  classifyStatus, createHttpsTransport, type WebhookErrorCode, type WebhookTransport,
} from "../../server/webhooks/transport";
import { WEBHOOK_DELIVER_EVENT } from "../webhooks/fanout";
import { defaultWebhookPolicy, retryDelayAfter, type WebhookPolicy } from "../webhooks/policy";
import type { EventHandler, TenantDb } from "./types";

export const WEBHOOK_DISABLED_EVENT = "webhook.endpoint.disabled";

export interface WebhookDependencies {
  transport?: WebhookTransport;
  policy?: WebhookPolicy;
}

const payloadSchema = z.object({ deliveryId: z.string().min(1) });

interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  is_test: boolean;
  status: string;
  attempt: number;
}

interface EndpointRow {
  id: string;
  url: string;
  secret_ciphertext: string;
  status: string;
  consecutive_failures: number;
}

/** What the log keeps about an attempt. Fixed codes only: never the receiver's reply, never any text from it. */
type FailureCode = WebhookErrorCode | "endpoint_disabled" | "secret_unreadable";

/**
 * Sends one webhook. Every outcome the receiver can cause is caught and written to the delivery row, then the
 * handler returns "delivered" for its own outbox row: a thrown error would roll the log row back with it. A failed
 * attempt schedules the next one as a new outbox row at the time the policy gives.
 */
export function webhookDeliverHandler(dependencies: WebhookDependencies, now: () => Date): EventHandler {
  const transport = dependencies.transport ?? createHttpsTransport();
  const policy = dependencies.policy ?? defaultWebhookPolicy;

  return async (tenantDb, event) => {
    const parsed = payloadSchema.safeParse(event.payload);
    if (!parsed.success) return { outcome: "dead", code: "invalid_payload" };
    const deliveries = await tenantDb<DeliveryRow[]>`
      select id, endpoint_id, event_id, event_type, payload, is_test, status, attempt
      from webhook_deliveries where tenant_id = ${event.tenantId} and id = ${parsed.data.deliveryId} for update
    `;
    const delivery = deliveries[0];
    if (!delivery || delivery.status === "succeeded" || delivery.status === "gave_up") return "delivered";
    const endpoints = await tenantDb<EndpointRow[]>`
      select id, url, secret_ciphertext, status, consecutive_failures
      from webhook_endpoints where tenant_id = ${event.tenantId} and id = ${delivery.endpoint_id} for update
    `;
    const endpoint = endpoints[0];
    if (!endpoint) return "delivered";
    const at = now();
    if (endpoint.status !== "active") {
      await giveUp(tenantDb, event.tenantId, delivery, "endpoint_disabled", at);
      return "delivered";
    }

    let secret: string;
    try {
      await loadDataKeys(postgresDataKeyStore(tenantDb), event.tenantId);
      secret = openSecret(event.tenantId, WEBHOOK_SECRET_PURPOSE, endpoint.secret_ciphertext);
    } catch {
      await giveUp(tenantDb, event.tenantId, delivery, "secret_unreadable", at);
      return "delivered";
    }

    const body = JSON.stringify(delivery.payload);
    const attempt = delivery.attempt + 1;
    const started = performance.now();
    let statusCode: number | null = null;
    let failure: FailureCode | null = null;
    try {
      const result = await transport.send({
        url: endpoint.url,
        timeoutMs: policy.timeoutMs,
        body,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Kalendr-Webhooks/1",
          "X-Kalendr-Signature": signatureHeader(secret, Math.floor(at.getTime() / 1000), body),
          "X-Kalendr-Event": delivery.event_type,
          "X-Kalendr-Event-Id": delivery.event_id,
          "X-Kalendr-Delivery": delivery.id,
        },
      });
      if (result.kind === "response") {
        statusCode = result.statusCode;
        const verdict = classifyStatus(result.statusCode);
        failure = verdict.ok ? null : verdict.errorCode;
      } else {
        failure = result.errorCode;
      }
    } catch {
      // A transport that throws is treated like any other connection failure; the row must still be written.
      failure = "connection_failed";
    }
    const durationMs = Math.max(0, Math.round(performance.now() - started));

    if (failure === null) {
      await tenantDb`
        update webhook_deliveries set status = 'succeeded', attempt = ${attempt}, status_code = ${statusCode},
          duration_ms = ${durationMs}, error_code = null, next_attempt_at = null, last_attempt_at = ${at}
        where tenant_id = ${event.tenantId} and id = ${delivery.id}
      `;
      // A test send says nothing about how real events are going, so it never changes the failure count.
      if (!delivery.is_test && endpoint.consecutive_failures > 0) {
        await tenantDb`update webhook_endpoints set consecutive_failures = 0 where tenant_id = ${event.tenantId} and id = ${endpoint.id}`;
      }
      return "delivered";
    }

    const failures = delivery.is_test ? endpoint.consecutive_failures : endpoint.consecutive_failures + 1;
    const disable = !delivery.is_test && failures >= policy.disableAfterFailures;
    const delay = delivery.is_test || disable ? null : retryDelayAfter(policy, attempt);
    const next = delay === null ? null : new Date(at.getTime() + delay);
    await tenantDb`
      update webhook_deliveries set status = ${next ? "retrying" : "gave_up"}, attempt = ${attempt}, status_code = ${statusCode},
        duration_ms = ${durationMs}, error_code = ${failure}, next_attempt_at = ${next}, last_attempt_at = ${at}
      where tenant_id = ${event.tenantId} and id = ${delivery.id}
    `;
    if (next) {
      await tenantDb`
        insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, available_at)
        values (${event.tenantId}, 'webhook_delivery', ${delivery.id}, ${WEBHOOK_DELIVER_EVENT},
          ${tenantDb.json({ deliveryId: delivery.id })}, ${`${WEBHOOK_DELIVER_EVENT}:${delivery.id}:${attempt + 1}`}, ${next})
        on conflict (tenant_id, dedupe_key) do nothing
      `;
    }
    if (!delivery.is_test) {
      await tenantDb`update webhook_endpoints set consecutive_failures = ${failures} where tenant_id = ${event.tenantId} and id = ${endpoint.id}`;
    }
    if (disable) await disableEndpoint(tenantDb, event.tenantId, endpoint.id, at);
    return "delivered";
  };
}

async function giveUp(tenantDb: TenantDb, tenantId: string, delivery: DeliveryRow, code: FailureCode, at: Date): Promise<void> {
  await tenantDb`
    update webhook_deliveries set status = 'gave_up', error_code = ${code}, next_attempt_at = null, last_attempt_at = ${at}
    where tenant_id = ${tenantId} and id = ${delivery.id}
  `;
}

/** Switches the address off after repeated failure, records it, and queues the email to the owner. */
async function disableEndpoint(tenantDb: TenantDb, tenantId: string, endpointId: string, at: Date): Promise<void> {
  await tenantDb`
    update webhook_endpoints set status = 'disabled', disabled_reason = 'repeated_failure', disabled_at = ${at},
      version = version + 1, updated_at = ${at}
    where tenant_id = ${tenantId} and id = ${endpointId}
  `;
  await tenantDb`
    insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
    values (${tenantId}, 'system', 'webhook.endpoint.disabled', 'success', ${tenantDb.json({ endpointId, reason: "repeated_failure" })})
  `;
  await tenantDb`
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    values (${tenantId}, 'webhook_endpoint', ${endpointId}, ${WEBHOOK_DISABLED_EVENT},
      ${tenantDb.json({ endpointId })}, ${`${WEBHOOK_DISABLED_EVENT}:${endpointId}:${at.getTime()}`})
    on conflict (tenant_id, dedupe_key) do nothing
  `;
}
