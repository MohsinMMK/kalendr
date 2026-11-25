import { createHash } from "node:crypto";

import { z } from "zod";

import type { WebhookEventType } from "@/lib/api-scopes";

/**
 * What a webhook body looks like (feature 34): one envelope for every event, and data that holds ids, times and
 * numbers only. No names, phones, emails or notes, so a receiver that logs bodies is not holding customer details;
 * it looks up the rest through the API with its own key.
 */

export const WEBHOOK_API_VERSION = "v1";

export const appointmentEventDataSchema = z.object({
  appointmentId: z.string().min(1),
  status: z.string().min(1),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  serviceId: z.string().min(1),
  staffId: z.string().min(1),
  customerId: z.string().min(1),
  locationId: z.string().min(1),
  version: z.number().int(),
});
export type AppointmentEventData = z.infer<typeof appointmentEventDataSchema>;

export const customerEventDataSchema = z.object({ customerId: z.string().min(1) });
export const paymentEventDataSchema = z.object({
  paymentId: z.string().min(1),
  appointmentId: z.string().min(1).nullable(),
  amountMinor: z.number().int(),
  currency: z.string().min(3).max(3),
});
export const testEventDataSchema = z.object({ message: z.literal("This is a test event from Kalendr.") });

export const testEventType = "webhook.test";
export type DeliveredEventType = WebhookEventType | typeof testEventType;

const envelopeBase = {
  id: z.string().min(1),
  apiVersion: z.literal(WEBHOOK_API_VERSION),
  createdAt: z.string().min(1),
};

export const webhookEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({ ...envelopeBase, type: z.enum(["appointment.created", "appointment.rescheduled", "appointment.cancelled", "appointment.completed", "appointment.no_show"]), data: appointmentEventDataSchema }),
  z.object({ ...envelopeBase, type: z.literal("customer.created"), data: customerEventDataSchema }),
  z.object({ ...envelopeBase, type: z.literal("payment.captured"), data: paymentEventDataSchema }),
  z.object({ ...envelopeBase, type: z.literal(testEventType), data: testEventDataSchema }),
]);
export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;

/** The internal outbox event type to the public one. Types not listed here never produce a webhook. */
const publicTypeByOutboxType: Record<string, WebhookEventType> = {
  "appointment.created": "appointment.created",
  "appointment.reschedule": "appointment.rescheduled",
  "appointment.cancel": "appointment.cancelled",
  "appointment.status.cancelled": "appointment.cancelled",
  "appointment.status.completed": "appointment.completed",
  "appointment.status.no_show": "appointment.no_show",
  "customer.created": "customer.created",
  "payment.captured": "payment.captured",
};

/**
 * The public event for an outbox row, or null. A "created" row that only offers a customer a new time (its dedupe
 * key starts with appointment.reschedule_offer) is not a new booking and sends nothing.
 */
export function publicEventFor(eventType: string, dedupeKey: string): WebhookEventType | null {
  if (dedupeKey.startsWith("appointment.reschedule_offer")) return null;
  return publicTypeByOutboxType[eventType] ?? null;
}

export function isAppointmentEvent(type: WebhookEventType): boolean {
  return type.startsWith("appointment.");
}

/**
 * A stable id for the event: the same change gives the same id on every endpoint and on every retry of the fan-out,
 * and cancel plus status-cancelled for one version collapse into one event. Receivers use it to drop repeats.
 */
export function eventIdFor(parts: readonly string[]): string {
  return `evt_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32)}`;
}

export function envelope(id: string, type: WebhookEventType, data: unknown, createdAt: Date): WebhookEnvelope {
  return webhookEnvelopeSchema.parse({ id, type, apiVersion: WEBHOOK_API_VERSION, createdAt: createdAt.toISOString(), data });
}

export function testEnvelope(id: string, createdAt: Date): WebhookEnvelope {
  return webhookEnvelopeSchema.parse({ id, type: testEventType, apiVersion: WEBHOOK_API_VERSION, createdAt: createdAt.toISOString(), data: { message: "This is a test event from Kalendr." } });
}
