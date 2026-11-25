"use client";

import { CalendarClock, CircleCheck, Clock, TriangleAlert, Video } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { VisitEnterView, VisitStatusView } from "@/lib/video-contracts";

import { DeviceCheck } from "./device-check";
import { VideoCall } from "./video-call";
import { videoCall, VideoApiError } from "./video-api";
import { formatCountdown, formatViewerDay, formatViewerTime, PhoneFallback, useInterval, useNow } from "./video-shared";

const POLL_MS = 5_000;
const HEARTBEAT_MS = 20_000;

type Phase = "check" | "waiting" | "call" | "left";

function Shell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <main className={`mx-auto flex min-h-dvh w-full flex-col gap-5 px-4 py-6 ${wide ? "max-w-4xl" : "max-w-2xl"}`}>{children}</main>;
}

function Message({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <section className="flex flex-col items-start gap-3" aria-labelledby="visit-title">
      <span aria-hidden="true" className="flex size-11 items-center justify-center rounded-full bg-accent text-muted-foreground">{icon}</span>
      <h1 id="visit-title" className="font-heading font-semibold text-2xl">{title}</h1>
      {children}
    </section>
  );
}

/**
 * The customer's video visit page. It checks their camera, puts them in the waiting room, and opens the call
 * once staff let them in. The page asks the server for the state every few seconds until the call starts.
 */
export function CustomerVisit({ token, testOnly = false }: { token: string; testOnly?: boolean }) {
  if (testOnly) {
    return (
      <Shell>
        <Message icon={<Video className="size-5" />} title="Test your camera">
          <p className="text-muted-foreground text-sm">Check your camera, microphone and speakers. Nobody is told when you do this.</p>
        </Message>
        <DeviceCheck />
      </Shell>
    );
  }
  return <VisitFlow token={token} />;
}

function VisitFlow({ token }: { token: string }) {
  const path = `/api/public/visit/${encodeURIComponent(token)}`;
  const [status, setStatus] = useState<VisitStatusView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [offline, setOffline] = useState(false);
  const [clientPhase, setClientPhase] = useState<Phase | null>(null);
  const [enter, setEnter] = useState<VisitEnterView | null>(null);
  const [joinError, setJoinError] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [entering, setEntering] = useState(false);

  const phase: Phase = clientPhase ?? (status && status.customerStage !== "none" ? "waiting" : "check");
  const inCall = phase === "call";

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const view = await videoCall<VisitStatusView>(path, { signal });
      setStatus(view);
      setLoadError("");
      setOffline(false);
    } catch (cause: unknown) {
      if (signal?.aborted) return;
      if (cause instanceof VideoApiError && cause.status === 404) {
        setLoadError("This link doesn't work. Check the message we sent you, or phone us.");
        return;
      }
      setOffline(true);
      setLoadError((current) => current || (cause instanceof Error ? cause.message : "The visit could not be loaded."));
    }
  }, [path]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => void load(controller.signal));
    return () => controller.abort();
  }, [load]);

  // Ask again every 5 seconds until the call starts.
  useInterval(() => {
    if (document.visibilityState === "visible") void load();
  }, POLL_MS, !inCall);

  // Still here: every 20 seconds once waiting, and during the call.
  useInterval(() => {
    void videoCall<VisitStatusView>(path, { method: "POST", body: { action: "heartbeat" } })
      .then((view) => {
        setStatus(view);
        setOffline(false);
      })
      .catch(() => setOffline(true));
  }, HEARTBEAT_MS, phase === "waiting" || phase === "call");

  const joinCall = useCallback(async () => {
    setEntering(true);
    setJoinError("");
    try {
      const view = await videoCall<VisitEnterView>(path, { method: "POST", body: { action: "enter" } });
      setEnter(view);
      setClientPhase("call");
    } catch (cause: unknown) {
      if (cause instanceof VideoApiError && cause.code === "not_admitted") {
        // Not let in yet, or sent back to wait: the next poll tells us.
        setClientPhase("waiting");
      } else {
        setJoinError(cause instanceof Error ? cause.message : "We could not open the call.");
      }
    } finally {
      setEntering(false);
    }
  }, [path]);

  // Staff let them in: open the call by itself.
  const admitted = status?.customerStage === "admitted";
  const attempted = useRef(false);
  useEffect(() => {
    if (phase !== "waiting" || !admitted || entering || joinError || attempted.current) return;
    attempted.current = true;
    queueMicrotask(() => void joinCall());
  }, [admitted, entering, joinCall, joinError, phase]);
  useEffect(() => {
    if (!admitted) attempted.current = false;
  }, [admitted]);

  async function imReady() {
    setWaiting(true);
    setJoinError("");
    try {
      setStatus(await videoCall<VisitStatusView>(path, { method: "POST", body: { action: "wait" } }));
      setClientPhase("waiting");
    } catch (cause: unknown) {
      setJoinError(cause instanceof Error ? cause.message : "We could not tell them you are here.");
    } finally {
      setWaiting(false);
    }
  }

  if (!status) {
    if (loadError && !offline) {
      return (
        <Shell>
          <Message icon={<TriangleAlert className="size-5" />} title="We can't open this visit">
            <p className="text-muted-foreground text-sm">{loadError}</p>
          </Message>
        </Shell>
      );
    }
    if (loadError) {
      return (
        <Shell>
          <Alert variant="error">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>{loadError}</span>
              <Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>
            </AlertDescription>
          </Alert>
        </Shell>
      );
    }
    return (
      <Shell>
        <p role="status" className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
          <Spinner aria-hidden="true" className="motion-reduce:animate-none" /> Loading your visit…
        </p>
      </Shell>
    );
  }

  const phone = status.businessPhone;
  const startsLine = `${formatViewerDay(status.startsAt)} at ${formatViewerTime(status.startsAt)}`;
  const summary = (
    <p className="text-muted-foreground text-sm">
      {status.serviceName} with {status.staffName} · {status.businessName}
      <br />
      <span className="tabular-nums">{startsLine}</span>
    </p>
  );

  if (inCall && enter) {
    return (
      <Shell wide>
        <header className="flex flex-col gap-1">
          <h1 className="font-heading font-semibold text-xl">{status.serviceName} with {status.staffName}</h1>
          {offline ? <p role="status" className="text-muted-foreground text-xs">Reconnecting to the page…</p> : null}
        </header>
        <VideoCall enter={enter} businessPhone={phone} onLeave={() => { setEnter(null); setClientPhase("left"); }} />
        <PhoneFallback phone={phone} />
      </Shell>
    );
  }

  if (phase === "left") {
    return (
      <Shell>
        <Message icon={<CircleCheck className="size-5" />} title="You left the call">
          <p className="text-muted-foreground text-sm">If that was a mistake, you can join again.</p>
          {joinError ? <p role="alert" className="text-destructive-foreground text-sm">{joinError}</p> : null}
          <Button size="lg" loading={entering} onClick={() => void joinCall()}>Join again</Button>
        </Message>
        <PhoneFallback phone={phone} />
      </Shell>
    );
  }

  switch (status.state) {
    case "not_video":
      return (
        <Shell>
          <Message icon={<Video className="size-5" />} title="This visit is not a video call">
            <p className="text-muted-foreground text-sm">There is nothing to join online. Your confirmation message says where to go or who will call you.</p>
          </Message>
          <PhoneFallback phone={phone} />
        </Shell>
      );
    case "cancelled":
      return (
        <Shell>
          <Message icon={<CalendarClock className="size-5" />} title="This visit was cancelled">
            <p className="text-muted-foreground text-sm">There is no call to join. Phone us if you want to book another time.</p>
          </Message>
          <PhoneFallback phone={phone} />
        </Shell>
      );
    case "ended":
      return (
        <Shell>
          <Message icon={<CircleCheck className="size-5" />} title="This visit has ended">
            <p className="text-muted-foreground text-sm">The link no longer opens a call. Phone us if you still need something.</p>
          </Message>
          <PhoneFallback phone={phone} />
        </Shell>
      );
    case "not_open_yet":
      return (
        <Shell>
          <NotOpenYet status={status} summary={summary} token={token} />
          <PhoneFallback phone={phone} />
        </Shell>
      );
    case "preparing":
      return (
        <Shell>
          <Message icon={<Clock className="size-5" />} title="Getting the room ready…">
            {summary}
            <p role="status" className="flex items-center gap-2 text-muted-foreground text-sm">
              <Spinner aria-hidden="true" className="motion-reduce:animate-none" /> This usually takes under a minute. This page updates by itself.
            </p>
          </Message>
          <PhoneFallback phone={phone} />
        </Shell>
      );
    case "open":
      break;
  }

  if (phase === "check") {
    return (
      <Shell>
        <Message icon={<Video className="size-5" />} title="Get ready for your video visit">
          {summary}
        </Message>
        {joinError ? (
          <Alert variant="error">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>{joinError}</AlertDescription>
          </Alert>
        ) : null}
        <DeviceCheck onContinue={() => void imReady()} continuing={waiting} continueLabel="I'm ready" />
        <PhoneFallback phone={phone} />
      </Shell>
    );
  }

  // Waiting room (or the moment between "let in" and the call opening).
  return (
    <Shell>
      <Message icon={<Clock className="size-5" />} title={admitted ? "You're being let in…" : "You're in the waiting room"}>
        {summary}
        <p role="status" className="flex items-center gap-2 text-base">
          {admitted ? (
            <><Spinner aria-hidden="true" className="motion-reduce:animate-none" /> Opening the call…</>
          ) : status.staffPresent ? (
            <>{status.staffName} is here and will let you in shortly.</>
          ) : (
            <>{status.staffName} has not joined yet.</>
          )}
        </p>
        <p className="text-muted-foreground text-sm">Keep this page open. The call starts by itself.</p>
      </Message>
      {joinError ? (
        <Alert variant="error">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>The call did not open</AlertTitle>
          <AlertDescription className="flex flex-col gap-3">
            <span>{joinError}</span>
            <span><Button variant="outline" loading={entering} onClick={() => void joinCall()}>Try again</Button></span>
          </AlertDescription>
        </Alert>
      ) : null}
      {offline ? <p role="status" className="text-muted-foreground text-xs">Reconnecting…</p> : null}
      <PhoneFallback phone={phone} />
    </Shell>
  );
}

function NotOpenYet({ status, summary, token }: { status: VisitStatusView; summary: ReactNode; token: string }) {
  const now = useNow(true);
  const left = Date.parse(status.opensAt) - now;
  return (
    <Message icon={<CalendarClock className="size-5" />} title={`Opens at ${formatViewerTime(status.opensAt)}`}>
      {summary}
      <p className="text-base tabular-nums">{left > 0 ? `That is in ${formatCountdown(left)}.` : "It is opening now."}</p>
      <p className="text-muted-foreground text-sm">You can join from 15 minutes before the start. This page updates by itself.</p>
      <Button variant="outline" render={<a href={`/visit/${encodeURIComponent(token)}?test=1`} />}>Test your camera</Button>
    </Message>
  );
}
