import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { BookingEmbedBridge } from "@/features/booking/booking-embed-bridge";
import { BookingFlow } from "@/features/booking/booking-flow";
import { TrackingPixels } from "@/features/booking/tracking-pixels";
import { publicTracking } from "@/server/embed-tracking";
import { BookingShell } from "@/features/booking/booking-shell";
import { canonicalFor, loadDiscoveryState } from "@/server/discovery";
import { hasBookingState, pageMetadata } from "@/server/page-seo";
import { getPublicClinicCatalog } from "@/server/public-catalog";

import { readBookingOrigin, readEmbedBridge, readLinkParams } from "../booking-query";
import { unavailablePage } from "@/features/booking/unavailable-page";

/** The direct link to one service. A hidden service is found here and nowhere else. */
const getServiceCatalog = cache((clinicSlug: string, serviceSlug: string) =>
  getPublicClinicCatalog(clinicSlug, { includeHiddenSlug: serviceSlug }));

interface ServiceBookingPageProps {
  params: Promise<{ clinicSlug: string; serviceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params, searchParams }: ServiceBookingPageProps): Promise<Metadata> {
  const { clinicSlug, serviceSlug } = await params;
  const catalog = await getServiceCatalog(clinicSlug, serviceSlug);
  const service = catalog?.services.find((entry) => entry.slug === serviceSlug);
  if (!catalog || !service) return { title: "Booking page unavailable", robots: { index: false, follow: false } };
  const state = await loadDiscoveryState(clinicSlug);
  const city = catalog.locations.find((location) => location.isActive !== false)?.city;
  // The page itself is a listed service's own address. A hidden service is shared by link only, and a link that carries
  // booking state (a chosen time, a step) is a step of the flow, so neither is indexed.
  const indexable = (state?.indexable ?? false) && service.visibility !== "hidden" && service.isActive !== false && !hasBookingState(await searchParams);
  return pageMetadata({
    title: `Book ${service.name} with ${catalog.clinic.name}${city ? `, ${city}` : ""}`,
    description: service.description.slice(0, 160),
    canonical: canonicalFor(state, "service", catalog.clinic.slug, serviceSlug),
    indexable,
    siteName: catalog.clinic.name,
    image: service.bannerUrl ?? service.imageUrl ?? null,
  });
}

export default async function ServiceBookingPage({ params, searchParams }: ServiceBookingPageProps) {
  const { clinicSlug, serviceSlug } = await params;
  const catalog = await getServiceCatalog(clinicSlug, serviceSlug);
  const service = catalog?.services.find((entry) => entry.slug === serviceSlug && entry.isActive !== false);
  if (!catalog) return unavailablePage(clinicSlug);
  if (!service) notFound();

  const query = await searchParams;
  const bridge = readEmbedBridge(query);
  const tracking = catalog.preview ? null : await publicTracking(catalog.clinic.id);
  return (
    <>
      {tracking ? <TrackingPixels clinicSlug={catalog.clinic.slug} clinicName={catalog.clinic.name} settings={tracking} /> : null}
      {bridge ? <BookingEmbedBridge nonce={bridge.nonce} parentOrigin={bridge.parentOrigin} /> : null}
      <BookingShell topBar={false} clinicName={catalog.clinic.name} clinicPhone={catalog.clinic.phone} logoUrl={catalog.clinic.logoUrl} brand={catalog.clinic.brand} embedded={Boolean(bridge)} profile={catalog.profile}>
        <BookingFlow
          clinic={catalog.clinic}
          locations={catalog.locations}
          services={catalog.services}
          practitioners={catalog.practitioners}
          resources={catalog.resources}
          initialSlots={catalog.initialSlots}
          allowDemoFallback={catalog.preview}
          origin={readBookingOrigin(query, bridge)}
          initialServiceId={service.id}
          initialPersonId={typeof query.person === "string" ? query.person : undefined}
          initialDate={typeof query.date === "string" ? query.date : undefined}
          initialTime={typeof query.time === "string" ? query.time : undefined}
          forms={catalog.forms}
          prefill={readLinkParams(query)}
        />
      </BookingShell>
    </>
  );
}
