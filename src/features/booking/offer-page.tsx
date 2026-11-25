"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CalendarClock, CalendarDays, CalendarX2, CheckCircle2, ClipboardList, Clock3, MapPin, ThumbsDown, TriangleAlert, UserRound } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardFooter, CardPanel } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import type { AcceptResult, OfferView } from "@/server/waitlist-accept";

import { useTerms } from "../terms/business-profile-context";
import { BookingDetailRow } from "./booking-confirmation";
import { formatDateTime, phoneHref } from "./booking-format";

type Answer = "accept" | "decline" | "cancel_later";

/** Whole minutes left, never negative. */
export function minutesLeft(expiresAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 60_000));
}

async function answer<T>(token: string, action: Answer): Promise<T> {
  const response = await fetch(`/api/public/offers/${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const body = (await response.json().catch(() => null)) as { data?: T; error?: { code?: string; message?: string } } | null;
  if (!response.ok || !body?.data) {
    const failure = new Error(body?.error?.message ?? "Something went wrong. Please try again.");
    (failure as Error & { code?: string }).code = body?.error?.code;
    throw failure;
  }
  return body.data;
}

/**
 * The page a waitlist message opens (feature 21). One tap takes the time; no sign-in, the link is the proof. It shows the
 * time, who it is with and how long is left, and what happens next once it is taken, including a later booking the person
 * may no longer want. Words come from the business, so a salon says "appointment" and a clinic says "visit".
 */
export function OfferPage({ token, initial, locale = "en-IN" }: { token: string; initial: OfferView | null; locale?: string }) {
  const t = useTerms();
  const [view, setView] = useState<OfferView | null>(initial);
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState<Answer | null>(null);
  const [error, setError] = useState("");
  const [taken, setTaken] = useState<AcceptResult | null>(null);
  const [laterCancelled, setLaterCancelled] = useState(false);
  const [declined, setDeclined] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (view?.state !== "open") return;
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [view?.state]);
  useEffect(() => { headingRef.current?.focus(); }, [taken, declined, view?.state]);

  async function run(action: Answer) {
    setPending(action);
    setError("");
    try {
      if (action === "accept") setTaken(await answer<AcceptResult>(token, "accept"));
      else if (action === "decline") { await answer(token, "decline"); setDeclined(true); }
      else { await answer(token, "cancel_later"); setLaterCancelled(true); }
    } catch (cause) {
      const failure = cause as Error & { code?: string };
      if (failure.code === "offer_closed" || failure.code === "slot_unavailable") setView((current) => current && { ...current, state: "closed" });
      else setError(failure.message);
    } finally {
      setPending(null);
    }
  }

  if (!view) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><TriangleAlert aria-hidden="true" /></EmptyMedia>
          <EmptyTitle className="font-semibold"><h1 ref={headingRef} tabIndex={-1} className="outline-none">We could not load this time</h1></EmptyTitle>
          <EmptyDescription>Check your connection and open the link again. If it keeps failing, call the {t.business}.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent><Button size="lg" onClick={() => window.location.reload()}>Try again</Button></EmptyContent>
      </Empty>
    );
  }

  const when = formatDateTime(view.startsAt, locale, view.timezone);
  const left = minutesLeft(view.expiresAt, now);
  const open = view.state === "open" && left > 0 && !taken && !declined;

  if (taken) {
    const isRequest = taken.status === "requested";
    const later = taken.laterAppointmentAt && !laterCancelled ? formatDateTime(taken.laterAppointmentAt, locale, view.timezone) : null;
    return (
      <section aria-labelledby="offer-title" className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div aria-hidden="true" className="flex size-12 items-center justify-center rounded-full bg-success/8 text-success-foreground motion-safe:animate-toast-success-odd">
            <CheckCircle2 className="size-6" />
          </div>
          <h1 id="offer-title" ref={headingRef} tabIndex={-1} className="font-heading font-semibold text-2xl outline-none">{isRequest ? "Request sent" : "You’re booked"}</h1>
          <p className="max-w-prose text-muted-foreground text-sm">
            {isRequest ? `${view.business.name} will confirm this time with you.` : `That time is yours. We will send the details and a link to change it.`}
          </p>
        </div>
        <Card>
          <CardPanel className="p-5">
            <OfferDetails view={view} when={when} />
          </CardPanel>
          {taken.manageToken ? (
            <CardFooter className="p-5 pt-0">
              <Button variant="outline" render={<Link href={`/manage/${encodeURIComponent(taken.manageToken)}`} />}>Manage {t.appointment}</Button>
            </CardFooter>
          ) : null}
        </Card>
        {error ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
        {later ? (
          <Card>
            <CardPanel className="flex flex-col gap-3 p-5">
              <h2 className="font-heading font-semibold text-base">Cancel your later {t.appointment}?</h2>
              <p className="text-muted-foreground text-sm">{`You also have the same ${t.service} on ${later}. Cancel it so someone else can have that time.`}</p>
              <div className="flex flex-wrap gap-2">
                <Button loading={pending === "cancel_later"} disabled={pending !== null} onClick={() => void run("cancel_later")}>Cancel the later one</Button>
                <Button variant="outline" disabled={pending !== null} onClick={() => setTaken({ ...taken, laterAppointmentAt: null })}>Keep both</Button>
              </div>
            </CardPanel>
          </Card>
        ) : null}
        {laterCancelled ? <Alert variant="success" role="status"><CheckCircle2 aria-hidden="true" /><AlertDescription>Your later {t.appointment} is cancelled.</AlertDescription></Alert> : null}
      </section>
    );
  }

  if (declined) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><ThumbsDown aria-hidden="true" /></EmptyMedia>
          <EmptyTitle className="font-semibold"><h1 ref={headingRef} tabIndex={-1} className="outline-none">Thanks for letting us know</h1></EmptyTitle>
          <EmptyDescription>You stay on the waitlist, and we will message you when another time opens up.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (!open) {
    const booked = view.state === "booked";
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">{booked ? <CheckCircle2 aria-hidden="true" /> : <CalendarX2 aria-hidden="true" />}</EmptyMedia>
          <EmptyTitle className="font-semibold">
            <h1 ref={headingRef} tabIndex={-1} className="outline-none">{booked ? "This time is booked" : view.state === "declined" ? "You passed on this time" : "This time is no longer open"}</h1>
          </EmptyTitle>
          <EmptyDescription>
            {booked
              ? `You already took this time. Your confirmation message has the link to change it.`
              : view.state === "declined"
                ? "You stay on the waitlist for the next opening."
                : `Offers are held for a short while and then go to the next person. You stay on the waitlist, or you can look for another time.`}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row flex-wrap justify-center">
          {booked ? null : <Button size="lg" render={<Link href={`/book/${encodeURIComponent(view.business.slug)}`} />}>See other times</Button>}
          <Button size="lg" variant="outline" render={<a href={phoneHref(view.business.phone)} />}>Call {view.business.name}</Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <section aria-labelledby="offer-title" className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <div aria-hidden="true" className="flex size-12 items-center justify-center rounded-full bg-info/8 text-info-foreground"><CalendarClock className="size-6" /></div>
        <h1 id="offer-title" ref={headingRef} tabIndex={-1} className="font-heading font-semibold text-2xl outline-none">A time just opened up</h1>
        <p className="max-w-prose text-muted-foreground text-sm">{`You asked ${view.business.name} to tell you when this opened. Take it now, or it goes to the next person.`}</p>
      </div>
      <p className="flex items-center justify-center gap-2 rounded-lg bg-muted/48 px-3 py-2 text-sm" role="timer" aria-live="off">
        <Clock3 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span>About <span className="font-medium tabular-nums">{left}</span> {left === 1 ? "minute" : "minutes"} left to answer</span>
      </p>
      <Card>
        <CardPanel className="p-5"><OfferDetails view={view} when={when} /></CardPanel>
        <CardFooter className="flex flex-col gap-2 p-5 pt-0 sm:flex-row">
          <Button size="lg" className="w-full sm:flex-1" loading={pending === "accept"} disabled={pending !== null} onClick={() => void run("accept")}>Take this time</Button>
          <Button size="lg" variant="outline" className="w-full sm:w-auto" disabled={pending !== null} loading={pending === "decline"} onClick={() => void run("decline")}>Not this time</Button>
        </CardFooter>
      </Card>
      {error ? (
        <Alert variant="error">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>That did not go through</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}

function OfferDetails({ view, when }: { view: OfferView; when: string }) {
  const t = useTerms();
  return (
    <dl className="flex flex-col gap-3.5">
      <BookingDetailRow icon={CalendarDays} label="Date and time"><span className="tabular-nums">{when}</span></BookingDetailRow>
      <BookingDetailRow icon={ClipboardList} label={t.Service}>{view.serviceName}</BookingDetailRow>
      <BookingDetailRow icon={UserRound} label={t.Practitioner}>{view.practitionerName}</BookingDetailRow>
      <BookingDetailRow icon={MapPin} label={t.Location}>{view.locationName}</BookingDetailRow>
    </dl>
  );
}
