import type { Metadata } from "next";

import { canonicalUrl } from "@/lib/seo";
import { loadDiscoveryState } from "@/server/discovery";
import { publicAppUrl } from "@/server/env";
import { pageMetadata } from "@/server/page-seo";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BookingShell } from "@/features/booking/booking-shell";
import { unavailablePage } from "@/features/booking/unavailable-page";
import { PersonCard } from "@/features/business/person-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { bookingHref } from "@/lib/business-page";
import { profileWords } from "@/lib/terminology";
import { loadPublicTeam } from "@/server/enterprise/teams";
import { loadNextOpenings } from "@/server/business-page";

import { getBusinessCatalog } from "../../catalog";

interface TeamPageProps {
  params: Promise<{ clinicSlug: string; team: string }>;
}

async function load(clinicSlug: string, teamSlug: string) {
  const catalog = await getBusinessCatalog(clinicSlug);
  if (!catalog || catalog.preview) return { catalog, team: null };
  return { catalog, team: await loadPublicTeam(catalog.clinic.id, teamSlug) };
}

export async function generateMetadata({ params }: TeamPageProps): Promise<Metadata> {
  const { clinicSlug, team: teamSlug } = await params;
  const { catalog, team } = await load(clinicSlug, teamSlug);
  if (!catalog || !team) return { title: "Page unavailable", robots: { index: false, follow: false } };
  const state = await loadDiscoveryState(clinicSlug);
  const title = `${team.name} · ${catalog.clinic.name}`;
  const path = `/b/${catalog.clinic.slug}/t/${team.slug}`;
  const canonical = canonicalUrl({ appUrl: publicAppUrl(), customHost: state?.customHost, path });
  return pageMetadata({ title, description: team.description ?? `Book with the ${team.name} team at ${catalog.clinic.name}.`, canonical, indexable: state?.indexable ?? false, siteName: catalog.clinic.name });
}

function openingLabel(startsAt: string, timeZone: string, locale: string): string {
  const day = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone }).format(new Date(startsAt));
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(startsAt));
  return `${day}, ${time}`;
}

/**
 * A team's own page (feature 53): what it offers and, unless the team is private, who is in it. A private team still books, but
 * the people are never sent to this page at all, so nothing in the markup or the page data can name them.
 */
export default async function PublicTeamPage({ params }: TeamPageProps) {
  const { clinicSlug, team: teamSlug } = await params;
  const { catalog, team } = await load(clinicSlug, teamSlug);
  if (!catalog) return unavailablePage(clinicSlug);
  if (!team) notFound();
  const t = profileWords(catalog.profile);
  const inTeam = new Set(team.serviceFromPractitionerIds);
  const services = catalog.services.filter((service) => service.visibility !== "hidden" && service.practitionerIds.some((id) => inTeam.has(id)));
  const people = catalog.practitioners.filter((person) => person.isActive && team.practitionerIds.includes(person.id));
  const openings = people.length ? await loadNextOpenings(catalog).catch(() => ({}) as Record<string, string>) : {};
  const timeZone = catalog.locations[0]?.timezone ?? catalog.clinic.timezone;

  return (
    <BookingShell topBar={false} clinicName={catalog.clinic.name} clinicPhone={catalog.clinic.phone} logoUrl={catalog.clinic.logoUrl} brand={catalog.clinic.brand} profile={catalog.profile}>
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <nav aria-label="Where you are" className="flex flex-wrap gap-x-2 text-muted-foreground text-sm">
            <Link href={`/b/${catalog.clinic.slug}`} className="underline-offset-4 hover:underline">{catalog.clinic.name}</Link>
            {team.parent ? <><span aria-hidden="true">/</span><Link href={`/b/${catalog.clinic.slug}/t/${team.parent.slug}`} className="underline-offset-4 hover:underline">{team.parent.name}</Link></> : null}
          </nav>
          <h1 className="font-heading font-semibold text-2xl">{team.name}</h1>
          {team.description ? <p className="max-w-prose text-muted-foreground text-sm">{team.description}</p> : null}
        </header>

        {team.children.length > 0 ? (
          <section aria-labelledby="sub-teams" className="flex flex-col gap-2">
            <h2 id="sub-teams" className="font-medium text-sm">Within {team.name}</h2>
            <ul className="flex flex-wrap gap-2">
              {team.children.map((child) => <li key={child.slug}><Button size="sm" variant="outline" render={<Link href={`/b/${catalog.clinic.slug}/t/${child.slug}`} />}>{child.name}</Button></li>)}
            </ul>
          </section>
        ) : null}

        <section aria-labelledby="team-services" className="flex flex-col gap-3">
          <h2 id="team-services" className="font-heading font-semibold text-lg">What we offer</h2>
          {services.length === 0 ? (
            <p className="rounded-xl bg-muted/48 px-4 py-6 text-center text-muted-foreground text-sm">Nothing is open for online booking here right now. Please check back soon.</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {services.map((service) => (
                <li key={service.id} className="flex flex-col gap-2 rounded-xl border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{service.name}</p>
                      <p className="text-muted-foreground text-xs">{service.durationMinutes} minutes{service.priceLabel ? ` · ${service.priceLabel}` : ""}</p>
                    </div>
                    <Button size="sm" render={<Link href={bookingHref(catalog.clinic.slug, { service: service.id })} />}>Book<span className="sr-only"> {service.name}</span></Button>
                  </div>
                  {service.description ? <p className="text-muted-foreground text-sm">{service.description}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {team.isPrivate ? (
          <p className="text-muted-foreground text-sm"><Badge variant="outline">Private team</Badge> You can book any of these. We will tell you who you are seeing when you book.</p>
        ) : people.length > 0 ? (
          <section aria-labelledby="team-people" className="flex flex-col gap-3">
            <h2 id="team-people" className="font-heading font-semibold text-lg">Our {t.providers}</h2>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {people.map((person) => {
                const next = (openings as Record<string, string>)[person.id];
                return (
                  <li key={person.id}>
                    <PersonCard
                      name={person.name}
                      role={[person.title, person.specialty].filter(Boolean).join(" · ")}
                      image={person.photoUrl}
                      profileHref={`/b/${catalog.clinic.slug}/team/${person.id}`}
                      line={next ? `Next free: ${openingLabel(next, timeZone, catalog.clinic.locale)}` : "No free times in the next week"}
                      footer={<Button size="sm" render={<Link href={bookingHref(catalog.clinic.slug, { person: person.id })} />}>Book<span className="sr-only"> with {person.name}</span></Button>}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </BookingShell>
  );
}
