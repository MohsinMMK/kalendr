/**
 * What an API key may do (feature 34). A key carries a list of these; every request checks the one it needs.
 * Kept free of server code so the settings screen and the docs page can show the same list.
 */
export const apiScopes = [
  "services:read",
  "staff:read",
  "availability:read",
  "appointments:read",
  "appointments:write",
  "customers:read",
  "customers:write",
  // Narrow scopes for the browser extension (feature 57): see today's bookings by first name, and make single-use links.
  "bookings:today",
  "links:write",
] as const;

export type ApiScope = (typeof apiScopes)[number];

export const apiScopeLabels: Record<ApiScope, { label: string; description: string }> = {
  "services:read": { label: "Read services", description: "List the services people can book." },
  "staff:read": { label: "Read staff", description: "List the staff who take bookings." },
  "availability:read": { label: "Read availability", description: "Find open times for a service." },
  "appointments:read": { label: "Read appointments", description: "List and open appointments." },
  "appointments:write": { label: "Book and change appointments", description: "Book, move and cancel appointments." },
  "customers:read": { label: "Read customers", description: "Find customers by phone or email and open one." },
  "customers:write": { label: "Add customers", description: "Create new customers." },
  "bookings:today": { label: "See today's bookings", description: "Today's times and first names only. No phone numbers or emails." },
  "links:write": { label: "Make single-use booking links", description: "Create links that book one service once." },
};

export function isApiScope(value: string): value is ApiScope {
  return (apiScopes as readonly string[]).includes(value);
}

/** Scopes that change data. A test key may not hold any of them. */
export const apiWriteScopes: readonly ApiScope[] = ["appointments:write", "customers:write", "links:write"];

export const apiKeyModes = ["live", "test"] as const;
export type ApiKeyMode = (typeof apiKeyModes)[number];

/** The webhook events a business can subscribe to. */
export const webhookEventTypes = [
  "appointment.created",
  "appointment.rescheduled",
  "appointment.cancelled",
  "appointment.completed",
  "appointment.no_show",
  "payment.captured",
  "customer.created",
] as const;
export type WebhookEventType = (typeof webhookEventTypes)[number];

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (webhookEventTypes as readonly string[]).includes(value);
}
