"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArrowRightIcon,
  ArrowUpDownIcon,
  CalendarPlusIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  EllipsisIcon,
  LayoutGridIcon,
  PencilIcon,
  ListChecksIcon,
  RotateCcwIcon,
  SearchXIcon,
  Share2Icon,
  SlidersHorizontalIcon,
  UserRoundIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuLinkItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import {
  cleanGuideAnswers,
  decodeGuideAnswers,
  encodeGuideAnswers,
  guideSummary,
  matchGuide,
  type BookingGuide,
  type GuideAnswers,
} from "@/lib/booking-guide";
import { NEXT_FREE_DAYS_WINDOW, bookingHref, countFreeTimes, lowestPrice, pricePillLabel, type FreeTimes } from "@/lib/business-page";
import type { Clinic, Practitioner, Service } from "@/lib/domain";
import type { RatingSummaries } from "@/lib/reviews";

import { BookingBottomBar } from "../booking/booking-bottom-bar";
import { BookingProgress } from "../booking/booking-progress";
import { serviceMeta } from "../booking/service-card";
import { StepHeader } from "../booking/steps/step-header";
import { useTerms } from "../terms/business-profile-context";
import { GuideQuestionChoices } from "./guide-question";
import { DayStrip, PersonCard, Pill } from "./person-card";
import { RatingLine } from "./ratings";
import { shareLink } from "./share-link";

const DAYS_SHOWN = 6;
const TITLE_ID = "find-guide-title";

type Sort = "soonest" | "rating" | "price";
const SORT_LABELS: Record<Sort, string> = { soonest: "Soonest free", rating: "Top rated", price: "Lowest price" };

type Stage = { kind: "question"; index: number } | { kind: "summary" } | { kind: "results" };

/** Which screen a link opens. Anything unknown opens the first question. */
function readStage(step: string | null, questionCount: number): Stage {
  if (step === "summary" || step === "results") return { kind: step };
  const number = Number.parseInt(step ?? "1", 10);
  const index = Number.isFinite(number) ? Math.min(Math.max(number, 1), questionCount) - 1 : 0;
  return { kind: "question", index };
}

function stageKey(stage: Stage): string {
  return stage.kind === "question" ? String(stage.index + 1) : stage.kind;
}

export interface FindGuideProps {
  clinic: Clinic;
  guide: BookingGuide;
  services: Service[];
  practitioners: Practitioner[];
  ratings?: RatingSummaries;
  freeTimes: FreeTimes;
  /** The business's "YYYY-MM-DD" today, worked out on the server so both renders agree. */
  todayKey: string;
}

/**
 * "Help me choose" for customers: one question per screen, a checklist of what was chosen, then the
 * people and services that fit. The screen and the answers live in the link, so Back works and a
 * customer who opens a profile comes back to the same results.
 */
export function FindGuide({ clinic, guide, services, practitioners, ratings, freeTimes, todayKey }: FindGuideProps) {
  const t = useTerms();
  const params = useSearchParams();
  const stage = readStage(params.get("step"), guide.questions.length);
  const key = stageKey(stage);
  const linkAnswers = params.get("answers") ?? "";
  const [sort, setSort] = useState<Sort>("soonest");

  // Answers are kept here so a tap shows at once, and follow the link whenever it changes (Back, Forward).
  const [answers, setAnswers] = useState<GuideAnswers>(() => cleanGuideAnswers(guide, decodeGuideAnswers(linkAnswers)));
  const [seenLinkAnswers, setSeenLinkAnswers] = useState(linkAnswers);
  if (seenLinkAnswers !== linkAnswers) {
    setSeenLinkAnswers(linkAnswers);
    setAnswers(cleanGuideAnswers(guide, decodeGuideAnswers(linkAnswers)));
  }

  const match = useMemo(() => matchGuide(guide, answers, services, practitioners), [guide, answers, services, practitioners]);
  const summary = useMemo(() => guideSummary(guide, answers), [guide, answers]);

  // Move focus to the new screen's title, so keyboard and screen-reader users know the screen changed.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    window.scrollTo({ top: 0 });
    document.querySelector<HTMLElement>("[data-step-heading]")?.focus({ preventScroll: true });
  }, [key]);

  function search(step: string, nextAnswers: GuideAnswers): string {
    const query = new URLSearchParams({ step });
    const encoded = encodeGuideAnswers(nextAnswers);
    if (encoded) query.set("answers", encoded);
    return `?${query.toString()}`;
  }

  function go(step: string) {
    window.history.pushState(null, "", search(step, answers));
  }

  function answer(questionId: string, chosen: string[]) {
    const next = { ...answers };
    if (chosen.length > 0) next[questionId] = chosen;
    else delete next[questionId];
    setAnswers(next);
    window.history.replaceState(null, "", search(key, next));
  }

  function startAgain() {
    setAnswers({});
    window.history.pushState(null, "", search("1", {}));
  }

  const home = `/b/${clinic.slug}`;
  const answered = Object.keys(answers).length > 0;

  if (stage.kind === "question") {
    const question = guide.questions[stage.index];
    const chosen = answers[question.id] ?? [];
    const last = stage.index === guide.questions.length - 1;
    const helpId = `${TITLE_ID}-help`;
    const help = question.help || (question.multiple ? "Pick as many as you like." : undefined);
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 max-md:pb-24">
        <BookingProgress current={stage.index + 1} total={guide.questions.length} />
        <StepHeader
          titleId={TITLE_ID}
          title={question.label}
          description={help ? <span id={helpId}>{help}</span> : undefined}
          aside={
            <Menu>
              <MenuTrigger render={<Button aria-label="More options" size="icon" variant="ghost" className="-me-2 shrink-0" />}>
                <EllipsisIcon aria-hidden="true" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => go("results")}>
                  <ListChecksIcon aria-hidden="true" />
                  Skip to results
                </MenuItem>
                {answered ? (
                  <MenuItem onClick={startAgain}>
                    <RotateCcwIcon aria-hidden="true" />
                    Start again
                  </MenuItem>
                ) : null}
                <MenuSeparator />
                <MenuLinkItem render={<Link href={home} />}>
                  <LayoutGridIcon aria-hidden="true" />
                  See everything at {clinic.name}
                </MenuLinkItem>
              </MenuPopup>
            </Menu>
          }
        />
        <GuideQuestionChoices
          question={question}
          value={chosen}
          onChange={(next) => answer(question.id, next)}
          labelledBy={TITLE_ID}
          describedBy={help ? helpId : undefined}
          idPrefix="find"
        />
        <BookingBottomBar onBack={stage.index > 0 ? () => go(String(stage.index)) : undefined}>
          <Button size="lg" variant={chosen.length > 0 ? "default" : "outline"} onClick={() => go(last ? "summary" : String(stage.index + 2))}>
            {chosen.length > 0 ? "Continue" : "Skip this question"}
            <ArrowRightIcon aria-hidden="true" />
          </Button>
        </BookingBottomBar>
      </div>
    );
  }

  if (stage.kind === "summary") {
    const fits = match.people.length > 0 ? `${match.people.length} ${match.people.length === 1 ? t.provider : t.providers}` : `${match.services.length} ${match.services.length === 1 ? t.service : t.services}`;
    const nothing = match.people.length === 0 && match.services.length === 0;
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 max-md:pb-24">
        <StepHeader
          titleId={TITLE_ID}
          title="Here's what we'll look for"
          description="Check your answers, or change one."
        />
        <Card>
          <CardPanel className="p-0">
            <ul className="divide-y">
              {guide.questions.map((question, index) => {
                const chosen = summary.find((entry) => entry.id === question.id)?.chosen ?? [];
                const Icon = chosen.length > 0 ? CircleCheckIcon : CircleDashedIcon;
                return (
                  <li key={question.id} className="flex items-center gap-3 px-4 py-3">
                    <Icon aria-hidden="true" className={chosen.length > 0 ? "size-5 shrink-0 text-success" : "size-5 shrink-0 text-muted-foreground"} />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <p className="break-words text-muted-foreground text-xs">{question.label}</p>
                      <p className="break-words font-medium text-sm">{chosen.length > 0 ? chosen.join(", ") : "No preference"}</p>
                    </div>
                    <Button aria-label={`Change: ${question.label}`} size="icon-sm" variant="ghost" className="-me-1.5 shrink-0" onClick={() => go(String(index + 1))}>
                      <PencilIcon aria-hidden="true" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </CardPanel>
        </Card>
        {nothing ? (
          <p className="text-muted-foreground text-sm" aria-live="polite">Nothing fits all of these answers yet. Change one to see more.</p>
        ) : null}
        <BookingBottomBar onBack={() => go(String(guide.questions.length))}>
          <Button size="lg" onClick={() => go("results")}>
            {nothing ? "See results" : `See ${fits}`}
            <ArrowRightIcon aria-hidden="true" />
          </Button>
        </BookingBottomBar>
      </div>
    );
  }

  const fitting = (person: Practitioner) => match.services.filter((service) => service.practitionerIds.includes(person.id));
  const firstFreeDay = (person: Practitioner) => Object.keys(freeTimes[person.id] ?? {}).sort()[0] ?? "9999";
  const average = (person: Practitioner) => ratings?.byPractitioner[person.id]?.average ?? -1;
  const price = (person: Practitioner) => lowestPrice(fitting(person))?.value ?? Number.POSITIVE_INFINITY;
  // Soonest free is the order underneath the other two, so equal ratings or prices still read sensibly.
  const soonest = [...match.people].sort((a, b) => firstFreeDay(a).localeCompare(firstFreeDay(b)));
  const people = sort === "rating" ? soonest.sort((a, b) => average(b) - average(a)) : sort === "price" ? soonest.sort((a, b) => price(a) - price(b)) : soonest;
  const sorts: Sort[] = ["soonest", ...(match.people.some((person) => average(person) >= 0) ? (["rating"] as const) : []), ...(match.people.some((person) => Number.isFinite(price(person))) ? (["price"] as const) : [])];
  const nothing = people.length === 0 && match.services.length === 0;
  const title = nothing
    ? "Nothing fits those answers"
    : people.length > 0
      ? `${people.length} ${people.length === 1 ? t.provider : t.providers} for you`
      : `${match.services.length} ${match.services.length === 1 ? t.service : t.services} for you`;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <StepHeader
        titleId={TITLE_ID}
        title={title}
        description={
          nothing
            ? undefined
            : people.length === 0
              ? `Picked from your answers. Choose one to book.`
              : match.narrowed
                ? `Picked from your answers. Tap a day to book.`
                : `Your answers fit the whole team. Tap a day to book.`
        }
        aside={
          <div className="flex shrink-0 items-center gap-2">
            {people.length > 1 && sorts.length > 1 ? (
              <Menu>
                <MenuTrigger render={<Button aria-label={`Sort: ${SORT_LABELS[sort]}`} size="icon" variant="outline" />}>
                  <ArrowUpDownIcon aria-hidden="true" />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuGroup>
                    <MenuGroupLabel>Sort by</MenuGroupLabel>
                    <MenuRadioGroup value={sort} onValueChange={(next) => setSort(next as Sort)}>
                      {sorts.map((option) => (
                        <MenuRadioItem key={option} value={option}>
                          {SORT_LABELS[option]}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuGroup>
                </MenuPopup>
              </Menu>
            ) : null}
            <Menu>
              <MenuTrigger render={<Button aria-label="Your answers" size="icon" variant="outline" />}>
                <SlidersHorizontalIcon aria-hidden="true" />
              </MenuTrigger>
              <MenuPopup align="end" className="w-64">
                <MenuGroup>
                  <MenuGroupLabel>Your answers · tap one to change it</MenuGroupLabel>
                  {guide.questions.map((question, index) => {
                    const chosen = summary.find((entry) => entry.id === question.id)?.chosen ?? [];
                    return (
                      <MenuItem key={question.id} onClick={() => go(String(index + 1))}>
                        <span className="flex min-w-0 flex-col py-0.5">
                          <span className="truncate text-muted-foreground text-xs">{question.label}</span>
                          <span className="truncate">{chosen.length > 0 ? chosen.join(", ") : "No preference"}</span>
                        </span>
                      </MenuItem>
                    );
                  })}
                </MenuGroup>
                <MenuSeparator />
                <MenuItem onClick={startAgain}>
                  <RotateCcwIcon aria-hidden="true" />
                  Start again
                </MenuItem>
                <MenuLinkItem render={<Link href={home} />}>
                  <LayoutGridIcon aria-hidden="true" />
                  <span className="truncate">See everything at {clinic.name}</span>
                </MenuLinkItem>
              </MenuPopup>
            </Menu>
          </div>
        }
      />

      {nothing ? (
        <Empty className="rounded-xl border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchXIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No one fits all of these yet</EmptyTitle>
            <EmptyDescription>Change an answer to widen the search, or see every {t.service} and {t.provider} at {clinic.name}.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row flex-wrap justify-center gap-2">
            <Button onClick={() => go("1")}>Change answers</Button>
            <Button variant="outline" render={<Link href={home} />}>
              See everyone
            </Button>
          </EmptyContent>
        </Empty>
      ) : null}

      {people.length > 0 ? (
        <ul className="grid gap-3 md:grid-cols-2">
          {people.map((person) => (
            <li key={person.id} className="min-w-0">
              <ResultCard
                person={person}
                slug={clinic.slug}
                locale={clinic.locale}
                rating={ratings?.byPractitioner[person.id]}
                services={fitting(person)}
                times={freeTimes[person.id]}
                todayKey={todayKey}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {match.services.length > 0 && (match.narrowed || people.length === 0) ? (
        <section aria-labelledby="find-services-heading" className="flex flex-col gap-3">
          <h2 id="find-services-heading" className="font-heading font-semibold text-lg">
            {t.Services} that fit
          </h2>
          <ul className="grid gap-2 md:grid-cols-2">
            {match.services.map((service) => (
              <li key={service.id} className="min-w-0">
                <Link
                  href={bookingHref(clinic.slug, { service: service.id })}
                  className="group flex min-h-14 w-full min-w-0 items-center gap-3 rounded-xl border bg-card p-3.5 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="break-words font-medium">{service.name}</span>
                      {service.bookingMode === "request" ? <Badge variant="outline">Request</Badge> : null}
                    </span>
                    <span className="text-muted-foreground text-sm tabular-nums">{serviceMeta(service)}</span>
                  </span>
                  <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** One person who fits: rating and price on top, how many times are free, and days that open the booking. */
function ResultCard({
  person,
  slug,
  locale,
  rating,
  services,
  times,
  todayKey,
}: {
  person: Practitioner;
  slug: string;
  locale: string;
  rating: RatingSummaries["business"] | undefined;
  /** The services that fit the answers and that this person offers. */
  services: Service[];
  times: Record<string, number> | undefined;
  todayKey: string;
}) {
  const price = pricePillLabel(services);
  const free = countFreeTimes(times);
  // With one fitting service the booking opens with it chosen; with several the customer picks there.
  const service = services.length === 1 ? services[0].id : undefined;
  const profile = `/b/${slug}/team/${person.id}`;
  const book = bookingHref(slug, { service, person: person.id });
  const days = Object.keys(times ?? {})
    .sort()
    .slice(0, DAYS_SHOWN)
    .map((key) => ({ key, href: bookingHref(slug, { service, person: person.id, date: key }), count: times?.[key] }));

  return (
    <PersonCard
      name={person.name}
      role={[person.title, person.specialty].filter(Boolean).join(" · ")}
      image={person.photoUrl}
      profileHref={profile}
      pills={
        <>
          <RatingLine summary={rating} />
          {price ? <Pill>{price}</Pill> : null}
        </>
      }
      line={free > 0 ? `${free} free ${free === 1 ? "time" : "times"} · next ${NEXT_FREE_DAYS_WINDOW} days` : `No free times in the next ${NEXT_FREE_DAYS_WINDOW} days`}
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
        <DayStrip days={days} todayKey={todayKey} locale={locale} label={`Next free days with ${person.name}`} />
      ) : (
        <Button size="sm" variant="outline" className="w-full" render={<Link href={book} />}>
          See later dates
          <span className="sr-only"> with {person.name}</span>
        </Button>
      )}
    </PersonCard>
  );
}
