"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MailCheck, RefreshCw, RotateCcw } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { TogglePrimitive } from "@/components/ui/toggle";
import { ToggleGroupPrimitive } from "@/components/ui/toggle-group";
import { useTerms } from "@/features/terms/business-profile-context";
import type { TermWords } from "@/lib/terminology";
import type { UndeliveredFilter, UndeliveredMessage } from "@/server/message-retry";

import { appointmentDateTime } from "./clinic-format";
import { messageReason } from "./message-reasons";
import { staffMutation, staffQuery } from "./staff-snapshot-provider";

const filters: { value: UndeliveredFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "failed", label: "Retrying" },
  { value: "dead_letter", label: "Gave up" },
];

function aboutLabel(eventType: string, t: TermWords): string {
  const labels: Record<string, string> = {
    "appointment.created": "Booking made",
    "appointment.confirm": "Booking confirmed",
    "appointment.reschedule": "Moved to a new time",
    "appointment.suggest": "New time suggested",
    "appointment.cancel": "Booking cancelled",
    "appointment.reminder": "Reminder",
    "appointment.review_request": "Review request",
    "record.shared": "Document ready",
  };
  return labels[eventType] ?? (eventType.startsWith("appointment.status.") ? `${t.Visit} update` : "Booking update");
}

/** Error codes in plain words. The worker stores codes only, never a provider's message. */
function reasonLabel(code: string | null): string {
  switch (code) {
    case null: return "No reason was recorded.";
    case "provider_not_configured": return "No WhatsApp, SMS or email provider is connected.";
    case "lease_expired_after_max_attempts": return "The sender stopped part-way too many times.";
    case "invalid_event":
    case "invalid_payload": return "The message could not be read.";
    case "retries_exhausted": return "It failed eight times in a row.";
    default: return messageReason(code) ?? `Failed: ${code.replace(/[_.]/g, " ")}.`;
  }
}

/**
 * Messages the worker could not send. "Retrying" ones are still being tried on a back-off;
 * "Gave up" ones stopped after eight attempts. "Try again" puts one back in the queue.
 * Shown only to people with `messages.retry`, and only against the real database.
 */
export function UndeliveredMessages({ patientName }: { patientName: (id: string | null) => string }) {
  const t = useTerms();
  const [filter, setFilter] = useState<UndeliveredFilter>("all");
  const [messages, setMessages] = useState<UndeliveredMessage[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState<string | null>(null);
  // The row and its button go away after a retry; keep keyboard focus in the panel.
  const refreshButton = useRef<HTMLButtonElement>(null);

  const load = useCallback(async (next: UndeliveredFilter, signal?: AbortSignal) => {
    setState("loading");
    setError("");
    try {
      const rows = await staffQuery<UndeliveredMessage[]>(`/api/staff/messages?status=${next}`, signal);
      setMessages(rows);
      setState("ready");
    } catch (cause: unknown) {
      if (signal?.aborted) return;
      setError(cause instanceof Error ? cause.message : "Messages that were not sent could not be loaded.");
      setState("error");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => void load(filter, controller.signal));
    return () => controller.abort();
  }, [filter, load]);

  async function tryAgain(message: UndeliveredMessage) {
    setRetrying(message.id);
    try {
      await staffMutation(`/api/staff/messages/${encodeURIComponent(message.id)}/retry`, "POST", { attemptCount: message.attemptCount }, { idempotencyKey: crypto.randomUUID() });
      setMessages((current) => current.filter((item) => item.id !== message.id));
      refreshButton.current?.focus();
      toastManager.add({ title: "Message queued again", description: `It goes out with the next send, usually within a few seconds.`, type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not try again", description: cause instanceof Error ? cause.message : "Refresh and try again.", type: "error" });
      void load(filter);
    } finally {
      setRetrying(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-56">
          <CardTitle render={<h2 />} className="text-base">Not sent</CardTitle>
          <CardDescription>Messages that failed. Kalendr retries on its own; after eight failed tries it gives up until someone tries again.</CardDescription>
        </div>
        <Button ref={refreshButton} variant="outline" size="sm" onClick={() => void load(filter)} disabled={state === "loading"}>
          <RefreshCw aria-hidden="true" />
          Refresh
        </Button>
      </CardHeader>
      <CardPanel className="flex flex-col gap-4">
        <SegmentedControl
          className="w-full"
          size="sm"
          render={<ToggleGroupPrimitive aria-label="Show messages that" value={[filter]} onValueChange={(next: string[]) => { if (next[0]) setFilter(next[0] as UndeliveredFilter); }} />}
        >
          {filters.map((item) => (
            <SegmentedControlItem key={item.value} className="flex-1" render={<TogglePrimitive value={item.value} />}>{item.label}</SegmentedControlItem>
          ))}
        </SegmentedControl>

        {state === "error" ? (
          <Alert variant="error">
            <AlertTitle>Could not load messages that were not sent</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {state === "loading" ? (
          <div role="status" aria-label="Loading messages that were not sent" className="flex flex-col gap-3">
            {[0, 1, 2].map((row) => <Skeleton key={row} className="h-14 w-full" />)}
          </div>
        ) : null}

        {state === "ready" && messages.length === 0 ? (
          <Empty className="py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon"><MailCheck aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{filter === "dead_letter" ? "Nothing has been given up on" : filter === "failed" ? "Nothing is being retried" : "Every message went out"}</EmptyTitle>
              <EmptyDescription>Messages that fail to send show up here, with a button to try again.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {state === "ready" && messages.length ? (
          <ol className="flex flex-col divide-y" aria-label="Messages that were not sent">
            {messages.map((message) => {
              const name = patientName(message.patientId);
              const about = aboutLabel(message.eventType, t);
              const busy = retrying === message.id;
              return (
                <li key={message.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="font-medium">{name}</p>
                    <p className="text-sm text-muted-foreground">
                      {about}
                      {message.startsAt ? <> · {appointmentDateTime(message.startsAt)}</> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">{reasonLabel(message.lastErrorCode)} {message.attemptCount} {message.attemptCount === 1 ? "try" : "tries"}.</p>
                    {message.appointmentId ? (
                      <Link href={`/appointments/${message.appointmentId}`} className="text-xs font-medium text-primary underline-offset-4 hover:underline">Open the {t.visit}</Link>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {message.status === "dead_letter"
                      ? <StatusBadge tone="danger">Gave up</StatusBadge>
                      : <StatusBadge tone="attention">Retrying</StatusBadge>}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void tryAgain(message)}
                      disabled={retrying !== null}
                      aria-label={`Try again: ${about} for ${name}`}
                    >
                      {busy ? <Spinner aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}
                      Try again
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : null}
      </CardPanel>
    </Card>
  );
}
