import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { BookingShell } from "@/features/booking/booking-shell";
import { OfferPage } from "@/features/booking/offer-page";
import { defaultBusinessProfile, profileWords } from "@/lib/terminology";
import { loadPublicBrandBySlug } from "@/server/brand";
import { ApiError } from "@/server/api-error";
import { offerTokenFrom, readOffer, type OfferPage as OfferPageData } from "@/server/waitlist-accept";

interface OfferRouteProps {
  params: Promise<{ token: string }>;
}

/** The offer behind a link, read once per render. A dead link is a 404 before anything renders; a temporary failure still opens the page, which offers Try again. */
const loadOffer = cache(async (token: string): Promise<{ page: OfferPageData | null }> => {
  try {
    return { page: await readOffer(offerTokenFrom(token)) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    return { page: null };
  }
});

export async function generateMetadata({ params }: OfferRouteProps): Promise<Metadata> {
  const { token } = await params;
  const { page } = await loadOffer(token);
  const t = profileWords(page?.profile ?? defaultBusinessProfile);
  return { title: `A ${t.appointment} time opened up`, description: "Take a time that has just opened up.", robots: { index: false, follow: false } };
}

export default async function OfferRoute({ params }: OfferRouteProps) {
  const { token } = await params;
  const { page } = await loadOffer(token);
  const { profile, ...view } = page ?? { profile: undefined };
  const look = page ? await loadPublicBrandBySlug(page.business.slug) : undefined;
  return (
    <BookingShell clinicName={page?.business.name} clinicPhone={page?.business.phone} profile={profile} brand={look}>
      <OfferPage token={token} initial={page ? (view as NonNullable<typeof page>) : null} />
    </BookingShell>
  );
}
