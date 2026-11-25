import { bookingLinkPath } from "./booking-links";

/** Where a shared link is posted. Each gets its own `utm_source`, so reports can say which one brought a booking. */
export const shareChannels = [
  { id: "instagram", label: "Instagram bio", source: "instagram", medium: "bio", hint: "Paste it in Edit profile, Website." },
  { id: "whatsapp", label: "WhatsApp", source: "whatsapp", medium: "message", hint: "Send it in a chat or set it as your WhatsApp Business link." },
  { id: "google", label: "Google Business Profile", source: "google", medium: "business_profile", hint: "Use it as the Book button. The steps are below." },
  { id: "email", label: "Email signature", source: "email", medium: "signature", hint: "Add it under your name in every email." },
  { id: "poster", label: "Poster QR code", source: "poster", medium: "qr", hint: "The code on the printed poster uses this link." },
] as const;

export type ShareChannelId = (typeof shareChannels)[number]["id"];

export interface ShareLink {
  id: ShareChannelId;
  label: string;
  hint: string;
  url: string;
}

/** The booking link for each place it is posted, tagged with its source. `origin` is the business's own address or Kalendr's. */
export function shareLinks(origin: string, slug: string, serviceSlug: string | null = null): ShareLink[] {
  const base = origin.replace(/\/+$/, "");
  return shareChannels.map((channel) => ({
    id: channel.id,
    label: channel.label,
    hint: channel.hint,
    url: `${base}${bookingLinkPath(slug, { serviceSlug, utmSource: channel.source, utmMedium: channel.medium, utmCampaign: "share-kit", prefill: {} })}`,
  }));
}

/** One line for the bottom of an email. Plain text, so it pastes into any mail program. */
export function emailSignatureLine(businessName: string, url: string): string {
  return `Book an appointment with ${businessName}: ${url}`;
}

export const posterSizes = ["a4", "a5"] as const;
export type PosterSize = (typeof posterSizes)[number];

export function parsePosterSize(value: string | null | undefined): PosterSize {
  return posterSizes.find((size) => size === value) ?? "a4";
}

/** The staff-only page that prints the poster. */
export function posterPath(size: PosterSize): string {
  return `/print/poster?size=${size}`;
}
