"use client";

import Link from "next/link";
import { ArrowLeftIcon, ArrowRightIcon, CalendarCheck2, CalendarX2Icon, EllipsisIcon, LayoutGridIcon, PhoneIcon, Share2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { OptionSelect } from "@/components/form-fields";
import { PersonAvatar } from "@/components/person-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import { Drawer, DrawerClose, DrawerDescription, DrawerFooter, DrawerHeader, DrawerPanel, DrawerPopup, DrawerTitle } from "@/components/ui/drawer";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { Menu, MenuItem, MenuLinkItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { bookingHref, dateKeyIn, firstName, pricePillLabel } from "@/lib/business-page";
import type { Clinic, Location, Practitioner, Service, TimeSlot } from "@/lib/domain";
import type { PublicReview, RatingSummary } from "@/lib/reviews";
import { cn } from "@/lib/utils";

import { formatLongDate, formatShortDate, formatTime, formatTimeZoneName, phoneHref } from "../booking/booking-format";
import { serviceMeta } from "../booking/service-card";
import { SlotPicker } from "../booking/slot-picker";
import { useTerms } from "../terms/business-profile-context";
import { Pill } from "./person-card";
import { RatingPill, ReviewItem, Stars } from "./ratings";
import { shareLink } from "./share-link";

const REVIEWS_PER_PAGE = 10;
/** A longer bio starts folded, with "See more" to open it. */
const LONG_BIO = 220;

/** A free time the customer picked on the profile, with what it is for and where. */
interface PickedTime {
  slot: TimeSlot;
  service: Service;
  location: Location;
}

export interface PersonProfileProps {
  clinic: Clinic;
  person: Practitioner;
  /** The services this person offers. */
  services: Service[];
  locations: Location[];
  rating?: RatingSummary;
  reviews: PublicReview[];
}

export function PersonProfile({ clinic, person, services, locations, rating, reviews }: PersonProfileProps) {
  const t = useTerms();
  const name = firstName(person);
  const role = [person.title, person.specialty].filter(Boolean).join(" · ");
  const price = pricePillLabel(services);
  const home = `/b/${clinic.slug}`;
  const [reviewsShown, setReviewsShown] = useState(REVIEWS_PER_PAGE);
  const [bioOpen, setBioOpen] = useState(false);
  const longBio = (person.bio?.length ?? 0) > LONG_BIO;
  const reviewCount = rating?.count ?? reviews.length;
  // Three numbers at a glance. One alone would look lost, so the panel needs at least two.
  const stats = [
    person.experienceYears ? { label: person.experienceYears === 1 ? "Year of experience" : "Years of experience", value: String(person.experienceYears) } : null,
    reviewCount > 0 ? { label: reviewCount === 1 ? "Review" : "Reviews", value: String(reviewCount) } : null,
    services.length > 0 ? { label: services.length === 1 ? t.Service : t.Services, value: String(services.length) } : null,
  ].filter((stat): stat is { label: string; value: string } => stat !== null);
  const bookLink = bookingHref(clinic.slug, { person: person.id });
  const personLocations = locations.filter((location) => person.locationIds.includes(location.id));
  // Times can be picked here when this person offers a service at a place they work.
  const canPickTime = services.some((service) => personLocations.some((location) => service.locationIds.includes(location.id)));
  const [tab, setTab] = useState("about");
  const [picked, setPicked] = useState<PickedTime | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);

  /** Book: confirm the picked time, or show the free times so one can be picked. */
  function book() {
    if (picked) {
      setConfirmOpen(true);
      return;
    }
    setTab("availability");
    window.requestAnimationFrame(() => {
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      tabsRef.current?.scrollIntoView?.({ block: "start", behavior: reduce ? "auto" : "smooth" });
      tabsRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
    });
  }

  const pickedZone = picked ? picked.location.timezone || clinic.timezone : clinic.timezone;
  const bookLabel = picked ? `Book ${formatShortDate(picked.slot.startsAt, clinic.locale, pickedZone)}, ${formatTime(picked.slot.startsAt, clinic.locale, pickedZone)}` : `Book with ${name}`;
  const bookButton = (className: string) =>
    canPickTime ? (
      <Button size="lg" className={className} onClick={book}>
        <CalendarCheck2 aria-hidden="true" />
        {bookLabel}
      </Button>
    ) : (
      <Button size="lg" className={className} render={<Link href={bookLink} />}>
        <CalendarCheck2 aria-hidden="true" />
        {bookLabel}
      </Button>
    );

  return (
    <div className="flex flex-col gap-6 pb-20 md:pb-0">
      <div className="flex items-center gap-3">
        <Button aria-label={`Back to ${clinic.name}`} size="icon" variant="outline" className="shrink-0 rounded-full" render={<Link href={home} />}>
          <ArrowLeftIcon aria-hidden="true" />
        </Button>
        <p className="min-w-0 flex-1 truncate font-medium text-sm">{clinic.name}</p>
        <Menu>
          <MenuTrigger render={<Button aria-label="More options" size="icon" variant="ghost" className="-me-2 shrink-0" />}>
            <EllipsisIcon aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => void shareLink({ title: person.name, text: `${person.name} at ${clinic.name}`, path: `${home}/team/${person.id}` })}>
              <Share2Icon aria-hidden="true" />
              Share profile
            </MenuItem>
            {clinic.phone ? (
              <MenuLinkItem render={<a href={phoneHref(clinic.phone)} />}>
                <PhoneIcon aria-hidden="true" />
                Call {clinic.name}
              </MenuLinkItem>
            ) : null}
            <MenuSeparator />
            <MenuLinkItem render={<Link href={home} />}>
              <LayoutGridIcon aria-hidden="true" />
              See everything at {clinic.name}
            </MenuLinkItem>
          </MenuPopup>
        </Menu>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {(rating && rating.count > 0) || price ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <RatingPill summary={rating} />
              {price ? <Pill>{price}</Pill> : null}
            </div>
          ) : null}
          <div className="flex flex-col gap-0.5">
            <h1 className="break-words font-heading font-semibold text-2xl leading-tight">{person.name}</h1>
            {role ? <p className="break-words text-muted-foreground text-sm">{role}</p> : null}
          </div>
          {bookButton("mt-1 self-start max-md:hidden")}
        </div>
        <PersonAvatar name={person.name} image={person.photoUrl} className="size-20 text-xl md:size-28 md:text-2xl" />
      </div>

      {stats.length > 1 ? (
        <Card>
          <CardPanel className="p-0">
            <dl className="flex divide-x">
              {stats.map((stat) => (
                <div key={stat.label} className="flex min-w-0 flex-1 flex-col-reverse items-center gap-0.5 px-2 py-3 text-center">
                  <dt className="text-muted-foreground text-xs">{stat.label}</dt>
                  <dd className="font-heading font-semibold text-xl tabular-nums">{stat.value}</dd>
                </div>
              ))}
            </dl>
          </CardPanel>
        </Card>
      ) : null}

      <Tabs ref={tabsRef} value={tab} onValueChange={(value) => setTab(String(value))} className="scroll-mt-4">
        <TabsList variant="underline" className="w-full" aria-label={`About ${person.name}`}>
          <TabsTab value="about">About</TabsTab>
          <TabsTab value="reviews">Reviews</TabsTab>
          <TabsTab value="availability">Availability</TabsTab>
        </TabsList>

        <TabsPanel value="about" className="flex flex-col gap-5 pt-4">
          {person.bio ? (
            <div className="flex flex-col items-start gap-1">
              <p id="profile-bio" className={cn("whitespace-pre-line text-sm", longBio && !bioOpen && "line-clamp-4")}>{person.bio}</p>
              {longBio ? (
                <Button variant="link" size="sm" className="h-auto p-0 sm:h-auto" aria-expanded={bioOpen} aria-controls="profile-bio" onClick={() => setBioOpen((open) => !open)}>
                  {bioOpen ? "See less" : "See more"}
                </Button>
              ) : null}
            </div>
          ) : null}
          {person.qualifications ? (
            <div className="flex flex-col gap-1">
              <h2 className="font-medium text-sm">Qualifications</h2>
              <p className="text-muted-foreground text-sm">{person.qualifications}</p>
            </div>
          ) : null}
          {person.languages ? (
            <div className="flex flex-col gap-1">
              <h2 className="font-medium text-sm">Languages</h2>
              <p className="text-muted-foreground text-sm">{person.languages}</p>
            </div>
          ) : null}
          {services.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h2 className="font-medium text-sm">{t.Services}</h2>
              <ul className="grid gap-2 md:grid-cols-2">
                {services.map((service) => (
                  <li key={service.id}>
                    <Link
                      href={bookingHref(clinic.slug, { service: service.id, person: person.id })}
                      className="flex min-w-0 flex-col gap-0.5 rounded-xl border bg-card p-3.5 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="font-medium text-sm">{service.name}</span>
                      <span className="text-muted-foreground text-sm tabular-nums">{serviceMeta(service)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {personLocations.length > 0 ? (
            <div className="flex flex-col gap-1">
              <h2 className="font-medium text-sm">{personLocations.length > 1 ? t.Locations : t.Location}</h2>
              <ul className="flex flex-col gap-1 text-muted-foreground text-sm">
                {personLocations.map((location) => (
                  <li key={location.id}>{[location.name, location.address, location.city].filter(Boolean).join(", ")}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {!person.bio && !person.qualifications && services.length === 0 ? (
            <p className="text-muted-foreground text-sm">{name} hasn&apos;t added a profile yet.</p>
          ) : null}
        </TabsPanel>

        <TabsPanel value="reviews" className="flex flex-col gap-3 pt-4">
          {reviews.length > 0 ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 font-medium text-sm">
                  Reviews and ratings
                  <Badge variant="secondary" className="tabular-nums">{reviewCount}</Badge>
                </h2>
                {rating && rating.average !== null ? (
                  <p className="flex items-center gap-2">
                    <span className="font-heading font-semibold text-2xl tabular-nums" aria-hidden="true">{rating.average.toFixed(1)}</span>
                    <Stars rating={Number(rating.average.toFixed(1))} />
                  </p>
                ) : null}
              </div>
              <Card>
                <CardPanel className="divide-y p-4 sm:p-6">
                  {reviews.slice(0, reviewsShown).map((review) => (
                    <ReviewItem key={review.id} review={review} locale={clinic.locale} services={services} practitioners={[]} showPerson={false} />
                  ))}
                </CardPanel>
              </Card>
              {reviews.length > reviewsShown ? (
                <Button variant="outline" className="self-start" onClick={() => setReviewsShown((count) => count + REVIEWS_PER_PAGE)}>
                  Show more reviews
                </Button>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground text-sm">No reviews yet. Reviews come from {t.customers} after their {t.appointment}.</p>
          )}
        </TabsPanel>

        <TabsPanel value="availability" className="pt-4">
          <Availability
            clinic={clinic}
            person={person}
            services={services}
            locations={personLocations}
            pickedSlotId={picked?.slot.id}
            onPick={(next) => {
              setPicked(next);
              if (next) setConfirmOpen(true);
            }}
          />
        </TabsPanel>
      </Tabs>

      <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-background/95 px-3 pt-3 pb-[max(--spacing(3),env(safe-area-inset-bottom))] backdrop-blur md:hidden">
        {bookButton("w-full")}
      </div>

      <Drawer open={confirmOpen && picked !== null} onOpenChange={setConfirmOpen}>
        <DrawerPopup showBar showCloseButton>
          <DrawerHeader>
            <DrawerTitle>Confirm booking?</DrawerTitle>
            <DrawerDescription>Next you&apos;ll add your name and how to reach you.</DrawerDescription>
          </DrawerHeader>
          {picked ? (
            <DrawerPanel>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                <dt className="text-muted-foreground">With</dt>
                <dd className="break-words font-medium">{person.name}</dd>
                <dt className="text-muted-foreground">{t.Service}</dt>
                <dd className="break-words font-medium">
                  {picked.service.name}
                  <span className="block font-normal text-muted-foreground text-xs tabular-nums">{serviceMeta(picked.service)}</span>
                </dd>
                <dt className="text-muted-foreground">When</dt>
                <dd className="font-medium tabular-nums">
                  {formatLongDate(picked.slot.startsAt, clinic.locale, pickedZone)}, {formatTime(picked.slot.startsAt, clinic.locale, pickedZone)}
                  <span className="block font-normal text-muted-foreground text-xs">{formatTimeZoneName(pickedZone, clinic.locale)}</span>
                </dd>
                <dt className="text-muted-foreground">{t.Location}</dt>
                <dd className="break-words font-medium">{[picked.location.name, picked.location.address].filter(Boolean).join(", ")}</dd>
              </dl>
            </DrawerPanel>
          ) : null}
          <DrawerFooter>
            <DrawerClose render={<Button variant="outline" />}>Pick another time</DrawerClose>
            {picked ? (
              <Button
                render={
                  <Link
                    href={bookingHref(clinic.slug, {
                      service: picked.service.id,
                      person: person.id,
                      date: dateKeyIn(picked.slot.startsAt, pickedZone),
                      time: picked.slot.startsAt,
                    })}
                  />
                }
              >
                Continue booking
                <ArrowRightIcon aria-hidden="true" />
              </Button>
            ) : null}
          </DrawerFooter>
        </DrawerPopup>
      </Drawer>
    </div>
  );
}

/** Free times for one service with this person. Picking a time asks the customer to confirm it. */
function Availability({
  clinic,
  person,
  services,
  locations,
  pickedSlotId,
  onPick,
}: {
  clinic: Clinic;
  person: Practitioner;
  services: Service[];
  locations: Location[];
  pickedSlotId?: string;
  /** A picked time, or null when the pick no longer holds (another service was chosen). */
  onPick: (picked: PickedTime | null) => void;
}) {
  const t = useTerms();
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const service = services.find((entry) => entry.id === serviceId);
  const location = locations.find((entry) => service?.locationIds.includes(entry.id));
  const [state, setState] = useState<{ key: string; slots: TimeSlot[]; failed: boolean } | null>(null);
  const requestKey = service && location ? `${service.id}:${location.id}` : "";

  useEffect(() => {
    if (!requestKey || !service || !location) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ clinicSlug: clinic.slug, locationId: location.id, serviceId: service.id, practitionerId: person.id });
    fetch(`/api/public/availability?${query}`, { signal: controller.signal, headers: { Accept: "application/json" } })
      .then(async (response) => {
        const payload = (await response.json().catch(() => undefined)) as { data?: { slots?: TimeSlot[] } } | undefined;
        if (!response.ok || !Array.isArray(payload?.data?.slots)) throw new Error("unavailable");
        setState({ key: requestKey, slots: payload.data.slots, failed: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ key: requestKey, slots: [], failed: true });
      });
    return () => controller.abort();
  }, [clinic.slug, location, person.id, requestKey, service]);

  if (services.length === 0 || !location) {
    return <p className="text-muted-foreground text-sm">Online booking isn&apos;t open with {firstName(person)} yet.</p>;
  }

  const loading = state?.key !== requestKey;
  const timeZone = location.timezone || clinic.timezone;

  return (
    <div className="flex flex-col gap-4">
      {services.length > 1 ? (
        <div className="flex max-w-sm flex-col gap-2">
          <Label htmlFor="profile-service">{t.Service}</Label>
          <OptionSelect
            id="profile-service"
            value={serviceId}
            onValueChange={(next) => {
              setServiceId(next);
              onPick(null);
            }}
            options={services.map((entry) => ({ value: entry.id, label: entry.name }))}
          />
        </div>
      ) : null}
      {loading ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading free times">
          <Skeleton className="h-10 w-full max-w-md" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : state?.failed ? (
        <p className="text-muted-foreground text-sm" role="status">Free times couldn&apos;t be loaded. You can still book and choose a time there.</p>
      ) : state && state.slots.length === 0 ? (
        <Empty className="rounded-xl border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarX2Icon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No free times soon</EmptyTitle>
            <EmptyDescription>Try another {t.service}, or book with anyone free.</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" render={<Link href={bookingHref(clinic.slug, { service: serviceId })} />}>Book with anyone</Button>
        </Empty>
      ) : state ? (
        <SlotPicker
          id="profile-slots"
          name="profile-slot"
          slots={state.slots}
          practitioners={[person]}
          selectedSlotId={pickedSlotId}
          onSelect={(slot) => {
            if (service) onPick({ slot, service, location });
          }}
          locale={clinic.locale}
          timeZone={timeZone}
        />
      ) : null}
    </div>
  );
}
