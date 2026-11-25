"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, DoorClosed, DoorOpen, ExternalLink, QrCode, Tv } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { qrCodePath } from "@/lib/check-in";
import type { JoinLinkResult, QueueDayReport } from "@/lib/queue-door-contracts";
import type { QueueLink } from "@/server/queue-screens";

import { staffMutation } from "./staff-snapshot-provider";

/** The QR and the full link, with copy and open. The link is shown once; it is stored hashed. */
function LinkView({ url, label }: { url: string; label: string }) {
  const qr = useMemo(() => qrCodePath(url), [url]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toastManager.add({ title: "Link copied", type: "success" });
    } catch {
      toastManager.add({ title: "Could not copy", description: "Select the link and copy it.", type: "error" });
    }
  }
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="rounded-xl border bg-white p-2">
        <svg role="img" aria-label={label} viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges" className="size-[200px]">
          <path d={qr.path} fill="#000" />
        </svg>
      </div>
      <div className="flex w-full gap-2">
        <Input readOnly value={url} aria-label="Link" onFocus={(event) => event.currentTarget.select()} className="font-mono text-xs" />
        <Button variant="outline" size="icon" aria-label="Copy link" onClick={() => void copy()}><Copy aria-hidden="true" /></Button>
        <Button variant="outline" size="icon" aria-label="Open link" render={<a href={url} target="_blank" rel="noreferrer noopener" />}><ExternalLink aria-hidden="true" /></Button>
      </div>
    </div>
  );
}

const absolute = (path: string) => `${window.location.origin}${path}`;

/**
 * Makes the waiting-room screen link. Asks first, because a new link turns the old screen off.
 * The link can't be shown again later, only replaced.
 */
export function ScreenLinkDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function close(next: boolean) {
    if (!next) {
      setUrl("");
      setError("");
    }
    onOpenChange(next);
  }

  async function make() {
    setSaving(true);
    setError("");
    try {
      const link = await staffMutation<QueueLink>("/api/staff/queue/screen-link", "POST", {});
      setUrl(absolute(link.path));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Could not make the link. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Waiting-room screen</DialogTitle>
          <DialogDescription>
            {url ? "Open this on the TV's browser. It shows token numbers only, never names." : "Shows who is being called and the next tokens on a TV or tablet."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          {url ? <LinkView url={url} label="Waiting-room screen link" /> : (
            <p className="text-sm text-muted-foreground">
              Making a new link turns off any screen using the old one. Do this the first time, or if the link was shared by mistake.
            </p>
          )}
          {error ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>{url ? "Done" : "Cancel"}</DialogClose>
          {url ? null : <Button loading={saving} onClick={() => void make()}><Tv aria-hidden="true" />Make screen link</Button>}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The customer's own queue link, made when opened, for them to scan at the desk. */
export function PhoneLinkDialog({ ticketId, number, onOpenChange }: { ticketId: string | null; number?: number; onOpenChange: (open: boolean) => void }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!ticketId) return;
    let live = true;
    staffMutation<QueueLink>(`/api/staff/queue/tickets/${encodeURIComponent(ticketId)}/link`, "POST", {})
      .then((link) => { if (live) setUrl(absolute(link.path)); })
      .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : "Could not make the link."); });
    return () => {
      live = false;
      setUrl("");
      setError("");
    };
  }, [ticketId]);

  return (
    <Dialog open={ticketId !== null} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Token {number ?? ""} · phone link</DialogTitle>
          <DialogDescription>They scan it to see their place in the queue and get a message when they&rsquo;re almost next.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          {url ? <LinkView url={url} label={`Queue link for token ${number ?? ""}`} /> : null}
          {!url && !error ? <div className="flex justify-center py-10"><Spinner /></div> : null}
          {error ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
          <p className="text-xs text-muted-foreground">Works today only. Making it again turns off the earlier link.</p>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Done</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * The door QR code: people who walk in scan it, give a first name and phone number and get a token.
 * The link is shown once; it is stored hashed. Making a new one turns off the printed code.
 */
export function DoorLinkDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [url, setUrl] = useState("");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function close(next: boolean) {
    if (!next) {
      setUrl("");
      setError("");
    }
    onOpenChange(next);
  }

  async function save(body: { newLink?: boolean; selfJoinEnabled?: boolean }) {
    setSaving(true);
    setError("");
    try {
      const result = await staffMutation<JoinLinkResult>("/api/staff/queue/join-link", "POST", body);
      if (result.link) setUrl(absolute(result.link.path));
      setEnabled(result.selfJoinEnabled);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Could not save that. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Door QR code</DialogTitle>
          <DialogDescription>
            {url ? "Print this or show it at the door. People who scan it join the queue from their own phone." : "Lets someone who walks in join the queue from their own phone, without waiting at the desk."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          {url ? <LinkView url={url} label="Door QR code link" /> : (
            <p className="text-sm text-muted-foreground">
              Making a new code turns off the one already printed. Do this the first time, or if the code was shared by mistake.
            </p>
          )}
          {enabled === null ? null : (
            <p className="text-sm text-muted-foreground">{enabled ? "Sign-ups from the door are on." : "Sign-ups from the door are off. The code shows a message to ask at the desk."}</p>
          )}
          {error ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Done</DialogClose>
          <Button variant="outline" loading={saving} onClick={() => void save({ selfJoinEnabled: enabled === false })}>
            {enabled === false ? <DoorOpen aria-hidden="true" /> : <DoorClosed aria-hidden="true" />}
            {enabled === false ? "Turn sign-ups on" : "Turn sign-ups off"}
          </Button>
          <Button loading={saving} onClick={() => void save({ newLink: true })}><QrCode aria-hidden="true" />{url ? "Make another" : "Make QR code"}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Closes today's queue: nobody new can join from the door and everyone still waiting is let go. */
export function CloseQueueDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTerms();
  const [reason, setReason] = useState("");
  const [report, setReport] = useState<QueueDayReport | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function close(next: boolean) {
    if (!next) {
      setReason("");
      setReport(null);
      setError("");
    }
    onOpenChange(next);
  }

  async function run() {
    setSaving(true);
    setError("");
    try {
      setReport(await staffMutation<QueueDayReport>("/api/staff/queue/close-day", "POST", { reason }));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Could not close the queue. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Close the queue for today</DialogTitle>
          <DialogDescription>
            {report ? "The queue is closed." : "No one new can join from the door. Everyone still waiting is let go and their visit is cancelled."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          {report ? (
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-muted-foreground">Tokens given</dt><dd className="tabular-nums">{report.issued}</dd>
              <dt className="text-muted-foreground">Seen</dt><dd className="tabular-nums">{report.served}</dd>
              <dt className="text-muted-foreground">Left or let go</dt><dd className="tabular-nums">{report.left}</dd>
              <dt className="text-muted-foreground">Average wait</dt><dd className="tabular-nums">{report.averageWaitMinutes === null ? "—" : `${report.averageWaitMinutes} min`}</dd>
            </dl>
          ) : (
            <Textarea aria-label="Why is the queue closing?" placeholder={`Why is it closing? For example: ${t.provider} called away`} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} />
          )}
          {error ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>{report ? "Done" : "Cancel"}</DialogClose>
          {report ? null : <Button variant="destructive" loading={saving} disabled={reason.trim().length < 3} onClick={() => void run()}>Close the queue</Button>}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
