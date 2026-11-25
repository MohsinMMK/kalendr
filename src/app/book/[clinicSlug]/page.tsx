import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";

import { AssistantChat } from "@/features/booking/assistant-chat";
import { BookingFlow } from "@/features/booking/booking-flow";
import { TrackingChoice, TrackingPixels } from "@/features/booking/tracking-pixels";
import { publicTracking } from "@/server/embed-tracking";
import { BookingShell } from "@/features/booking/booking-shell";
import { BookingEmbedBridge } from "@/features/booking/booking-embed-bridge";
import { profileWords } from "@/lib/terminology";
import { listTimetable } from "@/server/classes";
import { getPublicClinicCatalog } from "@/server/public-catalog";
import { getRoutingPrefill } from "@/server/routing-forms/trace";
import { turnstileSiteKey } from "@/server/turnstile";

import { readBookingOrigin, readEmbedBridge, readLinkParams } from "./booking-query";
import { unavailablePage } from "@/features/booking/unavailable-page";

// Share metadata/page reads within this render only; availability stays live.
const getBookingCatalog = cache((slug: string) => getPublicClinicCatalog(slug));

interface BookingPageProps {
  params: Promise<{ clinicSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: BookingPageProps): Promise<Metadata> {
  const { clinicSlug } = await params;
  const catalog = await getBookingCatalog(clinicSlug);
  if (!catalog) return { title: "Booking page unavailable", robots: { index: false, follow: false } };

  return {
    title: `Book with ${catalog.clinic.name}`,
    description: `Choose a service and available ${profileWords(catalog.profile).appointment} time at ${catalog.clinic.name}.`,
    // The booking flow is steps, not a page to find: the business page at /b/<name> is what search engines list.
    robots: { index: false, follow: false },
  };
}

export default async function BookingPage({ params, searchParams }: BookingPageProps) {
  const { clinicSlug } = await params;
  const catalog = await getBookingCatalog(clinicSlug);
  if (!catalog) return unavailablePage(clinicSlug);

  const query = await searchParams;
  // A customer sent here by a routing form (feature 46): the service, the people and the shared answers come from the server's own row.
  const routingToken = typeof query.routing === "string" ? query.routing : null;
  const routed = routingToken && !catalog.preview ? await getRoutingPrefill(catalog.clinic.id, routingToken) : null;
  const bridge = readEmbedBridge(query);
  const origin = readBookingOrigin(query, bridge);
  const tracking = catalog.preview ? null : await publicTracking(catalog.clinic.id);

  // A small link to the class timetable, only when the business has classes coming up. Any failure hides it.
  let hasClasses = false;
  try {
    hasClasses = (await listTimetable({ clinicSlug })).length > 0;
  } catch {
    hasClasses = false;
  }

  return (
    <>
      {tracking ? <TrackingPixels clinicSlug={catalog.clinic.slug} clinicName={catalog.clinic.name} settings={tracking} /> : null}
      {bridge ? (
        <BookingEmbedBridge nonce={bridge.nonce} parentOrigin={bridge.parentOrigin} />
      ) : null}
      <BookingShell topBar={false} clinicName={catalog.clinic.name} clinicPhone={catalog.clinic.phone} logoUrl={catalog.clinic.logoUrl} brand={catalog.clinic.brand} embedded={Boolean(bridge)} profile={catalog.profile} footerExtra={tracking ? <TrackingChoice clinicSlug={catalog.clinic.slug} /> : null}>
        {hasClasses ? (
          <p className="mx-auto flex w-full max-w-6xl justify-end px-4 pb-2 text-sm">
            <Link href={`/book/${encodeURIComponent(clinicSlug)}/classes`} className="inline-flex min-h-11 items-center font-medium underline underline-offset-4">Class timetable</Link>
          </p>
        ) : null}
        <BookingFlow
          clinic={catalog.clinic}
          locations={catalog.locations}
          services={catalog.services}
          practitioners={routed ? catalog.practitioners.filter((person) => routed.candidateIds.includes(person.id)) : catalog.practitioners}
          resources={catalog.resources}
          initialSlots={catalog.initialSlots}
          allowDemoFallback={catalog.preview}
          origin={origin}
          initialServiceId={routed ? routed.serviceId : typeof query.service === "string" ? query.service : undefined}
          initialPersonId={typeof query.person === "string" ? query.person : undefined}
          initialDate={typeof query.date === "string" ? query.date : undefined}
          initialTime={typeof query.time === "string" ? query.time : undefined}
          forms={catalog.forms}
          prefill={{ ...(routed?.prefill ?? {}), ...readLinkParams(query) }}
          {...(routed && routingToken ? { linkContext: { kind: "routing" as const, token: routingToken } } : {})}
          turnstileSiteKey={catalog.preview ? null : turnstileSiteKey()}
        />
        {bridge || catalog.preview ? null : <AssistantChat clinicSlug={catalog.clinic.slug} />}
      </BookingShell>
    </>
  );
}
