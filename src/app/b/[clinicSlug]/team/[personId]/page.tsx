import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BookingShell } from "@/features/booking/booking-shell";
import { PersonProfile } from "@/features/business/person-profile";
import type { ClinicCatalog } from "@/lib/staff-snapshot";
import { loadLatestReviews } from "@/server/business-page";
import { canonicalFor, loadDiscoveryState } from "@/server/discovery";
import { pageMetadata } from "@/server/page-seo";

import { getBusinessCatalog } from "../../catalog";
import { unavailablePage } from "@/features/booking/unavailable-page";

interface PersonPageProps {
  params: Promise<{ clinicSlug: string; personId: string }>;
}

function findPerson(catalog: ClinicCatalog, personId: string) {
  return catalog.practitioners.find((person) => person.id === personId);
}

export async function generateMetadata({ params }: PersonPageProps): Promise<Metadata> {
  const { clinicSlug, personId } = await params;
  const catalog = await getBusinessCatalog(clinicSlug);
  const person = catalog ? findPerson(catalog, personId) : undefined;
  if (!catalog || !person) return { title: "Page unavailable", robots: { index: false, follow: false } };

  const state = await loadDiscoveryState(clinicSlug);
  const role = [person.title, person.specialty].filter(Boolean).join(", ");
  const city = catalog.locations.find((location) => location.isActive !== false)?.city;
  const description = person.bio?.slice(0, 160) ?? `${person.name}${role ? `, ${role}` : ""} at ${catalog.clinic.name}. See reviews and free times, and book online.`;
  return pageMetadata({
    title: `${person.name}${person.specialty ? `, ${person.specialty}` : ""} · ${catalog.clinic.name}${city ? `, ${city}` : ""}`,
    description,
    canonical: canonicalFor(state, "person", catalog.clinic.slug, person.id),
    indexable: state?.indexable ?? false,
    type: "profile",
    siteName: catalog.clinic.name,
    image: person.photoUrl ?? null,
  });
}

export default async function PersonPage({ params }: PersonPageProps) {
  const { clinicSlug, personId } = await params;
  const catalog = await getBusinessCatalog(clinicSlug);
  if (!catalog) return unavailablePage(clinicSlug);
  const person = findPerson(catalog, personId);
  if (!person) notFound();

  const reviews = await loadLatestReviews(catalog, { practitionerId: person.id, limit: 50 });
  const services = catalog.services.filter((service) => service.practitionerIds.includes(person.id));

  return (
    <BookingShell topBar={false} clinicName={catalog.clinic.name} clinicPhone={catalog.clinic.phone} logoUrl={catalog.clinic.logoUrl} brand={catalog.clinic.brand} profile={catalog.profile}>
      <PersonProfile
        clinic={catalog.clinic}
        person={person}
        services={services}
        locations={catalog.locations}
        rating={catalog.ratings?.byPractitioner[person.id]}
        reviews={reviews}
      />
    </BookingShell>
  );
}
