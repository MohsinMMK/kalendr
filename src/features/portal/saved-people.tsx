"use client";

import Link from "next/link";
import { CalendarCheck2Icon, SearchIcon, Share2Icon, StoreIcon, UserRoundIcon, UsersRoundIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { MenuLinkItem } from "@/components/ui/menu";
import { bookingHref } from "@/lib/business-page";
import type { PortalProvider, SavedPerson } from "@/lib/visit-records";

import { PersonCard, Pill } from "../business/person-card";
import { shareLink } from "../business/share-link";
import { useTerms } from "../terms/business-profile-context";

function formatDay(iso: string, timezone: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: timezone }).format(new Date(iso));
}

function profileHref(person: Pick<SavedPerson, "clinicSlug" | "id">) {
  return `/b/${encodeURIComponent(person.clinicSlug)}/team/${encodeURIComponent(person.id)}`;
}

/**
 * The people a customer has booked with: how often, when last, and one tap to book again or share.
 * With nobody yet, it points to each business's page to find someone.
 */
export function SavedPeopleList({ people, providers, businesses, showBusiness }: {
  people: SavedPerson[];
  providers: readonly PortalProvider[];
  /** The businesses this customer books with, for the Find links. */
  businesses: { slug: string; name: string }[];
  /** Name the business on each row, for customers of more than one. */
  showBusiness: boolean;
}) {
  const t = useTerms();
  const findLinks = businesses.map((business) => (
    <Button key={business.slug} variant="outline" size="sm" render={<Link href={`/b/${encodeURIComponent(business.slug)}`} />}>
      <SearchIcon aria-hidden="true" />
      {businesses.length > 1 ? `Find at ${business.name}` : `Find ${t.aProvider}`}
    </Button>
  ));

  if (people.length === 0) {
    return (
      <Empty className="rounded-xl border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><UsersRoundIcon aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>No {t.providers} here yet</EmptyTitle>
          <EmptyDescription>After your first {t.visit}, the {t.providers} you booked with are kept here, so booking again takes a couple of taps.</EmptyDescription>
        </EmptyHeader>
        {findLinks.length ? <EmptyContent>{findLinks}</EmptyContent> : null}
      </Empty>
    );
  }

  return (
    <section aria-labelledby="saved-people-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="saved-people-heading" className="font-medium text-sm">Your {t.providers}</h2>
        {findLinks.length ? <div className="flex flex-wrap gap-2">{findLinks}</div> : null}
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {people.map((person) => {
          const provider = providers.find((entry) => entry.clinicSlug === person.clinicSlug && entry.id === person.id);
          // Without their details we cannot tell they still take bookings, so the links stay off.
          const bookable = provider?.isActive === true;
          const profile = profileHref(person);
          const business = `/b/${encodeURIComponent(person.clinicSlug)}`;
          const again = person.visits > 0 ? "Book again" : "Book";
          return (
            <li key={person.key} className="min-w-0">
              <PersonCard
                name={person.name}
                role={provider?.role || undefined}
                image={provider?.photoUrl}
                profileHref={bookable ? profile : undefined}
                pills={
                  <>
                    {person.visits > 0 ? (
                      <Pill className="tabular-nums">
                        {person.visits} {person.visits === 1 ? t.visit : t.visits}
                      </Pill>
                    ) : null}
                    {person.nextVisitAt ? <Pill className="tabular-nums">Next {formatDay(person.nextVisitAt, person.timezone)}</Pill> : null}
                    {!bookable ? <Pill className="text-muted-foreground">Not taking bookings</Pill> : null}
                  </>
                }
                line={
                  [person.lastVisitAt ? `Last on ${formatDay(person.lastVisitAt, person.timezone)}` : null, showBusiness ? person.clinicName : null]
                    .filter(Boolean)
                    .join(" · ") || undefined
                }
                menu={
                  <>
                    {bookable ? (
                      <MenuLinkItem render={<Link href={profile} />}>
                        <UserRoundIcon aria-hidden="true" />
                        See profile
                      </MenuLinkItem>
                    ) : null}
                    <MenuLinkItem render={<Link href={business} />}>
                      <StoreIcon aria-hidden="true" />
                      <span className="truncate">See {person.clinicName}</span>
                    </MenuLinkItem>
                  </>
                }
                footer={
                  bookable ? (
                    <>
                      <Button
                        size="sm"
                        render={<Link href={bookingHref(person.clinicSlug, { person: person.id, service: person.lastServiceId ?? undefined })} aria-label={`${again} with ${person.name}`} />}
                      >
                        <CalendarCheck2Icon aria-hidden="true" />
                        {again}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Share ${person.name}`}
                        onClick={() => void shareLink({ title: person.name, text: `${person.name} at ${person.clinicName}`, path: profile })}
                      >
                        <Share2Icon aria-hidden="true" />
                        Share
                      </Button>
                    </>
                  ) : undefined
                }
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
