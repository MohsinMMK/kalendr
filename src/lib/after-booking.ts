import { z } from "zod";

/**
 * What a customer sees once the booking is made (feature 52): Kalendr's own confirmation page, optionally with the
 * business's message and without the booking details, or the business's own thank-you page.
 */
export const afterBookingModes = ["kalendr_page", "redirect"] as const;
export type AfterBookingMode = (typeof afterBookingModes)[number];

/** A thank-you page address. https only (plain http only for a local test page), no embedded sign-in, no fragment. */
export function isRedirectUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:") return true;
  return process.env.NODE_ENV !== "production" && url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

const redirectUrlSchema = z.string().trim().max(500).refine(isRedirectUrl, "Use a full https:// address, with no password or # part.");

export const afterBookingSchema = z.object({
  mode: z.enum(afterBookingModes),
  redirectUrl: redirectUrlSchema.nullable(),
  passDetailsOnRedirect: z.boolean(),
  successMessage: z.string().trim().max(500).nullable(),
  hideSuccessDetails: z.boolean(),
}).refine((value) => value.mode !== "redirect" || value.redirectUrl, {
  message: "Add the thank-you page address.",
  path: ["redirectUrl"],
});
export type AfterBookingSettings = z.infer<typeof afterBookingSchema>;

export const defaultAfterBooking: AfterBookingSettings = {
  mode: "kalendr_page",
  redirectUrl: null,
  passDetailsOnRedirect: false,
  successMessage: null,
  hideSuccessDetails: false,
};

/** What the public booking page needs to know. The address itself is built on the server, with the booking's own token. */
export interface PublicAfterBooking {
  mode: AfterBookingMode;
  successMessage: string | null;
  hideDetails: boolean;
}

export const afterBookingLabels: Record<AfterBookingMode, { label: string; description: string }> = {
  kalendr_page: { label: "Show the confirmation", description: "The customer stays on the booking page and sees the confirmation." },
  redirect: { label: "Go to my own page", description: "Send the customer to your thank-you page as soon as they book." },
};
