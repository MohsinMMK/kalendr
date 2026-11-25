import type { Metadata } from "next";
import Link from "next/link";

import { BookingShell } from "@/features/booking/booking-shell";
import { PersonCard } from "@/features/business/person-card";
import { RatingLine } from "@/features/business/ratings";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { bookingHref } from "@/lib/business-page";
import { profileWords } from "@/lib/terminology";
import { loadNextOpenings } from "@/server/business-page";

import { getBusinessCatalog } from "../catalog";
import { unavailablePage } from "@/features/booking/unavailable-page";

interface TeamPageProps {
  params: Promise<{ clinicSlug: string }>;
}

export async function generateMetadata({ params }: TeamPageProps): Promise<Metadata> {
  const { clinicSlug } = await params;
  const catalog = await getBusinessCatalog(clinicSlug);
  if (!catalog) return { title: "Page unavailable", robots: { index: false, follow: false } };
  const t = profileWords(catalog.profile);
  const title = `Our ${t.providers} · ${catalog.clinic.name}`;
  return { title, description: `Everyone at ${catalog.clinic.name}, what they offer and when they are next free.`, alternates: { canonical: `/b/${catalog.clinic.slug}/team` }, openGraph: { type: "website", title, url: `/b/${catalog.clinic.slug}/team` } };
}

/** "Tue 3 Dec, 10:30 am" in the business's own time, so the page needs no script to read right. */
function openingLabel(startsAt: string, timeZone: string, locale: string): string {
  const day = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone }).format(new Date(startsAt));
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(startsAt));
  return `${day}, ${time}`;
}

/** Everyone who takes bookings, each with what they offer and their next free time. */
export default async function TeamPage({ params }: TeamPageProps) {
  const { clinicSlug } = await params;
  const catalog = await getBusinessCatalog(clinicSlug);
  if (!catalog) return unavailablePage(clinicSlug);
  const t = profileWords(catalog.profile);
  const openings = await loadNextOpenings(catalog).catch(() => ({}) as Record<string, string>);
  const timeZone = catalog.locations[0]?.timezone ?? catalog.clinic.timezone;
  const listed = catalog.services.filter((service) => service.visibility !== "hidden");
  const people = catalog.practitioners.filter((person) => person.isActive && catalog.services.some((service) => service.practitionerIds.includes(person.id)));

  return (
    <BookingShell topBar={false} clinicName={catalog.clinic.name} clinicPhone={catalog.clinic.phone} logoUrl={catalog.clinic.logoUrl} brand={catalog.clinic.brand} profile={catalog.profile}>
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <Link href={`/b/${catalog.clinic.slug}`} className="text-muted-foreground text-sm underline-offset-4 hover:underline">{catalog.clinic.name}</Link>
          <h1 className="font-heading font-semibold text-2xl">Our {t.providers}</h1>
          <p className="text-muted-foreground text-sm">Pick someone to see what they offer and book with them.</p>
        </header>
        {people.length === 0 ? (
          <p className="rounded-xl bg-muted/48 px-4 py-8 text-center text-muted-foreground text-sm">No one is taking online bookings right now. Please check back soon.</p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {people.map((person) => {
              const offered = listed.filter((service) => service.practitionerIds.includes(person.id));
              const next = openings[person.id];
              return (
                <li key={person.id}>
                  <PersonCard
                    name={person.name}
                    role={[person.title, person.specialty].filter(Boolean).join(" · ")}
                    image={person.photoUrl}
                    profileHref={`/b/${catalog.clinic.slug}/team/${person.id}`}
                    pills={<RatingLine summary={catalog.ratings?.byPractitioner[person.id]} />}
                    line={next ? `Next free: ${openingLabel(next, timeZone, catalog.clinic.locale)}` : "No free times in the next week"}
                    footer={(
                      <>
                        <Button size="sm" variant="outline" render={<Link href={`/b/${catalog.clinic.slug}/team/${person.id}`} />}>
                          Profile<span className="sr-only"> of {person.name}</span>
                        </Button>
                        <Button size="sm" render={<Link href={bookingHref(catalog.clinic.slug, { person: person.id })} />}>
                          Book<span className="sr-only"> with {person.name}</span>
                        </Button>
                      </>
                    )}
                  >
                    {offered.length > 0 ? (
                      <ul aria-label={`What ${person.name} offers`} className="flex flex-wrap gap-1.5">
                        {offered.slice(0, 4).map((service) => <li key={service.id}><Badge variant="outline" className="rounded-full">{service.name}</Badge></li>)}
                        {offered.length > 4 ? <li><Badge variant="outline" className="rounded-full">+{offered.length - 4} more</Badge></li> : null}
                      </ul>
                    ) : null}
                  </PersonCard>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </BookingShell>
  );
}
