"use client";

import { CalendarClock, CalendarDays, CalendarX2, CheckCircle2, ClipboardList, Clock3, TriangleAlert, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardFooter, CardPanel } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import type { MySeatView } from "@/server/classes";

import { useTerms } from "../terms/business-profile-context";
import { BookingDetailRow } from "./booking-confirmation";
import { formatDateTime } from "./booking-format";
import { clockText, useCountdown } from "./use-countdown";

type Action = "cancel" | "accept_offer" | "decline_offer";

async function send(token: string, action: Action): Promise<MySeatView> {
  const response = await fetch(`/api/public/class-seats/${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const body = (await response.json().catch(() => null)) as { data?: MySeatView; error?: { code?: string; message?: string } } | null;
  if (!response.ok || !body?.data) {
    const failure = new Error(body?.error?.message ?? "Something went wrong. Please try again.");
    (failure as Error & { code?: string }).code = body?.error?.code;
    throw failure;
  }
  return body.data;
}

async function fetchSeat(token: string): Promise<MySeatView | null> {
  try {
    const response = await fetch(`/api/public/class-seats/${encodeURIComponent(token)}`, { headers: { Accept: "application/json" } });
    const body = (await response.json().catch(() => null)) as { data?: MySeatView } | null;
    return response.ok && body?.data ? body.data : null;
  } catch {
    return null;
  }
}

/**
 * The page a class message links to (feature 18). The link is the proof, no sign-in. It shows the class, teacher and time in
 * the place's own zone, and what the person can do: cancel a seat (with one confirm step), leave the waiting list, or take
 * or pass on a seat held for them, with the time left to answer.
 */
export function ClassSeatPage({ token, initial, locale = "en-IN" }: { token: string; initial: MySeatView | null; locale?: string }) {
  const t = useTerms();
  const [view, setView] = useState<MySeatView | null>(initial);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState("");
  const [loadedAt] = useState(() => Date.now());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const confirmRef = useRef<HTMLHeadingElement>(null);
  const seconds = useCountdown(view?.status === "waitlisted" ? view.offerExpiresAt : null);

  useEffect(() => { headingRef.current?.focus(); }, [view?.status, view?.offerExpiresAt]);
  useEffect(() => { if (confirming) confirmRef.current?.focus(); }, [confirming]);

  async function run(action: Action) {
    setPending(action);
    setError("");
    try {
      const next = await send(token, action);
      setView(next);
      setConfirming(false);
      setNotice(action === "accept_offer" ? "The seat is yours." : action === "decline_offer" ? "Thanks for letting us know. You stay on the waiting list." : "");
    } catch (cause) {
      const failure = cause as Error & { code?: string };
      if (failure.code === "offer_over" || failure.code === "session_closed") {
        const fresh = await fetchSeat(token);
        setView((current) => fresh ?? (current && { ...current, offerExpiresAt: null }));
        setConfirming(false);
      }
      setError(failure.message);
    } finally {
      setPending(null);
    }
  }

  if (!view) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><TriangleAlert aria-hidden="true" /></EmptyMedia>
          <EmptyTitle className="font-semibold"><h1 ref={headingRef} tabIndex={-1} className="outline-none">We could not load your place</h1></EmptyTitle>
          <EmptyDescription>{`Check your connection and open the link again. If it keeps failing, call the ${t.business}.`}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent><Button size="lg" onClick={() => window.location.reload()}>Try again</Button></EmptyContent>
      </Empty>
    );
  }

  const when = formatDateTime(view.startsAt, locale, view.timezone);
  const over = Date.parse(view.endsAt) < loadedAt;
  const sessionCancelled = view.sessionStatus === "cancelled";
  const offerLive = view.status === "waitlisted" && !sessionCancelled && !over && view.offerExpiresAt !== null && (seconds ?? 0) > 0;
  const offerLapsed = view.status === "waitlisted" && view.offerExpiresAt !== null && seconds === 0;

  const details = (
    <dl className="flex flex-col gap-3.5">
      <BookingDetailRow icon={ClipboardList} label="Class">{view.serviceName}</BookingDetailRow>
      <BookingDetailRow icon={UserRound} label="Teacher">{view.teacherName}</BookingDetailRow>
      <BookingDetailRow icon={CalendarDays} label="Date and time"><span className="tabular-nums">{when}</span></BookingDetailRow>
    </dl>
  );

  const errorAlert = error ? (
    <Alert variant="error" role="alert">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>That did not go through</AlertTitle>
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  ) : null;

  // The ends of the road: nothing more to do here.
  const ended = sessionCancelled || over || view.status === "cancelled" || view.status === "attended" || view.status === "no_show";
  if (ended && !offerLive) {
    const title = sessionCancelled ? "This class was cancelled"
      : view.status === "cancelled" ? "Your place is cancelled"
      : view.status === "attended" ? "You took part in this class"
      : view.status === "no_show" ? "You did not come to this class"
      : "This class has finished";
    const words = sessionCancelled ? `${view.businessName} cancelled this class. Nothing more is needed from you.`
      : view.status === "cancelled" ? "Your seat can go to someone else."
      : `This class was on ${when}.`;
    return (
      <section aria-labelledby="seat-title" className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><CalendarX2 aria-hidden="true" /></EmptyMedia>
            <EmptyTitle className="font-semibold"><h1 id="seat-title" ref={headingRef} tabIndex={-1} className="outline-none">{title}</h1></EmptyTitle>
            <EmptyDescription>{words}</EmptyDescription>
          </EmptyHeader>
        </Empty>
        <Card><CardPanel className="p-5">{details}</CardPanel></Card>
        {errorAlert}
      </section>
    );
  }

  if (offerLive && seconds !== null) {
    return (
      <section aria-labelledby="seat-title" className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div aria-hidden="true" className="flex size-12 items-center justify-center rounded-full bg-info/8 text-info-foreground"><CalendarClock className="size-6" /></div>
          <h1 id="seat-title" ref={headingRef} tabIndex={-1} className="font-heading font-semibold text-2xl outline-none">A seat opened up</h1>
          <p className="max-w-prose text-muted-foreground text-sm">{`You are on the waiting list for this class. Take the seat now, or it goes to the next person.`}</p>
        </div>
        <p className="flex items-center justify-center gap-2 rounded-lg bg-muted/48 px-3 py-2 text-sm" role="timer" aria-live="off">
          <Clock3 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span>Time left to answer: <span className="font-medium tabular-nums">{clockText(seconds)}</span></span>
        </p>
        <Card>
          <CardPanel className="p-5">{details}</CardPanel>
          <CardFooter className="flex flex-col gap-2 p-5 pt-0 sm:flex-row">
            <Button size="lg" className="w-full sm:flex-1" loading={pending === "accept_offer"} disabled={pending !== null} onClick={() => void run("accept_offer")}>Take this seat</Button>
            <Button size="lg" variant="outline" className="w-full sm:w-auto" loading={pending === "decline_offer"} disabled={pending !== null} onClick={() => void run("decline_offer")}>No thanks</Button>
          </CardFooter>
        </Card>
        {errorAlert}
      </section>
    );
  }

  const booked = view.status === "booked";
  return (
    <section aria-labelledby="seat-title" className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <div aria-hidden="true" className={booked ? "flex size-12 items-center justify-center rounded-full bg-success/8 text-success-foreground" : "flex size-12 items-center justify-center rounded-full bg-info/8 text-info-foreground"}>
          {booked ? <CheckCircle2 className="size-6" /> : <Clock3 className="size-6" />}
        </div>
        <h1 id="seat-title" ref={headingRef} tabIndex={-1} className="font-heading font-semibold text-2xl outline-none">
          {booked ? "You have a seat" : `You’re number ${view.position ?? 1} on the waiting list`}
        </h1>
        <Badge variant={booked ? "success" : "info"} size="lg">{booked ? "Booked" : "Waiting list"}</Badge>
        {!booked ? <p className="max-w-prose text-muted-foreground text-sm">We’ll message you when a seat opens. Nothing is booked until you take it.</p> : null}
      </div>
      {notice ? <Alert variant="success" role="status"><CheckCircle2 aria-hidden="true" /><AlertDescription>{notice}</AlertDescription></Alert> : null}
      {offerLapsed ? <Alert variant="warning" role="status"><TriangleAlert aria-hidden="true" /><AlertDescription>The seat held for you has gone to the next person. You stay on the waiting list.</AlertDescription></Alert> : null}
      <Card>
        <CardPanel className="p-5">{details}</CardPanel>
        <CardFooter className="flex flex-col gap-3 p-5 pt-0">
          {confirming ? (
            <div className="flex w-full flex-col gap-3 rounded-lg border bg-muted/32 p-4">
              <h2 ref={confirmRef} tabIndex={-1} className="font-heading font-semibold text-base outline-none">{booked ? "Cancel your place?" : "Leave the waiting list?"}</h2>
              <p className="text-muted-foreground text-sm">{booked ? "Your seat goes to the next person waiting." : "You will not hear about this class again."}</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button size="lg" variant="destructive" className="w-full sm:w-auto" loading={pending === "cancel"} disabled={pending !== null} onClick={() => void run("cancel")}>{booked ? "Yes, cancel my place" : "Yes, leave the waiting list"}</Button>
                <Button size="lg" variant="outline" className="w-full sm:w-auto" disabled={pending !== null} onClick={() => setConfirming(false)}>{booked ? "Keep my place" : "Stay on the list"}</Button>
              </div>
            </div>
          ) : (
            <Button size="lg" variant="outline" className="w-full sm:w-auto" onClick={() => { setError(""); setConfirming(true); }}>{booked ? "Cancel my place" : "Leave the waiting list"}</Button>
          )}
        </CardFooter>
      </Card>
      {errorAlert}
    </section>
  );
}
