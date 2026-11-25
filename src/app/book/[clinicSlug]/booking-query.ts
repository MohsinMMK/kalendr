import type { BookingOriginInput } from "@/lib/contracts";
import { readEmbedBridge } from "@/lib/embed/query";

export { readEmbedBridge };

/**
 * Where this booking started. The website button adds a nonce, a plain iframe only `embed=1`.
 * Campaign tags come from the link (or, for the button, from the page it sits on).
 */
export function readBookingOrigin(
  searchParams: Record<string, string | string[] | undefined>,
  bridge: { parentOrigin: string } | null,
): BookingOriginInput {
  const tag = (name: string) => {
    const value = searchParams[name];
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : undefined;
  };
  return {
    channel: bridge ? "widget" : searchParams.embed === "1" ? "iframe" : "hosted",
    ...(bridge ? { referrerHost: new URL(bridge.parentOrigin).host } : {}),
    utmSource: tag("utm_source"),
    utmMedium: tag("utm_medium"),
    utmCampaign: tag("utm_campaign"),
  };
}

/** The link's query as plain strings, for filling the booking form (`?email=…&campaign=…`). Repeated keys keep the first. */
export function readLinkParams(searchParams: Record<string, string | string[] | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(searchParams).flatMap(([key, value]) => {
      const first = Array.isArray(value) ? value[0] : value;
      return typeof first === "string" ? [[key, first.slice(0, 3000)]] : [];
    }),
  );
}
