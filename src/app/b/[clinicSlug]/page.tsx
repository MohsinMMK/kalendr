import type { Metadata } from "next";

import { BookingShell } from "@/features/booking/booking-shell";
import { BusinessPage } from "@/features/business/business-page";
import { dateKeyIn, weekdayIndexIn, type WeekHours } from "@/lib/business-page";
import { profileWords } from "@/lib/terminology";
import { businessTitle } from "@/lib/seo";
import { businessStructuredData, jsonLdScript } from "@/lib/structured-data";
import { loadLatestReviews, loadNextFreeDays, loadOpeningHours } from "@/server/business-page";
import { canonicalFor, loadDiscoveryState } from "@/server/discovery";
import { pageMetadata } from "@/server/page-seo";

import { getBusinessCatalog } from "./catalog";
import { publicAppUrl } from "@/server/env";
import { unavailablePage } from "@/features/booking/unavailable-page";

interface BusinessPageRouteProps {
  params: Promise<{ clinicSlug: string }>;
}

export async function generateMetadata({ params }: BusinessPageRouteProps): Promise<Metadata> {
  const { clinicSlug } = await params;
  const catalog = await getBusinessCatalog(clinicSlug);
  if (!catalog) return { title: "Page unavailable", robots: { index: false, follow: false } };

  const state = await loadDiscoveryState(clinicSlug);
  const t = profileWords(catalog.profile);
  const city = catalog.locations.find((location) => location.isActive !== false)?.city;
  const description =
    state?.seo.description ??
    catalog.clinic.about?.slice(0, 160) ??
    `Book ${t.anAppointment} at ${catalog.clinic.name}${city ? ` in ${city}` : ""}. See ${t.services}, ${t.providers}, opening hours and reviews.`;
  return pageMetadata({
    title: businessTitle(catalog.clinic.name, city, state?.seo ?? {}),
    description,
    canonical: canonicalFor(state, "business", catalog.clinic.slug),
    indexable: state?.indexable ?? false,
    siteName: catalog.clinic.name,
  });
}

export default async function BusinessPageRoute({ params }: BusinessPageRouteProps) {
  const { clinicSlug } = await params;
  const catalog = await getBusinessCatalog(clinicSlug);
  if (!catalog) return unavailablePage(clinicSlug);

  const now = new Date();
  const [hours, freeDays, reviews] = await Promise.all([
    loadOpeningHours(catalog, now).catch((): Record<string, WeekHours> => ({})),
    loadNextFreeDays(catalog, now).catch(() => ({})),
    loadLatestReviews(catalog, { limit: 20 }),
  ]);
  const timeZone = catalog.locations[0]?.timezone ?? catalog.clinic.timezone;
  const state = await loadDiscoveryState(clinicSlug);
  const firstLocation = catalog.locations.find((location) => location.isActive !== false);
  // Structured data is only for pages search engines may list.
  const markup = state?.indexable
    ? jsonLdScript(businessStructuredData({
      name: catalog.clinic.name,
      url: canonicalFor(state, "business", catalog.clinic.slug),
      businessType: catalog.clinic.businessType,
      description: state.seo.description ?? catalog.clinic.about,
      phone: catalog.clinic.phone,
      imageUrl: catalog.clinic.logoUrl ? new URL(catalog.clinic.logoUrl, publicAppUrl()).toString() : null,
      currency: catalog.clinic.currency,
      address: firstLocation ? { street: firstLocation.address, city: firstLocation.city } : null,
      hours: firstLocation ? hours[firstLocation.id] : undefined,
      services: catalog.services
        .filter((service) => service.isActive !== false && service.visibility !== "hidden" && service.slug)
        .map((service) => ({ name: service.name, description: service.description, priceMinor: service.priceMinor, url: canonicalFor(state, "service", catalog.clinic.slug, service.slug) })),
      rating: catalog.ratings?.business ?? null,
    }))
    : null;

  return (
    <>
    {markup ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: markup }} /> : null}
    <BookingShell topBar={false} clinicName={catalog.clinic.name} clinicPhone={catalog.clinic.phone} logoUrl={catalog.clinic.logoUrl} brand={catalog.clinic.brand} profile={catalog.profile}>
      <BusinessPage
        clinic={catalog.clinic}
        locations={catalog.locations}
        services={catalog.services}
        practitioners={catalog.practitioners}
        ratings={catalog.ratings}
        hours={hours}
        freeDays={freeDays}
        reviews={reviews}
        guide={catalog.guide ? { title: catalog.guide.title, intro: catalog.guide.intro } : null}
        todayKey={dateKeyIn(now, timeZone)}
        todayIndex={weekdayIndexIn(timeZone, now)}
      />
    </BookingShell>
    </>
  );
}
