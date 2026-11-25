"use client";

import Image from "next/image";
import Link from "next/link";
import {
  AccessibilityIcon,
  CalendarCheck2,
  CalendarPlusIcon,
  ChevronRightIcon,
  ListChecksIcon,
  MapPinIcon,
  PhoneIcon,
  Share2Icon,
  UserRoundIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import { MenuItem, MenuLinkItem } from "@/components/ui/menu";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  bookingHref,
  mapHref,
  serviceCategories,
  sortByPopularity,
  TEAM_SHOWN,
  type WeekHours,
} from "@/lib/business-page";
import type { Clinic, Location, Practitioner, Service } from "@/lib/domain";
import type { PublicReview, RatingSummaries } from "@/lib/reviews";
import { cn } from "@/lib/utils";

import { getInitials } from "../booking/booking-shell";
import { phoneHref } from "../booking/booking-format";
import { serviceMeta } from "../booking/service-card";
import { useTerms } from "../terms/business-profile-context";
import { HoursButton } from "./hours-drawer";
import { DayStrip, PersonCard } from "./person-card";
import { PersonDrawer } from "./person-drawer";
import { RatingLine, ReviewItem } from "./ratings";
import { shareLink } from "./share-link";
import { TeamDrawer } from "./team-drawer";

const ALL = "all";
const REVIEWS_SHOWN = 3;

export interface BusinessPageProps {
  clinic: Clinic;
  locations: Location[];
  services: Service[];
  practitioners: Practitioner[];
  ratings?: RatingSummaries;
  hours: Record<string, WeekHours>;
  freeDays: Record<string, string[]>;
  reviews: PublicReview[];
  /** The business's "Help me choose" questions, when it has switched them on. */
  guide?: { title: string; intro: string } | null;
  /** The business's "YYYY-MM-DD" today, worked out on the server so both renders agree. */
  todayKey: string;
  /** Monday-first index of today at the business. */
  todayIndex: number;
}

export function BusinessPage({ clinic, locations, services, practitioners, ratings, hours, freeDays, reviews, guide, todayKey, todayIndex }: BusinessPageProps) {
  const t = useTerms();
  const [category, setCategory] = useState<string>(ALL);
  const [showAllReviews, setShowAllReviews] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const categories = useMemo(() => serviceCategories(services), [services]);

  const shownServices = services.filter((service) => category === ALL || service.category === category);
  const popularPeople = useMemo(() => sortByPopularity(practitioners, ratings?.byPractitioner), [practitioners, ratings]);
  const shownPeople = popularPeople.slice(0, TEAM_SHOWN);
  const pictureLayout = services.some((service) => service.imageUrl);
  // A new business may not have an address yet: show no empty pin or empty "Location" box.
  const placedLocations = locations.filter((location) => location.address || location.city);
  const aboutLocations = locations.filter((location) => location.address || location.city || location.accessibleEntrance);
  const firstLocation = placedLocations[0];
  const visibleReviews = showAllReviews ? reviews : reviews.slice(0, REVIEWS_SHOWN);

  return (
    <div
      className={cn(
        "flex flex-col gap-8",
        // The page settles in calmly, one block after another. Plain CSS, so it plays before the page is interactive
        // and stays still for people who ask for less motion.
        "*:motion-safe:fade-in-0 *:motion-safe:slide-in-from-bottom-2 *:motion-safe:animate-in *:motion-safe:fill-mode-both *:motion-safe:duration-700 *:motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]",
        "[&>*:nth-child(2)]:delay-90 [&>*:nth-child(3)]:delay-180 [&>*:nth-child(4)]:delay-270 [&>*:nth-child(5)]:delay-360 [&>*:nth-child(n+6)]:delay-450",
      )}
    >
      <Card className="overflow-hidden">
        {clinic.coverUrl ? (
          // The cover leads the page like a profile header, and settles in with a slow, slight zoom.
          <div className="relative aspect-[5/2] w-full overflow-hidden bg-accent sm:aspect-[3/1] lg:aspect-[7/2]">
            <Image
              src={clinic.coverUrl}
              alt=""
              fill
              unoptimized
              priority
              sizes="(min-width: 1152px) 1152px, 100vw"
              className="object-cover motion-safe:zoom-in-105 motion-safe:animate-in motion-safe:duration-1400 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]"
            />
          </div>
        ) : null}
        <CardPanel className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className={cn("flex min-w-0 items-start gap-4", clinic.coverUrl && "max-sm:flex-col max-sm:gap-3")}>
            {/* Over a cover, the logo sits on its bottom edge, the way a profile picture does. */}
            <Avatar
              className={cn(
                "size-16 shrink-0 rounded-xl text-lg",
                clinic.coverUrl && "relative z-10 -mt-12 size-20 bg-card shadow-md ring-4 ring-card sm:-mt-14 sm:size-24",
              )}
              aria-hidden="true"
            >
              {clinic.logoUrl ? <AvatarImage src={clinic.logoUrl} alt="" className="object-cover" /> : null}
              <AvatarFallback className="rounded-xl">{getInitials(clinic.name)}</AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-col gap-1.5">
              <h1 className="font-heading font-semibold text-2xl leading-tight">{clinic.name}</h1>
              <RatingLine summary={ratings?.business} />
              {firstLocation ? (
                <a
                  href={mapHref(firstLocation, clinic.name)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-w-0 items-start gap-1.5 text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
                >
                  <MapPinIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0">
                    {[firstLocation.address, firstLocation.city].filter(Boolean).join(", ")}
                    {locations.length > 1 ? ` (+${locations.length - 1} more)` : ""}
                    <span className="sr-only"> (opens a map in a new tab)</span>
                  </span>
                </a>
              ) : null}
              <HoursButton clinic={clinic} locations={locations} hours={hours} todayIndex={todayIndex} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 md:flex md:shrink-0">
            <Button size="lg" className={clinic.phone ? undefined : "col-span-2"} render={<Link href={bookingHref(clinic.slug)} />}>
              <CalendarCheck2 aria-hidden="true" />
              Book now
            </Button>
            {clinic.phone ? (
              <Button size="lg" variant="outline" render={<a href={phoneHref(clinic.phone)} />}>
                <PhoneIcon aria-hidden="true" />
                Call
              </Button>
            ) : null}
          </div>
        </CardPanel>
      </Card>

      {guide ? (
        <Card>
          <CardPanel className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                <ListChecksIcon aria-hidden="true" className="size-5" />
              </span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <h2 className="break-words font-medium">{guide.title}</h2>
                <p className="break-words text-muted-foreground text-sm">
                  {guide.intro || `Answer a few questions and we'll show the ${t.providers} and ${t.services} that fit.`}
                </p>
              </div>
            </div>
            <Button variant="outline" className="shrink-0" render={<Link href={`/b/${clinic.slug}/find`} />}>
              Answer a few questions
            </Button>
          </CardPanel>
        </Card>
      ) : null}

      {shownPeople.length > 0 ? (
        <section aria-labelledby="team-heading" className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 id="team-heading" className="font-heading font-semibold text-lg">{t.Providers}</h2>
            {popularPeople.length > TEAM_SHOWN ? (
              <>
                <Button variant="link" size="sm" onClick={() => setTeamOpen(true)} aria-haspopup="dialog">
                  See all
                  <span className="sr-only"> {t.providers}</span>
                </Button>
                <TeamDrawer
                  open={teamOpen}
                  onOpenChange={setTeamOpen}
                  people={popularPeople}
                  slug={clinic.slug}
                  locale={clinic.locale}
                  ratings={ratings}
                  services={services}
                  freeDays={freeDays}
                  todayKey={todayKey}
                />
              </>
            ) : null}
          </div>
          <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {shownPeople.map((person) => (
              <li key={person.id} className="min-w-0">
                <TeamCard
                  person={person}
                  slug={clinic.slug}
                  locale={clinic.locale}
                  rating={ratings?.byPractitioner[person.id]}
                  services={services}
                  days={freeDays[person.id] ?? []}
                  todayKey={todayKey}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {services.length > 0 ? (
        <section aria-labelledby="services-heading" className="flex w-full min-w-0 flex-col gap-3">
          <h2 id="services-heading" className="font-heading font-semibold text-lg">{t.Services}</h2>
          {categories.length > 0 ? (
            <div className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <ToggleGroup
                aria-label={`Filter ${t.services}`}
                value={[category]}
                onValueChange={(value) => setCategory(value[0] ?? ALL)}
                variant="outline"
                className="w-max flex-nowrap gap-2 *:rounded-full! *:border-s! *:before:rounded-full!"
              >
                {[ALL, ...categories].map((item) => (
                  <ToggleGroupItem key={item} value={item} size="sm" className="shrink-0">
                    {item === ALL ? "All" : item}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          ) : null}
          {shownServices.length > 0 ? (
            <ul className={pictureLayout ? "grid w-full gap-3 sm:grid-cols-2 lg:grid-cols-3" : "flex w-full flex-col gap-2"}>
              {shownServices.map((service) => (
                <li key={service.id} className="w-full min-w-0">
                  <ServiceLinkCard service={service} slug={clinic.slug} picture={pictureLayout} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">No {t.services} in this group.</p>
          )}
        </section>
      ) : null}

      {reviews.length > 0 ? (
        <section aria-labelledby="reviews-heading" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="reviews-heading" className="font-heading font-semibold text-lg">Reviews</h2>
            <RatingLine summary={ratings?.business} />
          </div>
          <Card>
            <CardPanel className="divide-y">
              {visibleReviews.map((review) => (
                <ReviewItem key={review.id} review={review} locale={clinic.locale} services={services} practitioners={practitioners} />
              ))}
            </CardPanel>
          </Card>
          {reviews.length > REVIEWS_SHOWN ? (
            <Button variant="outline" className="self-start" onClick={() => setShowAllReviews((value) => !value)} aria-expanded={showAllReviews}>
              {showAllReviews ? "Show fewer reviews" : "See all reviews"}
            </Button>
          ) : null}
        </section>
      ) : null}

      {clinic.about || aboutLocations.length > 0 ? (
        <section aria-labelledby="about-heading" className="flex flex-col gap-3">
        <h2 id="about-heading" className="font-heading font-semibold text-lg">About</h2>
        <Card>
          <CardPanel className="flex flex-col gap-5">
            {clinic.about ? <p className="whitespace-pre-line text-sm">{clinic.about}</p> : null}
            {aboutLocations.map((location, index) => (
              <div key={location.id} className="flex flex-col gap-3">
                {index > 0 || clinic.about ? <Separator /> : null}
                <div className="flex flex-col gap-1">
                  <h3 className="font-medium text-sm">{aboutLocations.length > 1 ? location.name : t.Location}</h3>
                  {location.address || location.city ? (
                  <a
                    href={mapHref(location, clinic.name)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-start gap-1.5 text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
                  >
                    <MapPinIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    <span>
                      {[location.address, location.city].filter(Boolean).join(", ")}
                      <span className="sr-only"> (opens a map in a new tab)</span>
                    </span>
                  </a>
                  ) : null}
                  {location.accessibleEntrance ? (
                    <p className="inline-flex items-center gap-1.5 text-muted-foreground text-sm">
                      <AccessibilityIcon aria-hidden="true" className="size-4 shrink-0" />
                      Step-free entrance
                    </p>
                  ) : null}
                </div>
              </div>
            ))}
          </CardPanel>
        </Card>
        </section>
      ) : null}
    </div>
  );
}

/** A service that opens the booking with it already chosen. */
function ServiceLinkCard({ service, slug, picture }: { service: Service; slug: string; picture: boolean }) {
  const isRequest = service.bookingMode === "request";
  const href = bookingHref(slug, { service: service.id });
  if (!picture) {
    return (
      <Link
        href={href}
        className="group flex min-h-14 w-full min-w-0 items-center gap-3 rounded-xl border bg-card p-3.5 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">{service.name}</span>
            {isRequest ? <Badge variant="outline">Request</Badge> : null}
          </span>
          <span className="text-muted-foreground text-sm tabular-nums">{serviceMeta(service)}</span>
          {service.description ? <span className="line-clamp-1 text-muted-foreground text-sm md:text-xs">{service.description}</span> : null}
        </span>
        <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </Link>
    );
  }
  return (
    <Link
      href={href}
      className="group flex h-full w-full min-w-0 items-stretch gap-3 overflow-hidden rounded-xl border bg-card p-2.5 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-col sm:gap-0 sm:p-0"
    >
      <span className="relative size-22 shrink-0 overflow-hidden rounded-lg bg-accent sm:aspect-[4/3] sm:size-auto sm:w-full sm:rounded-none">
        {service.imageUrl ? (
          <Image src={service.imageUrl} alt="" fill unoptimized sizes="(min-width: 1024px) 360px, (min-width: 640px) 50vw, 88px" className="object-cover transition-transform duration-300 motion-safe:group-hover:scale-[1.03]" />
        ) : (
          <span className="flex size-full items-center justify-center text-muted-foreground">
            <CalendarCheck2 className="size-6 sm:size-8" aria-hidden="true" />
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 sm:justify-start sm:p-4">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{service.name}</span>
          {isRequest ? <Badge variant="outline">Request</Badge> : null}
        </span>
        <span className="text-muted-foreground text-sm tabular-nums">{serviceMeta(service)}</span>
        {service.description ? <span className="line-clamp-1 text-muted-foreground text-sm sm:line-clamp-2 sm:text-xs">{service.description}</span> : null}
      </span>
    </Link>
  );
}

/**
 * A team member: photo, who they are and their rating, then their next free days as shortcuts into
 * the booking. A tap on the card opens their details in a drawer.
 */
function TeamCard({
  person,
  slug,
  locale,
  rating,
  services,
  days,
  todayKey,
}: {
  person: Practitioner;
  slug: string;
  locale: string;
  rating: RatingSummaries["business"] | undefined;
  services: Service[];
  days: string[];
  todayKey: string;
}) {
  const [open, setOpen] = useState(false);
  const profile = `/b/${slug}/team/${person.id}`;
  const book = bookingHref(slug, { person: person.id });
  return (
    <>
    <PersonCard
      name={person.name}
      role={[person.title, person.specialty].filter(Boolean).join(" · ")}
      image={person.photoUrl}
      profileHref={profile}
      onOpen={() => setOpen(true)}
      pills={<RatingLine summary={rating} />}
      line={days.length > 0 ? "Next free days" : undefined}
      menu={
        <>
          <MenuLinkItem render={<Link href={profile} />}>
            <UserRoundIcon aria-hidden="true" />
            See profile
          </MenuLinkItem>
          <MenuLinkItem render={<Link href={book} />}>
            <CalendarPlusIcon aria-hidden="true" />
            Book another day
          </MenuLinkItem>
          <MenuItem onClick={() => void shareLink({ title: person.name, path: profile })}>
            <Share2Icon aria-hidden="true" />
            Share
          </MenuItem>
        </>
      }
    >
      {days.length > 0 ? (
        <DayStrip
          days={days.map((key) => ({ key, href: bookingHref(slug, { person: person.id, date: key }) }))}
          todayKey={todayKey}
          locale={locale}
          label={`Next free days with ${person.name}`}
        />
      ) : (
        <Button size="sm" variant="outline" className="w-full" render={<Link href={book} />}>
          Book
          <span className="sr-only"> with {person.name}</span>
        </Button>
      )}
    </PersonCard>
    <PersonDrawer open={open} onOpenChange={setOpen} person={person} slug={slug} locale={locale} rating={rating} services={services} days={days} todayKey={todayKey} />
    </>
  );
}
