import "server-only";

import type { Metadata } from "next";

import { robotsFor } from "@/lib/seo";

/**
 * The tags a public page sends to search engines and link previews. The title is absolute (no " · Kalendr" tail) because
 * the page belongs to the business. Without an `image`, the segment's generated preview picture (opengraph-image) is used.
 */
export function pageMetadata(input: {
  title: string;
  description: string;
  canonical: string;
  indexable: boolean;
  type?: "website" | "profile";
  siteName?: string;
  image?: string | null;
}): Metadata {
  return {
    title: { absolute: input.title },
    description: input.description,
    alternates: { canonical: input.canonical },
    robots: robotsFor(input.indexable),
    openGraph: {
      type: input.type ?? "website",
      title: input.title,
      description: input.description,
      url: input.canonical,
      ...(input.siteName ? { siteName: input.siteName } : {}),
      ...(input.image ? { images: [{ url: input.image }] } : {}),
    },
    twitter: { card: input.image || input.type !== "profile" ? "summary_large_image" : "summary", title: input.title, description: input.description },
  };
}

/** Query words that only tag where a visitor came from. Any other query word is booking state, which is never indexed. */
const trackingWords = /^(utm_[a-z]+|ref|source|fbclid|gclid|embed)$/;

export function hasBookingState(searchParams: Record<string, string | string[] | undefined>): boolean {
  return Object.keys(searchParams).some((key) => !trackingWords.test(key));
}
