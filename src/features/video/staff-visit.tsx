"use client";

import { ArrowLeft, CircleCheck, Clock, Ellipsis, PhoneCall, TriangleAlert, UserRound, Video } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { ActionMenuButton, type ActionMenuEntry } from "@/components/action-bar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import type { StaffVideoHostView, StaffVideoView, VisitEnterView } from "@/lib/video-contracts";

import { VideoCall } from "./video-call";
import { videoCall, VideoApiError } from "./video-api";
import { formatCountdown, formatViewerDay, formatViewerTime, useInterval, useNow } from "./video-shared";

const POLL_MS = 5_000;
const HEARTBEAT_MS = 20_000;

/** The staff side of a video visit: who is waiting, let them in, start the call. */
export function StaffVisit({ appointmentId }: { appointmentId: string }) {
  const t = useTerms();
  const path = `/api/staff/appointments/${encodeURIComponent(appointmentId)}/video`;
  const [status, setStatus] = useState<StaffVideoView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [enter, setEnter] = useState<VisitEnterView | null>(null);
  const [inCall, setInCall] = useState(false);
  const [busy, setBusy] = useState<"" | "host" | "admit" | "phone">("");
  const [actionError, setActionError] = useState("");
  const [sentCallUs, setSentCallUs] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setStatus(await videoCall<StaffVideoView>(path, { signal }));
      setLoadError("");
    } catch (cause: unknown) {
      if (signal?.aborted) return;
      setLoadError(cause instanceof Error ? cause.message : "The visit could not be loaded.");
    }
  }, [path]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => void load(controller.signal));
    return () => controller.abort();
  }, [load]);

  useInterval(() => {
    if (document.visibilityState === "visible") void load();
  }, POLL_MS, true);

  useInterval(() => {
    void videoCall<StaffVideoView>(path, { method: "POST", body: { action: "heartbeat" } })
      .then(setStatus)
      .catch(() => undefined);
  }, HEARTBEAT_MS, inCall);

  async function host() {
    setBusy("host");
    setActionError("");
    try {
      const view = await videoCall<StaffVideoHostView>(path, { method: "POST", body: { action: "host" } });
      setStatus(view.status);
      setEnter(view.enter);
      setInCall(true);
    } catch (cause: unknown) {
      setActionError(cause instanceof Error ? cause.message : "The call could not be started.");
    } finally {
      setBusy("");
    }
  }

  async function admit() {
    setBusy("admit");
    setActionError("");
    try {
      setStatus(await videoCall<StaffVideoView>(path, { method: "POST", body: { action: "admit" } }));
    } catch (cause: unknown) {
      setActionError(cause instanceof Error ? cause.message : `We could not let ${status?.customerFirstName ?? "them"} in.`);
    } finally {
      setBusy("");
    }
  }

  async function askToPhone() {
    setBusy("phone");
    try {
      await videoCall<unknown>(`/api/staff/appointments/${encodeURIComponent(appointmentId)}/messages`, {
        method: "POST",
        body: { kind: "call_us" },
        idempotencyKey: crypto.randomUUID(),
      });
      setSentCallUs(true);
      toastManager.add({ title: `Sent "Please call us" to ${status?.customerFirstName ?? t.customer}.`, type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: cause instanceof VideoApiError || cause instanceof Error ? cause.message : "The message could not be sent.", type: "error" });
    } finally {
      setBusy("");
    }
  }

  if (!status) {
    return (
      <Page>
        {loadError ? (
          <Alert variant="error">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>{loadError}</span>
              <Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>
            </AlertDescription>
          </Alert>
        ) : (
          <p role="status" className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
            <Spinner aria-hidden="true" className="motion-reduce:animate-none" /> Loading the visit…
          </p>
        )}
      </Page>
    );
  }

  const name = status.customerFirstName;
  const waiting = status.customerStage === "waiting";
  const admitted = status.customerStage === "admitted";
  const canHost = status.state === "open";

  const moreActions: ActionMenuEntry[] = [
    {
      id: "call-us",
      kind: "item",
      label: `${name} can't join? Ask them to phone us`,
      icon: <PhoneCall aria-hidden="true" />,
      disabled: busy === "phone" || sentCallUs,
      onSelect: () => void askToPhone(),
    },
  ];

  const customerBadge = admitted
    ? <Badge variant="success">Let in</Badge>
    : waiting
      ? <Badge variant="warning">Waiting</Badge>
      : status.customerPresent
        ? <Badge variant="info">On the page</Badge>
        : <Badge variant="outline">Not here yet</Badge>;

  const admitButton = waiting ? (
    <Button size="lg" loading={busy === "admit"} onClick={() => void admit()}>
      <CircleCheck aria-hidden="true" /> Let them in
    </Button>
  ) : null;

  if (inCall && enter) {
    return (
      <Page wide>
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate font-heading font-semibold text-lg">Video visit with {name}</h1>
            {customerBadge}
          </div>
          <div className="flex flex-nowrap items-center gap-2">
            {waiting ? <Button loading={busy === "admit"} onClick={() => void admit()}><CircleCheck aria-hidden="true" /> Let them in</Button> : null}
            <ActionMenuButton label="More actions" iconOnly icon={<Ellipsis aria-hidden="true" />} items={moreActions} />
          </div>
        </header>
        {waiting ? <p role="status" className="text-sm">{name} is waiting to be let in.</p> : null}
        {actionError ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{actionError}</AlertDescription></Alert> : null}
        <VideoCall enter={enter} businessPhone={status.businessPhone} onLeave={() => { setEnter(null); setInCall(false); }} />
      </Page>
    );
  }

  return (
    <Page>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="font-heading font-semibold text-2xl">Video visit with {name}</h1>
          <p className="text-muted-foreground text-sm tabular-nums">{formatViewerDay(status.startsAt)} at {formatViewerTime(status.startsAt)}</p>
        </div>
        {customerBadge}
      </header>

      {actionError ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{actionError}</AlertDescription></Alert> : null}
      {loadError ? <Alert variant="warning"><TriangleAlert aria-hidden="true" /><AlertDescription>{loadError}</AlertDescription></Alert> : null}

      <StateBody status={status} name={name} />

      {waiting ? (
        <p role="status" className="flex items-center gap-2 font-medium text-base"><UserRound className="size-4" aria-hidden="true" /> {name} is waiting</p>
      ) : status.state === "open" ? (
        <p className="text-muted-foreground text-sm">{status.customerPresent ? `${name} is on the page.` : `${name} has not opened the page yet.`}</p>
      ) : null}

      {canHost ? (
        <div className="flex flex-nowrap items-center gap-2">
          <Button size="lg" loading={busy === "host"} onClick={() => void host()}>
            <Video aria-hidden="true" /> Start the call
          </Button>
          {admitButton ? <Button size="lg" variant="outline" loading={busy === "admit"} onClick={() => void admit()}><CircleCheck aria-hidden="true" /> Let them in</Button> : null}
          <ActionMenuButton label="More actions" iconOnly icon={<Ellipsis aria-hidden="true" />} items={moreActions} />
        </div>
      ) : (
        <div className="flex flex-nowrap items-center gap-2">
          <ActionMenuButton label="More actions" iconOnly icon={<Ellipsis aria-hidden="true" />} items={moreActions} />
        </div>
      )}
      {sentCallUs ? <p role="status" className="text-muted-foreground text-sm">{name} was asked to phone the {t.business}.</p> : null}
    </Page>
  );
}

function StateBody({ status, name }: { status: StaffVideoView; name: string }) {
  const now = useNow(status.state === "not_open_yet");
  switch (status.state) {
    case "not_video":
      return <Info icon={<Video className="size-5" />} title="This is not a video visit">There is no call to open for this one.</Info>;
    case "cancelled":
      return <Info icon={<TriangleAlert className="size-5" />} title="This visit was cancelled">No call will be made.</Info>;
    case "ended":
      return <Info icon={<CircleCheck className="size-5" />} title="This visit has ended">The call can no longer be opened.</Info>;
    case "not_open_yet": {
      const left = Date.parse(status.opensAt) - now;
      return <Info icon={<Clock className="size-5" />} title={`Opens at ${formatViewerTime(status.opensAt)}`}>{left > 0 ? `That is in ${formatCountdown(left)}. ${name} can join from then.` : "It is opening now."}</Info>;
    }
    case "preparing":
      return (
        <Info icon={<Clock className="size-5" />} title="Getting the room ready…">
          <span role="status" className="flex items-center gap-2"><Spinner aria-hidden="true" className="motion-reduce:animate-none" /> This usually takes under a minute.</span>
        </Info>
      );
    case "open":
      return status.provider === "test"
        ? <Alert variant="warning"><TriangleAlert aria-hidden="true" /><AlertDescription>Test mode: nobody else can join. Connect a video account to talk to others.</AlertDescription></Alert>
        : null;
  }
}

function Info({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col items-start gap-2 rounded-xl border bg-card p-4" aria-label={title}>
      <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-full bg-accent text-muted-foreground">{icon}</span>
      <h2 className="font-medium text-base">{title}</h2>
      <div className="text-muted-foreground text-sm">{children}</div>
    </section>
  );
}

function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className={`mx-auto flex min-h-dvh w-full flex-col gap-4 px-4 py-5 ${wide ? "max-w-5xl" : "max-w-2xl"}`}>
      <div>
        <Button variant="ghost" size="sm" className="-ms-2" render={<a href="/schedule" />}><ArrowLeft aria-hidden="true" /> Back to schedule</Button>
      </div>
      {children}
    </main>
  );
}
