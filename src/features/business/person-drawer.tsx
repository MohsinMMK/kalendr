"use client";

import Link from "next/link";
import { CalendarPlusIcon, ChevronRightIcon } from "lucide-react";

import { PersonAvatar } from "@/components/person-avatar";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerPanel,
  DrawerPopup,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useMediaQuery } from "@/hooks/use-media-query";
import { bookingHref } from "@/lib/business-page";
import type { Practitioner, Service } from "@/lib/domain";
import type { RatingSummary } from "@/lib/reviews";

import { serviceMeta } from "../booking/booking-options";
import { hasProfile, ProfileDetails } from "../booking/person-tile";
import { useTerms } from "../terms/business-profile-context";
import { DayStrip } from "./person-card";
import { RatingLine } from "./ratings";

/**
 * A team member's details without leaving the page: who they are, what they offer and their next
 * free days, each one tap from the booking. Opens from the right on a wide screen and from the
 * bottom on a phone.
 */
export function PersonDrawer({
  open,
  onOpenChange,
  person,
  slug,
  locale,
  rating,
  services,
  days,
  todayKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  person: Practitioner;
  slug: string;
  locale: string;
  rating: RatingSummary | undefined;
  /** Every active service; the drawer lists the ones this person offers. */
  services: Service[];
  days: string[];
  todayKey: string;
}) {
  const t = useTerms();
  const phone = useMediaQuery("max-sm");
  const role = [person.title, person.specialty].filter(Boolean).join(" · ");
  const offered = services.filter((service) => service.isActive !== false && service.practitionerIds.includes(person.id));
  const firstName = person.name.replace(/^(dr\.?|mr\.?|mrs\.?|ms\.?)\s+/i, "").split(/\s+/)[0] || person.name;
  return (
    <Drawer open={open} onOpenChange={onOpenChange} position={phone ? "bottom" : "right"}>
      <DrawerPopup showBar={phone} showCloseButton={!phone} variant={phone ? "default" : "inset"}>
        <DrawerHeader className="items-center text-center">
          <PersonAvatar name={person.name} image={person.photoUrl} className="size-24 text-2xl shadow-sm ring-4 ring-background outline outline-border/64" />
          <div className="flex flex-col items-center gap-1 pt-1">
            <DrawerTitle className="font-heading text-xl">{person.name}</DrawerTitle>
            {role ? <DrawerDescription>{role}</DrawerDescription> : null}
            <RatingLine summary={rating} />
          </div>
        </DrawerHeader>
        <DrawerPanel className="flex flex-col gap-6">
          {days.length > 0 ? (
            <section className="flex flex-col gap-2" aria-labelledby={`free-${person.id}`}>
              <h3 id={`free-${person.id}`} className="font-medium text-sm">Next free days</h3>
              <DayStrip
                days={days.map((key) => ({ key, href: bookingHref(slug, { person: person.id, date: key }) }))}
                todayKey={todayKey}
                locale={locale}
                label={`Next free days with ${person.name}`}
              />
            </section>
          ) : null}
          {hasProfile(person) ? (
            <section className="flex flex-col gap-2" aria-labelledby={`about-${person.id}`}>
              <h3 id={`about-${person.id}`} className="font-medium text-sm">About</h3>
              <ProfileDetails person={person} />
            </section>
          ) : null}
          {offered.length > 0 ? (
            <section className="flex flex-col gap-2" aria-labelledby={`offers-${person.id}`}>
              <h3 id={`offers-${person.id}`} className="font-medium text-sm">{t.Services}</h3>
              <ul className="-mx-2 flex flex-col">
                {offered.map((service) => (
                  <li key={service.id}>
                    <Link
                      href={bookingHref(slug, { service: service.id, person: person.id })}
                      className="flex items-center gap-3 rounded-lg px-2 py-2.5 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium text-sm">{service.name}</span>
                        <span className="text-muted-foreground text-xs tabular-nums">{serviceMeta(service)}</span>
                      </span>
                      <span className="sr-only">, book with {person.name}</span>
                      <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </DrawerPanel>
        <DrawerFooter className="grid grid-cols-2 gap-2">
          <Button variant="outline" render={<Link href={`/b/${slug}/team/${person.id}`} />}>
            Full profile
          </Button>
          <Button render={<Link href={bookingHref(slug, { person: person.id })} />}>
            <CalendarPlusIcon aria-hidden="true" />
            Book with {firstName}
          </Button>
        </DrawerFooter>
      </DrawerPopup>
    </Drawer>
  );
}
