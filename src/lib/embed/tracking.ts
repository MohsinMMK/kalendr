import { z } from "zod";

import type { EmbedEvent } from "./protocol";

/**
 * The tracking ids a business can add to its booking pages (feature 52). The business enters ids, never script code; the page
 * adds each provider's own snippet after the visitor accepts analytics cookies. Each pattern matches the database check.
 */
const optionalId = (pattern: RegExp, message: string) =>
  z.string().trim().regex(pattern, message).nullable();

export const trackingSettingsSchema = z.object({
  googleAnalyticsId: optionalId(/^(G|UA|AW)-[A-Z0-9-]{4,20}$/, "A Google Analytics id looks like G-ABC123XYZ.").default(null),
  tagManagerId: optionalId(/^GTM-[A-Z0-9]{4,12}$/, "A Tag Manager id looks like GTM-ABC123.").default(null),
  metaPixelId: optionalId(/^[0-9]{8,20}$/, "A Meta pixel id is 8 to 20 digits.").default(null),
  plausibleDomain: optionalId(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/, "Enter just your site's domain, like example.com.").default(null),
});
export type TrackingSettings = z.infer<typeof trackingSettingsSchema>;

export const trackingUpdateSchema = trackingSettingsSchema.extend({ expectedVersion: z.number().int().min(0) });
export type TrackingUpdate = z.infer<typeof trackingUpdateSchema>;

export const emptyTracking: TrackingSettings = { googleAnalyticsId: null, tagManagerId: null, metaPixelId: null, plausibleDomain: null };

export function hasTracking(settings: TrackingSettings | null | undefined): settings is TrackingSettings {
  return Boolean(settings && (settings.googleAnalyticsId || settings.tagManagerId || settings.metaPixelId || settings.plausibleDomain));
}

/** The conversion each provider is told about. Ids only: the pixels never get a name, email or phone. */
export interface ConversionCall {
  provider: "ga" | "gtm" | "meta" | "plausible";
  name: string;
  params?: Record<string, string>;
}

export function conversionCalls(event: EmbedEvent): ConversionCall[] {
  const params: Record<string, string> = {};
  if (event.data.serviceId) params.service_id = event.data.serviceId;
  if (event.data.appointmentId) params.booking_id = event.data.appointmentId;
  const calls: ConversionCall[] = [];
  const steps: Partial<Record<EmbedEvent["event"], { ga: string; meta: string; plausible: string }>> = {
    service_selected: { ga: "select_item", meta: "ViewContent", plausible: "Service selected" },
    slot_selected: { ga: "begin_checkout", meta: "InitiateCheckout", plausible: "Time selected" },
    booked: { ga: "generate_lead", meta: "Schedule", plausible: "Booking" },
  };
  const step = steps[event.event];
  if (!step) return calls;
  calls.push({ provider: "ga", name: step.ga, params });
  calls.push({ provider: "gtm", name: `kalendr_${event.event}`, params });
  calls.push({ provider: "meta", name: step.meta, params });
  calls.push({ provider: "plausible", name: step.plausible, params });
  return calls;
}

/** Where each provider's official script is loaded from. The content security policy lists exactly these hosts. */
export const trackingScriptHosts = {
  googleTag: "https://www.googletagmanager.com",
  metaPixel: "https://connect.facebook.net",
  plausible: "https://plausible.io",
} as const;

/** Hosts the providers send data to, for connect-src and img-src. */
export const trackingConnectHosts = [
  "https://www.google-analytics.com",
  "https://region1.google-analytics.com",
  "https://*.analytics.google.com",
  "https://www.googletagmanager.com",
  "https://www.facebook.com",
  "https://plausible.io",
] as const;
export const trackingImageHosts = ["https://www.google-analytics.com", "https://www.googletagmanager.com", "https://www.facebook.com"] as const;

/** The saved choice about analytics cookies. Stored in this browser only, per business, declined until the visitor accepts. */
export type ConsentChoice = "accepted" | "declined";

export function consentKey(clinicSlug: string): string {
  return `kalendr-analytics-consent:${clinicSlug}`;
}

export function readConsent(clinicSlug: string): ConsentChoice | null {
  try {
    const stored = window.localStorage.getItem(consentKey(clinicSlug));
    return stored === "accepted" || stored === "declined" ? stored : null;
  } catch {
    return null;
  }
}

export function saveConsent(clinicSlug: string, choice: ConsentChoice): void {
  try {
    window.localStorage.setItem(consentKey(clinicSlug), choice);
  } catch {
    // The choice still applies to this visit; it just is not remembered.
  }
}
