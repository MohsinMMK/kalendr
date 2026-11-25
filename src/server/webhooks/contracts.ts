import { z } from "zod";

import { webhookEventTypes } from "@/lib/api-scopes";

/**
 * The shapes of the staff webhook routes (feature 34), shared by the routes and the Developers screen. Client-safe:
 * zod only. The address text is checked again on the server by validateWebhookUrl, which these do not repeat.
 */

const eventList = z.array(z.enum(webhookEventTypes)).min(1, "Pick at least one event.").max(webhookEventTypes.length)
  .transform((events) => [...new Set(events)]);

const urlField = z.string().trim().min(1, "Enter the address that should receive events.").max(2000);
const descriptionField = z.string().trim().max(120).nullish().transform((value) => (value ? value : null));

export const createEndpointInput = z.object({ url: urlField, description: descriptionField, events: eventList }).strict();
export type CreateEndpointInput = z.infer<typeof createEndpointInput>;

export const updateEndpointInput = z.object({
  url: urlField.optional(),
  description: descriptionField.optional(),
  events: eventList.optional(),
  status: z.enum(["active", "disabled"]).optional(),
  expectedVersion: z.number().int().min(1),
}).strict().refine((value) => value.url !== undefined || value.description !== undefined || value.events !== undefined || value.status !== undefined, {
  message: "Change at least one thing.",
});
export type UpdateEndpointInput = z.infer<typeof updateEndpointInput>;

export const deliveryListQuery = z.object({
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const webhookEndpointSchema = z.object({
  id: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  events: z.array(z.enum(webhookEventTypes)),
  status: z.enum(["active", "disabled"]),
  disabledReason: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  version: z.number().int(),
  createdAt: z.string(),
  lastDelivery: z.object({ status: z.string(), statusCode: z.number().int().nullable(), at: z.string() }).nullable(),
});
export type WebhookEndpointView = z.infer<typeof webhookEndpointSchema>;

export const webhookDeliverySchema = z.object({
  id: z.string(),
  endpointId: z.string(),
  eventId: z.string(),
  eventType: z.string(),
  status: z.enum(["pending", "succeeded", "retrying", "gave_up"]),
  attempt: z.number().int(),
  statusCode: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  nextAttemptAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  isTest: z.boolean(),
  createdAt: z.string(),
});
export type WebhookDeliveryView = z.infer<typeof webhookDeliverySchema>;

export const endpointListResponse = z.object({ data: z.object({ endpoints: z.array(webhookEndpointSchema) }) });
export const endpointCreatedResponse = z.object({ data: z.object({ endpoint: webhookEndpointSchema, secret: z.string() }) });
export const endpointResponse = z.object({ data: z.object({ endpoint: webhookEndpointSchema }) });
export const secretRotatedResponse = z.object({ data: z.object({ endpoint: webhookEndpointSchema, secret: z.string() }) });
export const deliveryQueuedResponse = z.object({ data: z.object({ deliveryId: z.string() }) });
export const deliveryListResponse = z.object({ data: z.object({ deliveries: z.array(webhookDeliverySchema), nextCursor: z.string().nullable() }) });

/** Most addresses one business may have. */
export const MAX_WEBHOOK_ENDPOINTS = 10;

/** An id from a route path. Anything else is "not found" rather than an error about the shape. */
export const webhookIdParam = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
