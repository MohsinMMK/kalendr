import { schemaTypeFor } from "./seo";
import type { BusinessTypeId } from "./business-types";
import type { RatingSummary } from "./reviews";

/** The facts the markup is built from. All of it is already public on the booking page. */
export interface BusinessMarkupInput {
  name: string;
  /** The page's canonical address. */
  url: string;
  businessType?: BusinessTypeId;
  description?: string | null;
  phone?: string | null;
  /** The public address of the logo or cover picture, if there is one. */
  imageUrl?: string | null;
  currency?: string;
  address?: { street: string; city: string } | null;
  /** Monday first: ISO weekdays 1 to 7. A null day is closed. */
  hours?: ({ opens: string; closes: string } | null)[];
  services?: { name: string; description?: string | null; priceMinor?: number | null; url: string }[];
  /** Published, public, not-hidden reviews only. Never an invented figure. */
  rating?: RatingSummary | null;
}

const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function compact(value: { [key: string]: Json | undefined }): { [key: string]: Json } {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, Json] => entry[1] !== undefined && entry[1] !== null && entry[1] !== ""));
}

/** Smallest unit to a decimal string: 150000 INR minor units is "1500.00". Zero-decimal currencies are not used here. */
function price(minor: number): string {
  return (minor / 100).toFixed(2);
}

/**
 * The page's JSON-LD (schema.org) as a plain object. The right business type, address, phone, opening hours, services with
 * prices, and an `AggregateRating` only when enough real published reviews exist. Pass the result to `jsonLdScript`.
 */
export function businessStructuredData(input: BusinessMarkupInput): Record<string, Json> {
  const address = input.address && input.address.city
    ? { "@type": "PostalAddress", streetAddress: input.address.street, addressLocality: input.address.city }
    : undefined;
  const hours: Json[] = (input.hours ?? []).flatMap((day, index): Json[] => day
    ? [{ "@type": "OpeningHoursSpecification", dayOfWeek: dayNames[index] ?? "Monday", opens: day.opens, closes: day.closes }]
    : []);
  const offers: Json[] = (input.services ?? []).slice(0, 50).map((service) => compact({
    "@type": "Offer",
    url: service.url,
    itemOffered: compact({ "@type": "Service", name: service.name, description: service.description?.slice(0, 300) }),
    price: typeof service.priceMinor === "number" && service.priceMinor > 0 ? price(service.priceMinor) : undefined,
    priceCurrency: typeof service.priceMinor === "number" && service.priceMinor > 0 ? input.currency ?? "INR" : undefined,
  }));
  // The same average and count the page shows, from published reviews only.
  const rating = input.rating && input.rating.average !== null && input.rating.count > 0
    ? { "@type": "AggregateRating", ratingValue: input.rating.average, reviewCount: input.rating.count, bestRating: 5, worstRating: 1 }
    : undefined;
  return compact({
    "@context": "https://schema.org",
    "@type": schemaTypeFor[input.businessType ?? "healthcare"] ?? "LocalBusiness",
    name: input.name,
    url: input.url,
    description: input.description?.slice(0, 300),
    telephone: input.phone ?? undefined,
    image: input.imageUrl ?? undefined,
    address,
    openingHoursSpecification: hours.length > 0 ? hours : undefined,
    makesOffer: offers.length > 0 ? offers : undefined,
    aggregateRating: rating,
  });
}

const lineSeparator = String.fromCharCode(0x2028);
const paragraphSeparator = String.fromCharCode(0x2029);

/**
 * The text for a `<script type="application/ld+json">` tag. `JSON.stringify` alone is not enough: a business named
 * `</script><script>alert(1)</script>` would close the tag. The characters that can do that, and the two line separators
 * that break older parsers, are written as unicode escapes, which JSON readers decode back to the same text.
 */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replaceAll(lineSeparator, "\\u2028")
    .replaceAll(paragraphSeparator, "\\u2029");
}
