"use client";

import { useState } from "react";
import { BellRing, WifiOff } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import type { QueueTicketStatus } from "@/server/queue-screens";

import { usePoll } from "./use-poll";

const POLL_MS = 10_000;

/** One line on where the customer stands, in plain words. */
export function ticketHeadline(ticket: Pick<QueueTicketStatus, "state" | "ahead" | "calledTo">): { title: string; detail: string } {
  switch (ticket.state) {
    case "called": return { title: "It's your turn", detail: ticket.calledTo ? `Please go to ${ticket.calledTo} now.` : "Please go to the front desk now." };
    case "with": return { title: "You're being seen", detail: ticket.calledTo ? `With ${ticket.calledTo}.` : "Your visit has started." };
    case "done": return { title: "All done", detail: "Thank you for visiting." };
    case "left": return { title: "No longer in the queue", detail: "Ask at the front desk if this isn't right." };
    default:
      return ticket.ahead === 0
        ? { title: "You're next", detail: "Please stay close to the front desk." }
        : { title: `${ticket.ahead} ${ticket.ahead === 1 ? "person" : "people"} ahead of you`, detail: "We'll call your token number." };
  }
}

/** The customer's own page: their token, how many are ahead, a rough wait, and an opt-in message. */
export function QueueTicketView({ token, initial }: { token: string; initial: QueueTicketStatus }) {
  const url = `/api/public/queue/ticket/${encodeURIComponent(token)}`;
  const { data, setData, gone, offline } = usePoll<QueueTicketStatus>(url, initial, POLL_MS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function toggleNotify(next: boolean) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notifyWhenNext: next }) });
      if (!response.ok) throw new Error();
      setData(((await response.json()) as { data: QueueTicketStatus }).data);
    } catch {
      setError("Could not save that. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (gone) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-2 p-6 text-center">
        <h1 className="text-2xl font-semibold">This link has ended</h1>
        <p className="text-muted-foreground">Queue links work on the day of the visit only. Ask at the front desk if you need help.</p>
      </main>
    );
  }

  const headline = ticketHeadline(data);
  const waiting = data.state === "waiting";
  const turn = data.state === "called";
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 p-5">
      <header className="min-w-0">
        <p className="truncate font-semibold">{data.businessName}</p>
        <p className="truncate text-sm text-muted-foreground">{data.locationName}</p>
      </header>

      <section aria-live="polite" className={`flex flex-col items-center gap-1 rounded-3xl border-2 p-6 text-center ${turn ? "border-primary bg-primary/10" : "bg-muted/40"}`}>
        <p className="text-sm font-medium text-muted-foreground">Your token</p>
        <p className="text-8xl font-bold leading-none tabular-nums">{data.number}</p>
        <h1 className="mt-3 text-xl font-semibold">{headline.title}</h1>
        <p className="text-muted-foreground">{headline.detail}</p>
        {waiting && data.wait ? (
          <p className="mt-2 rounded-full bg-background px-3 py-1 text-sm font-medium tabular-nums">
            About {data.wait.low === 0 ? `up to ${data.wait.high}` : `${data.wait.low}–${data.wait.high}`} min
          </p>
        ) : null}
      </section>

      {waiting && data.canNotify ? (
        <label className="flex items-center justify-between gap-4 rounded-2xl border p-4">
          <span className="flex min-w-0 flex-col">
            <span className="font-medium">Tell me when I&rsquo;m next</span>
            <span className="text-sm text-muted-foreground">
              {data.notified ? "Sent. Please come back to the front desk." : "We'll send a message to the number you gave, so you can step out."}
            </span>
          </span>
          <Switch checked={data.notifyWhenNext} disabled={saving || data.notified} onCheckedChange={(next) => void toggleNotify(next)} />
        </label>
      ) : null}
      {turn ? (
        <Alert variant="info">
          <BellRing aria-hidden="true" />
          <AlertTitle>Token {data.number}</AlertTitle>
          <AlertDescription>Show this screen at the front desk if you&rsquo;re not sure where to go.</AlertDescription>
        </Alert>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
      {offline ? <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><WifiOff className="size-4" aria-hidden="true" />Reconnecting…</p> : null}
      <p className="mt-auto text-center text-xs text-muted-foreground">This page updates by itself. Times are a rough guide.</p>
    </main>
  );
}
