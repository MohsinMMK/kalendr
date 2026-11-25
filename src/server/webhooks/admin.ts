import "server-only";

import { randomUUID } from "node:crypto";

import { and, count, desc, eq, inArray, sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents, outboxEvents, webhookDeliveries, webhookEndpoints } from "@/db/schema";
import { isWebhookEventType } from "@/lib/api-scopes";
import { ApiError } from "@/server/api-error";
import { decodeCursor, encodeCursor } from "@/server/api-v1";
import { sealSecret, secretKeyVersion } from "@/server/keys/secrets";
import { loadRecordKeys } from "@/server/record-crypto";
import { requirePermission, type StaffContext } from "@/server/staff-context";

import {
  MAX_WEBHOOK_ENDPOINTS, type CreateEndpointInput, type UpdateEndpointInput, type WebhookDeliveryView, type WebhookEndpointView,
} from "./contracts";
import { eventIdFor, testEnvelope } from "./payloads";
import { generateWebhookSecret, WEBHOOK_SECRET_PURPOSE } from "./signature";
import { validateWebhookUrl } from "./url-guard";

/**
 * What the Developers screen does with webhook addresses (feature 34). Every change writes its audit row in the same
 * transaction. Audit metadata holds ids and fixed words only: never the address, the description or a secret.
 */

type EndpointRow = typeof webhookEndpoints.$inferSelect;
type DeliveryRow = typeof webhookDeliveries.$inferSelect;
const DELIVER_EVENT = "webhook.deliver";

function guard(context: StaffContext): void {
  requirePermission(context, "api.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Webhooks need a database, so they are not available in preview.");
}

function checkedUrl(input: string): string {
  const checked = validateWebhookUrl(input);
  if (!checked.ok) throw new ApiError(400, "invalid_url", checked.message, { url: [checked.message] });
  return checked.url;
}

async function audit(transaction: KalendrTransaction, context: StaffContext, action: string, metadata: Record<string, unknown>): Promise<void> {
  await transaction.insert(auditEvents).values({
    tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action, outcome: "success", metadata,
  });
}

function events(row: EndpointRow): WebhookEndpointView["events"] {
  return row.events.filter(isWebhookEventType);
}

function endpointView(row: EndpointRow, last: DeliveryRow | undefined): WebhookEndpointView {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: events(row),
    status: row.status === "disabled" ? "disabled" : "active",
    disabledReason: row.disabledReason,
    consecutiveFailures: row.consecutiveFailures,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    lastDelivery: last ? { status: last.status, statusCode: last.statusCode, at: (last.lastAttemptAt ?? last.createdAt).toISOString() } : null,
  };
}

function deliveryView(row: DeliveryRow): WebhookDeliveryView {
  return {
    id: row.id,
    endpointId: row.endpointId,
    eventId: row.eventId,
    eventType: row.eventType,
    status: row.status === "succeeded" || row.status === "retrying" || row.status === "gave_up" ? row.status : "pending",
    attempt: row.attempt,
    statusCode: row.statusCode,
    durationMs: row.durationMs,
    errorCode: row.errorCode,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    isTest: row.isTest,
    createdAt: row.createdAt.toISOString(),
  };
}

async function lastDeliveries(transaction: KalendrTransaction, tenantId: string, ids: string[]): Promise<Map<string, DeliveryRow>> {
  if (ids.length === 0) return new Map();
  const rows = await transaction.selectDistinctOn([webhookDeliveries.endpointId]).from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.tenantId, tenantId), inArray(webhookDeliveries.endpointId, ids)))
    .orderBy(webhookDeliveries.endpointId, desc(webhookDeliveries.createdAt));
  return new Map(rows.map((row) => [row.endpointId, row]));
}

async function viewOf(transaction: KalendrTransaction, row: EndpointRow): Promise<WebhookEndpointView> {
  const last = await lastDeliveries(transaction, row.tenantId, [row.id]);
  return endpointView(row, last.get(row.id));
}

async function lockEndpoint(transaction: KalendrTransaction, tenantId: string, id: string): Promise<EndpointRow> {
  const [row] = await transaction.select().from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.id, id))).limit(1).for("update");
  if (!row) throw new ApiError(404, "webhook_not_found", "That webhook address was not found.");
  return row;
}

function sealNewSecret(transaction: KalendrTransaction, tenantId: string): Promise<{ secret: string; ciphertext: string; keyVersion: number }> {
  return loadRecordKeys(transaction, tenantId, { forWrite: true }).then(() => {
    const secret = generateWebhookSecret();
    const ciphertext = sealSecret(tenantId, WEBHOOK_SECRET_PURPOSE, secret);
    return { secret, ciphertext, keyVersion: secretKeyVersion(ciphertext) };
  });
}

export async function listEndpoints(context: StaffContext): Promise<WebhookEndpointView[]> {
  guard(context);
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.select().from(webhookEndpoints)
      .where(eq(webhookEndpoints.tenantId, context.tenantId)).orderBy(webhookEndpoints.createdAt, webhookEndpoints.id);
    const last = await lastDeliveries(transaction, context.tenantId, rows.map((row) => row.id));
    return rows.map((row) => endpointView(row, last.get(row.id)));
  });
}

/** Creates an address and returns its signing secret. The secret is shown here once and can not be read again. */
export async function createEndpoint(context: StaffContext, input: CreateEndpointInput): Promise<{ endpoint: WebhookEndpointView; secret: string }> {
  guard(context);
  const url = checkedUrl(input.url);
  return withTenant(context.tenantId, async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${`webhooks:${context.tenantId}`}))`);
    const [existing] = await transaction.select({ total: count() }).from(webhookEndpoints).where(eq(webhookEndpoints.tenantId, context.tenantId));
    if ((existing?.total ?? 0) >= MAX_WEBHOOK_ENDPOINTS) {
      throw new ApiError(409, "webhook_limit", `You can have up to ${MAX_WEBHOOK_ENDPOINTS} webhook addresses. Remove one you no longer use first.`);
    }
    const sealed = await sealNewSecret(transaction, context.tenantId);
    const [row] = await transaction.insert(webhookEndpoints).values({
      tenantId: context.tenantId, url, description: input.description, secretCiphertext: sealed.ciphertext,
      keyVersion: sealed.keyVersion, events: input.events,
    }).returning();
    if (!row) throw new Error("Webhook address insert returned no row");
    await audit(transaction, context, "webhook.endpoint.created", { endpointId: row.id, eventCount: input.events.length });
    return { endpoint: endpointView(row, undefined), secret: sealed.secret };
  });
}

export async function updateEndpoint(context: StaffContext, id: string, input: UpdateEndpointInput): Promise<WebhookEndpointView> {
  guard(context);
  const url = input.url === undefined ? undefined : checkedUrl(input.url);
  return withTenant(context.tenantId, async (transaction) => {
    const current = await lockEndpoint(transaction, context.tenantId, id);
    if (current.version !== input.expectedVersion) {
      throw new ApiError(409, "version_conflict", "This webhook address was changed by someone else. Reload and try again.");
    }
    const now = new Date();
    const changes: Partial<typeof webhookEndpoints.$inferInsert> = {};
    const changed: string[] = [];
    if (url !== undefined && url !== current.url) { changes.url = url; changed.push("url"); }
    if (input.description !== undefined && input.description !== current.description) { changes.description = input.description; changed.push("description"); }
    if (input.events !== undefined && input.events.join() !== current.events.join()) { changes.events = input.events; changed.push("events"); }
    if (input.status !== undefined && input.status !== current.status) {
      changed.push("status");
      changes.status = input.status;
      // Turning an address back on starts its failure count again; turning it off by hand is the owner's reason.
      Object.assign(changes, input.status === "active"
        ? { disabledAt: null, disabledReason: null, consecutiveFailures: 0 }
        : { disabledAt: now, disabledReason: "owner" });
    }
    if (changed.length === 0) return viewOf(transaction, current);
    const [row] = await transaction.update(webhookEndpoints)
      .set({ ...changes, version: sql`${webhookEndpoints.version} + 1`, updatedAt: now })
      .where(and(eq(webhookEndpoints.tenantId, context.tenantId), eq(webhookEndpoints.id, id))).returning();
    if (!row) throw new Error("Webhook address update returned no row");
    await audit(transaction, context, "webhook.endpoint.updated", { endpointId: id, changed });
    return viewOf(transaction, row);
  });
}

export async function deleteEndpoint(context: StaffContext, id: string): Promise<void> {
  guard(context);
  await withTenant(context.tenantId, async (transaction) => {
    await lockEndpoint(transaction, context.tenantId, id);
    await transaction.delete(webhookEndpoints).where(and(eq(webhookEndpoints.tenantId, context.tenantId), eq(webhookEndpoints.id, id)));
    await audit(transaction, context, "webhook.endpoint.deleted", { endpointId: id });
  });
}

/** Replaces the signing secret and returns the new one once. Receivers must switch over, so the old one stops working at once. */
export async function rotateSecret(context: StaffContext, id: string): Promise<{ endpoint: WebhookEndpointView; secret: string }> {
  guard(context);
  return withTenant(context.tenantId, async (transaction) => {
    await lockEndpoint(transaction, context.tenantId, id);
    const sealed = await sealNewSecret(transaction, context.tenantId);
    const [row] = await transaction.update(webhookEndpoints)
      .set({ secretCiphertext: sealed.ciphertext, keyVersion: sealed.keyVersion, version: sql`${webhookEndpoints.version} + 1`, updatedAt: new Date() })
      .where(and(eq(webhookEndpoints.tenantId, context.tenantId), eq(webhookEndpoints.id, id))).returning();
    if (!row) throw new Error("Webhook secret update returned no row");
    await audit(transaction, context, "webhook.endpoint.secret_rotated", { endpointId: id });
    return { endpoint: await viewOf(transaction, row), secret: sealed.secret };
  });
}

async function queueDelivery(transaction: KalendrTransaction, tenantId: string, deliveryId: string): Promise<void> {
  await transaction.insert(outboxEvents).values({
    tenantId, aggregateType: "webhook_delivery", aggregateId: deliveryId, eventType: DELIVER_EVENT,
    payload: { deliveryId }, dedupeKey: `${DELIVER_EVENT}:${deliveryId}:1`,
  }).onConflictDoNothing();
}

function requireActive(row: EndpointRow): void {
  if (row.status !== "active") throw new ApiError(409, "endpoint_disabled", "Switch this address back on first.");
}

/** Queues a `webhook.test` event for one address. Nothing is sent from the request; the worker sends it. */
export async function sendTestEvent(context: StaffContext, id: string): Promise<{ deliveryId: string }> {
  guard(context);
  return withTenant(context.tenantId, async (transaction) => {
    requireActive(await lockEndpoint(transaction, context.tenantId, id));
    const eventId = eventIdFor(["webhook.test", randomUUID()]);
    const [row] = await transaction.insert(webhookDeliveries).values({
      tenantId: context.tenantId, endpointId: id, eventId, eventType: "webhook.test", isTest: true,
      payload: { ...testEnvelope(eventId, new Date()) },
    }).returning({ id: webhookDeliveries.id });
    if (!row) throw new Error("Test delivery insert returned no row");
    await queueDelivery(transaction, context.tenantId, row.id);
    await audit(transaction, context, "webhook.endpoint.test_sent", { endpointId: id, deliveryId: row.id });
    return { deliveryId: row.id };
  });
}

/** Sends an earlier delivery again: a new log row with the same body and event id, so the receiver can recognise it. */
export async function resendDelivery(context: StaffContext, deliveryId: string): Promise<{ deliveryId: string }> {
  guard(context);
  return withTenant(context.tenantId, async (transaction) => {
    const [original] = await transaction.select().from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.tenantId, context.tenantId), eq(webhookDeliveries.id, deliveryId))).limit(1);
    if (!original) throw new ApiError(404, "delivery_not_found", "That delivery was not found.");
    requireActive(await lockEndpoint(transaction, context.tenantId, original.endpointId));
    const [row] = await transaction.insert(webhookDeliveries).values({
      tenantId: context.tenantId, endpointId: original.endpointId, eventId: original.eventId, eventType: original.eventType,
      payload: original.payload, isTest: original.isTest, resendOfId: original.id,
    }).returning({ id: webhookDeliveries.id });
    if (!row) throw new Error("Resend insert returned no row");
    await queueDelivery(transaction, context.tenantId, row.id);
    await audit(transaction, context, "webhook.delivery.resent", { endpointId: original.endpointId, deliveryId: row.id, resendOfId: original.id });
    return { deliveryId: row.id };
  });
}

export async function listDeliveries(
  context: StaffContext,
  options: { endpointId?: string; cursor?: string; limit: number },
): Promise<{ deliveries: WebhookDeliveryView[]; nextCursor: string | null }> {
  guard(context);
  const position = decodeCursor(options.cursor);
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.select({ row: webhookDeliveries, cursorAt: sql<string>`${webhookDeliveries.createdAt}::text` }).from(webhookDeliveries)
      .where(and(
        eq(webhookDeliveries.tenantId, context.tenantId),
        options.endpointId ? eq(webhookDeliveries.endpointId, options.endpointId) : undefined,
        // Compared as text-exact microseconds, so two rows in the same millisecond never repeat or vanish across pages.
        position ? sql`(${webhookDeliveries.createdAt}, ${webhookDeliveries.id}) < (${position.t}::timestamptz, ${position.id})` : undefined,
      ))
      .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
      .limit(options.limit + 1);
    const page = rows.slice(0, options.limit);
    const last = page[page.length - 1];
    return {
      deliveries: page.map((entry) => deliveryView(entry.row)),
      nextCursor: rows.length > options.limit && last ? encodeCursor({ t: last.cursorAt, id: last.row.id }) : null,
    };
  });
}
