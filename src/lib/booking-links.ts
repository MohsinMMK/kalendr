import { z } from "zod";

/**
 * Short links for printed cards and bio links (feature 52). A link opens the business's booking page, or one service's page,
 * with optional prefill and campaign tags. The address is always built here from fixed pieces, so a link can never lead off
 * the business's own booking pages.
 */
export const SHORT_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const SHORT_CODE_LENGTH = 7;
export const shortCodePattern = /^[a-z2-9]{7}$/;

/** Booking-page query keys a link may carry: the campaign tags and the form's built-in prefill keys. */
export const linkPrefillKeys = ["name", "email", "phone", "notes", "location", "person"] as const;
export type LinkPrefillKey = (typeof linkPrefillKeys)[number];

const tag = z.string().trim().max(100).regex(/^[\w .~+-]*$/, "Use letters, numbers, spaces and - _ . ~ + only.");

export const bookingLinkInputSchema = z.object({
  label: z.string().trim().min(1, "Give the link a name.").max(80),
  /** Link-safe name of one service. Empty is the business's whole booking page. */
  serviceSlug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80).nullable().default(null),
  utmSource: tag.optional(),
  utmMedium: tag.optional(),
  utmCampaign: tag.optional(),
  prefill: z.partialRecord(z.enum(linkPrefillKeys), z.string().trim().max(200)).default({}),
});
export type BookingLinkInput = z.infer<typeof bookingLinkInputSchema>;

export interface BookingLinkView {
  id: string;
  code: string;
  label: string;
  targetPath: string;
  clicks: number;
  isActive: boolean;
  createdAt: string;
}

/** `/book/<business>[/<service>]?…` for a link's choices. Only the keys above are written, each value encoded. */
export function bookingLinkPath(clinicSlug: string, input: Pick<BookingLinkInput, "serviceSlug" | "utmSource" | "utmMedium" | "utmCampaign" | "prefill">): string {
  const query = new URLSearchParams();
  if (input.utmSource) query.set("utm_source", input.utmSource);
  if (input.utmMedium) query.set("utm_medium", input.utmMedium);
  if (input.utmCampaign) query.set("utm_campaign", input.utmCampaign);
  for (const key of linkPrefillKeys) {
    const value = input.prefill[key];
    if (value) query.set(key, value);
  }
  const base = `/book/${clinicSlug}${input.serviceSlug ? `/${input.serviceSlug}` : ""}`;
  const text = query.toString();
  return text ? `${base}?${text}` : base;
}

export function shortLinkUrl(origin: string, code: string): string {
  return `${origin.replace(/\/$/, "")}/s/${code}`;
}
