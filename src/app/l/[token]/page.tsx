import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readBookingOrigin, readLinkParams } from "@/app/book/[clinicSlug]/booking-query";
import { BookingFlow } from "@/features/booking/booking-flow";
import { BookingShell } from "@/features/booking/booking-shell";
import { SpecialLinkUnavailable } from "@/features/booking/special-link-unavailable";
import { unavailablePage } from "@/features/booking/unavailable-page";
import { resolveBusinessProfile } from "@/lib/terminology";
import { getPublicClinicCatalog } from "@/server/public-catalog";
import { resolvePublicSpecialLink } from "@/server/special-links";
import { turnstileSiteKey } from "@/server/turnstile";

interface SpecialLinkPageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** A private link: never indexed, and the address (which holds the token) is not passed on to other sites. */
export const metadata: Metadata = {
  title: "Book your visit",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function SpecialLinkPage({ params, searchParams }: SpecialLinkPageProps) {
  const { token } = await params;
  const resolved = await resolvePublicSpecialLink(token);
  if (resolved.state === "unknown") notFound();

  if (resolved.state === "unavailable") {
    const catalog = await getPublicClinicCatalog(resolved.clinicSlug);
    if (!catalog) return unavailablePage(resolved.clinicSlug);
    return <SpecialLinkUnavailable clinicName={catalog.clinic.name} phone={catalog.clinic.phone} logoUrl={catalog.clinic.logoUrl} profile={catalog.profile} />;
  }

  const catalog = await getPublicClinicCatalog(resolved.clinicSlug, { includeHiddenSlug: resolved.serviceSlug });
  if (!catalog) return unavailablePage(resolved.clinicSlug);
  const service = catalog.services.find((entry) => entry.id === resolved.serviceId && entry.isActive !== false);
  if (!service) return <SpecialLinkUnavailable clinicName={catalog.clinic.name} phone={catalog.clinic.phone} logoUrl={catalog.clinic.logoUrl} profile={catalog.profile ?? resolveBusinessProfile({ businessType: "other" })} />;

  const query = await searchParams;
  return (
    <BookingShell topBar={false} clinicName={catalog.clinic.name} clinicPhone={catalog.clinic.phone} logoUrl={catalog.clinic.logoUrl} profile={catalog.profile}>
      <BookingFlow
        clinic={catalog.clinic}
        locations={catalog.locations}
        services={[service]}
        practitioners={catalog.practitioners.filter((person) => service.practitionerIds.includes(person.id))}
        resources={catalog.resources}
        initialSlots={[]}
        allowDemoFallback={catalog.preview}
        origin={readBookingOrigin(query, null)}
        initialServiceId={service.id}
        forms={catalog.forms}
        prefill={readLinkParams(query)}
        turnstileSiteKey={catalog.preview ? null : turnstileSiteKey()}
        linkContext={{ kind: "special", token: resolved.token }}
      />
    </BookingShell>
  );
}
