import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BookingFlow } from "@/features/booking/booking-flow";
import { BookingShell } from "@/features/booking/booking-shell";
import { unavailablePage } from "@/features/booking/unavailable-page";
import { getPublicClinicCatalog } from "@/server/public-catalog";
import { resolvePublicCombinedLink } from "@/server/special-links";
import { turnstileSiteKey } from "@/server/turnstile";

import { readBookingOrigin, readLinkParams } from "@/app/book/[clinicSlug]/booking-query";

interface CombinedPageProps {
  params: Promise<{ clinicSlug: string; combo: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export const metadata: Metadata = { title: "Book together", robots: { index: false, follow: false } };

/** Books two to four people for the same time. Only times when all of them are free are offered. */
export default async function CombinedBookingPage({ params, searchParams }: CombinedPageProps) {
  const { clinicSlug, combo } = await params;
  const link = await resolvePublicCombinedLink(clinicSlug, combo);
  if (!link) notFound();
  const catalog = await getPublicClinicCatalog(link.clinicSlug, { includeHiddenSlug: link.serviceSlug });
  if (!catalog) return unavailablePage(clinicSlug);
  const service = catalog.services.find((entry) => entry.id === link.serviceId && entry.isActive !== false);
  const people = link.practitionerIds.map((id) => catalog.practitioners.find((person) => person.id === id));
  const first = people[0];
  if (!service || !first || people.some((person) => !person)) notFound();

  // The customer sees one booking "with" the whole group: a single person entry stands for all of them, so no one is picked separately.
  const group = { ...first, name: people.flatMap((person) => (person ? [person.name] : [])).join(" and "), initials: "+" };
  const query = await searchParams;
  return (
    <BookingShell topBar={false} clinicName={catalog.clinic.name} clinicPhone={catalog.clinic.phone} logoUrl={catalog.clinic.logoUrl} profile={catalog.profile}>
      <BookingFlow
        clinic={catalog.clinic}
        locations={catalog.locations}
        services={[{ ...service, practitionerIds: [first.id] }]}
        practitioners={[group]}
        resources={catalog.resources}
        initialSlots={[]}
        allowDemoFallback={catalog.preview}
        origin={readBookingOrigin(query, null)}
        initialServiceId={service.id}
        forms={catalog.forms}
        prefill={readLinkParams(query)}
        turnstileSiteKey={catalog.preview ? null : turnstileSiteKey()}
        linkContext={{ kind: "combined", slug: combo }}
      />
    </BookingShell>
  );
}
