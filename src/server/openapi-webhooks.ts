import { z } from "zod";
import "zod-openapi";

import { appointmentStatuses } from "@/server/api-v1-contracts";

/**
 * What a webhook delivery looks like (feature 34). These are documentation only: nothing here is callable, and the
 * worker (src/worker) builds the real payloads. They live beside the API contracts so the reference shows one
 * consistent vocabulary, and the same names are used for the envelope and for each event's `data`.
 */

export const webhookAppointmentData = z.object({
  appointmentId: z.string(),
  status: z.enum(appointmentStatuses),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  serviceId: z.string(),
  staffId: z.string(),
  customerId: z.string(),
  locationId: z.string(),
  version: z.number().int(),
}).meta({ id: "WebhookAppointmentData" });

export const webhookCustomerData = z.object({ customerId: z.string() }).meta({ id: "WebhookCustomerData" });

export const webhookPaymentData = z.object({
  paymentId: z.string(),
  appointmentId: z.string().nullable(),
  amountMinor: z.number().int().meta({ description: "In the currency's smallest unit." }),
  currency: z.string().meta({ example: "INR" }),
}).meta({ id: "WebhookPaymentData" });

export const webhookTestData = z.object({ message: z.string() }).meta({ id: "WebhookTestData" });

function envelope<T extends z.ZodType>(type: string, data: T, id: string) {
  return z.object({
    id: z.string().meta({ description: "The event id. The same event keeps its id across retries; use it to ignore repeats.", example: "evt_9c1f" }),
    type: z.literal(type),
    apiVersion: z.literal("v1"),
    createdAt: z.iso.datetime({ offset: true }),
    data,
  }).meta({ id });
}

const appointmentEvents = ["appointment.created", "appointment.rescheduled", "appointment.cancelled", "appointment.completed", "appointment.no_show"] as const;

export interface WebhookEventDoc {
  type: string;
  description: string;
  schema: z.ZodType;
  example: unknown;
}

const appointmentExample = {
  appointmentId: "apt_77d2", status: "booked", startsAt: "2026-12-01T09:30:00.000Z", endsAt: "2026-12-01T10:15:00.000Z",
  serviceId: "svc_4f1c", staffId: "stf_81aa", customerId: "cus_19ab", locationId: "loc_02be", version: 1,
};

const describeAppointment: Record<(typeof appointmentEvents)[number], string> = {
  "appointment.created": "An appointment was booked, by a customer, by staff or through the API.",
  "appointment.rescheduled": "An appointment moved to a new time.",
  "appointment.cancelled": "An appointment was cancelled.",
  "appointment.completed": "An appointment was marked completed.",
  "appointment.no_show": "A customer did not arrive.",
};

export const webhookEvents: readonly WebhookEventDoc[] = [
  ...appointmentEvents.map((type) => ({
    type, description: describeAppointment[type],
    schema: envelope(type, webhookAppointmentData, `WebhookEvent_${type.replace(".", "_")}`),
    example: { id: "evt_9c1f", type, apiVersion: "v1", createdAt: "2026-11-20T08:00:00.000Z", data: appointmentExample },
  })),
  {
    type: "customer.created", description: "A customer was added, through the API, an import or the staff desk.",
    schema: envelope("customer.created", webhookCustomerData, "WebhookEvent_customer_created"),
    example: { id: "evt_9c20", type: "customer.created", apiVersion: "v1", createdAt: "2026-11-20T08:00:00.000Z", data: { customerId: "cus_19ab" } },
  },
  {
    type: "payment.captured", description: "Money was captured for an appointment.",
    schema: envelope("payment.captured", webhookPaymentData, "WebhookEvent_payment_captured"),
    example: { id: "evt_9c21", type: "payment.captured", apiVersion: "v1", createdAt: "2026-11-20T08:00:00.000Z", data: { paymentId: "pay_3a90", appointmentId: "apt_77d2", amountMinor: 80000, currency: "INR" } },
  },
  {
    type: "webhook.test", description: "Sent when you press \"Send test\" for an address. It is not a subscription; every address can receive it.",
    schema: envelope("webhook.test", webhookTestData, "WebhookEvent_webhook_test"),
    example: { id: "evt_9c22", type: "webhook.test", apiVersion: "v1", createdAt: "2026-11-20T08:00:00.000Z", data: { message: "This is a test from Kalendr." } },
  },
];

export const webhookHeaders = [
  { name: "X-Kalendr-Signature", description: "`t=<unix seconds>,v1=<hex>`. The hex is HMAC-SHA256, keyed with the endpoint's secret, over `<t>.<raw request body>`." },
  { name: "X-Kalendr-Event", description: "The event type, such as `appointment.created`." },
  { name: "X-Kalendr-Event-Id", description: "The event id; the same across retries." },
  { name: "X-Kalendr-Delivery", description: "The id of this delivery attempt's record." },
  { name: "User-Agent", description: "`Kalendr-Webhooks/1`." },
] as const;
