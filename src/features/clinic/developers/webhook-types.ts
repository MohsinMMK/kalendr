import { webhookEventTypes, type WebhookEventType } from "@/lib/api-scopes";
import type { WebhookDeliveryView, WebhookEndpointView } from "@/server/webhooks/contracts";

export type WebhookEndpoint = WebhookEndpointView;
export type WebhookDelivery = WebhookDeliveryView;
export type DeliveryStatus = WebhookDelivery["status"];

export const webhookEventDetails: Record<WebhookEventType, { label: string; description: string }> = {
  "appointment.created": { label: "Appointment booked", description: "Someone books, or staff book for them." },
  "appointment.rescheduled": { label: "Appointment moved", description: "An appointment is moved to a new time." },
  "appointment.cancelled": { label: "Appointment cancelled", description: "The customer or staff cancel an appointment." },
  "appointment.completed": { label: "Appointment completed", description: "An appointment is marked as done." },
  "appointment.no_show": { label: "No-show", description: "A customer is marked as not having come." },
  "payment.captured": { label: "Payment received", description: "Money for an appointment is collected." },
  "customer.created": { label: "Customer added", description: "A new customer is created." },
};

export const allWebhookEvents: readonly WebhookEventType[] = webhookEventTypes;
