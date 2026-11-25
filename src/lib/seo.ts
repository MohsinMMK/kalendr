import { z } from "zod";

import type { BusinessTypeId } from "./business-types";

/** The owner's own words for search results and link previews. Both are optional; the page writes its own when empty. */
export const seoSettingsSchema = z.object({
  title: z.string().trim().max(70, "Keep the title under 70 characters.").optional(),
  description: z.string().trim().max(160, "Keep the description under 160 characters.").optional(),
});
export type SeoSettings = z.infer<typeof seoSettingsSchema>;

/** Reads the stored `seo` column. Anything odd (a hand-edited row) is dropped rather than shown. */
export function parseSeo(value: unknown): SeoSettings {
  const parsed = seoSettingsSchema.safeParse(value);
  if (parsed.success) return { title: parsed.data.title || undefined, description: parsed.data.description || undefined };
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const title = seoSettingsSchema.shape.title.safeParse(record.title);
  const description = seoSettingsSchema.shape.description.safeParse(record.description);
  return { title: (title.success && title.data) || undefined, description: (description.success && description.data) || undefined };
}

/** What decides whether search engines may list a business's pages. */
export interface IndexingFacts {
  listed: boolean;
  isActive: boolean;
  paused: boolean;
  /** The plan's state: a trial that ended, a cancelled plan past its period or a failed payment past its grace all count as lapsed. */
  planLapsed: boolean;
}

/**
 * A business is indexed only when its owner switched listing on AND it is running: not switched off, not paused by an
 * operator and not on a lapsed plan. Every other case carries `noindex`. The database's sitemap function applies the same rule.
 */
export function isIndexable(facts: IndexingFacts): boolean {
  return facts.listed && facts.isActive && !facts.paused && !facts.planLapsed;
}

export interface SubscriptionFacts {
  status: string;
  trialEndsAt: Date | null;
  pastDueSince: Date | null;
  currentPeriodEnd: Date | null;
}

const graceDays = 7;
const dayMs = 86_400_000;

/** Mirrors `kalendr_subscription_serves` in migration 0074. No subscription row yet means the business is new, not lapsed. */
export function planHasLapsed(subscription: SubscriptionFacts | null, now: Date = new Date()): boolean {
  if (!subscription) return false;
  switch (subscription.status) {
    case "trialing": return !(subscription.trialEndsAt && subscription.trialEndsAt > now);
    case "past_due": return !(subscription.pastDueSince && subscription.pastDueSince.getTime() > now.getTime() - graceDays * dayMs);
    case "cancelled": return !(subscription.currentPeriodEnd && subscription.currentPeriodEnd > now);
    default: return false;
  }
}

/** `{ robots }` for a page's metadata. Pages that are not for search engines pass `indexable: false`. */
export function robotsFor(indexable: boolean): { index: boolean; follow: boolean } {
  return indexable ? { index: true, follow: true } : { index: false, follow: false };
}

const bareHost = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

/**
 * The address a page calls its own. A verified custom domain wins; otherwise Kalendr's address. `path` starts with "/".
 * A host that is not a plain host name is ignored, so a bad stored value cannot put another site's address in a tag.
 */
export function canonicalUrl(options: { appUrl: string; customHost?: string | null; path: string }): string {
  const host = options.customHost?.trim().toLowerCase();
  if (host && bareHost.test(host) && host.includes(".")) return `https://${host}${options.path}`;
  return `${options.appUrl.replace(/\/+$/, "")}${options.path}`;
}

/** The path a business page has on Kalendr's address. On its own domain the proxy serves the same pages at the root. */
export function pagePath(kind: "business" | "service" | "person", slug: string, key = "", onCustomDomain = false): string {
  if (kind === "business") return onCustomDomain ? "/" : `/b/${slug}`;
  if (kind === "service") return onCustomDomain ? `/book/${key}` : `/book/${slug}/${key}`;
  return onCustomDomain ? `/b/${slug}/team/${key}` : `/b/${slug}/team/${key}`;
}

/** How each business type is named in structured data. Anything without a closer match is a plain LocalBusiness. */
export const schemaTypeFor: Record<BusinessTypeId, string> = {
  healthcare: "MedicalClinic",
  dental: "Dentist",
  wellness: "BeautySalon",
  real_estate: "RealEstateAgent",
  professional_services: "ProfessionalService",
  retail: "Store",
  education: "EducationalOrganization",
  other: "LocalBusiness",
};

/** A page title for search results: the owner's own when set, otherwise one that says what the page is for. */
export function businessTitle(name: string, city: string | undefined, seo: SeoSettings): string {
  return seo.title ?? `Book an appointment at ${name}${city ? `, ${city}` : ""}`;
}
