import type { Metadata } from "next";

import { PosterSheet } from "@/features/clinic/poster-sheet";
import { readAccent } from "@/lib/brand-theme";
import { parsePosterSize } from "@/lib/share-kit";
import { loadStaffBrand } from "@/server/brand";
import { loadListing } from "@/server/listing";
import { requirePageAccess } from "@/server/staff-page-guard";

export const metadata: Metadata = {
  title: "Booking poster",
  robots: { index: false, follow: false },
};

const defaultAccent = "#0f766e";

/** The printable poster: the business's name and colour, and a QR code that opens its booking page with a source tag. */
export default async function PosterPage({ searchParams }: { searchParams: Promise<{ size?: string }> }) {
  const [context, { size }] = await Promise.all([requirePageAccess("print-poster"), searchParams]);
  const [listing, brand] = await Promise.all([loadListing(context), loadStaffBrand(context)]);
  const posterLink = listing.links.find((link) => link.id === "poster");
  const accent = brand.settings.accent ?? defaultAccent;
  return (
    <PosterSheet
      size={parsePosterSize(size)}
      businessName={listing.businessName}
      city={listing.city}
      url={posterLink?.url ?? listing.pageUrl}
      shortUrl={listing.pageUrl.replace(/^https?:\/\//, "")}
      accent={accent}
      textColor={readAccent(accent).text}
      showBadge={!brand.settings.hideBadge}
      preview={listing.preview}
    />
  );
}
