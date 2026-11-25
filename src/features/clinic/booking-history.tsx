"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, History, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Skeleton } from "@/components/ui/skeleton";
import { useTerms } from "@/features/terms/business-profile-context";
import type { HistoryEntry } from "@/lib/bookings-list";
import { cn } from "@/lib/utils";

import { appointmentDateTime } from "./clinic-format";

type LoadState = { status: "idle" } | { status: "loading" } | { status: "ready"; entries: HistoryEntry[] } | { status: "failed" };

/** "by Priya (staff)", "by the customer" or "automatically". */
export function historyActorLine(actor: HistoryEntry["actor"]): string {
  if (actor.type === "system") return "automatically";
  if (actor.type === "patient") return actor.name ? `by ${actor.name} (customer)` : "by the customer";
  return actor.name ? `by ${actor.name} (staff)` : "by staff";
}

export function HistoryTimeline({ entries }: { entries: HistoryEntry[] }) {
  return (
    <ol className="flex flex-col">
      {entries.map((entry, index) => {
        const quiet = entry.kind === "message";
        return (
          <li key={`${entry.at}-${entry.action}-${index}`} className="relative flex gap-3 pb-4 last:pb-0">
            {index < entries.length - 1 ? <span aria-hidden="true" className="absolute top-3 bottom-0 left-[3.5px] w-px bg-border" /> : null}
            <span aria-hidden="true" className={cn("relative mt-1.5 size-2 shrink-0 rounded-full", quiet ? "border border-muted-foreground/60 bg-background" : "bg-foreground")} />
            <div className="min-w-0 flex-1">
              <p className={cn("break-words text-sm", quiet ? "text-muted-foreground" : "font-medium")}>{entry.label}</p>
              {entry.detail ? <p className="break-words text-sm text-muted-foreground">{entry.detail}</p> : null}
              <p className="text-xs text-muted-foreground">{historyActorLine(entry.actor)} · <time dateTime={entry.at} className="tabular-nums">{appointmentDateTime(entry.at)}</time></p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * A "History" section at the bottom of a booking. It stays closed, and asks the server for the history only the first
 * time it is opened. Needs the database, so callers hide it in preview mode.
 */
export function BookingHistory({ appointmentId }: { appointmentId: string }) {
  const t = useTerms();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setState({ status: "loading" });
    fetch(`/api/staff/appointments/${encodeURIComponent(appointmentId)}/history`, { signal: abort.signal, headers: { Accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load the history.");
        const payload = (await response.json()) as { data?: HistoryEntry[] };
        if (!Array.isArray(payload.data)) throw new Error("Could not load the history.");
        setState({ status: "ready", entries: payload.data });
      })
      .catch(() => {
        if (!abort.signal.aborted) setState({ status: "failed" });
      });
  }, [appointmentId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && state.status === "idle") load();
  }

  const panelId = `history-${appointmentId}`;
  return (
    <section aria-label={`${t.Appointment} history`} className="lg:col-start-1">
      <Frame>
        <FrameHeader className="px-3 py-2">
          <h2 className="text-sm font-medium">
            <button type="button" aria-expanded={open} aria-controls={panelId} onClick={toggle} className="-mx-1 flex min-h-8 w-full items-center justify-between gap-2 rounded-md px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span className="flex items-center gap-2"><History aria-hidden="true" className="size-4 text-muted-foreground" />History</span>
              <ChevronDown aria-hidden="true" className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} />
            </button>
          </h2>
        </FrameHeader>
        {open ? (
          <FramePanel id={panelId} className="p-4">
            {state.status === "idle" || state.status === "loading" ? (
              <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading history">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/3" />
              </div>
            ) : state.status === "failed" ? (
              <Alert variant="error">
                <TriangleAlert aria-hidden="true" />
                <AlertDescription>
                  <p>The history could not be loaded.</p>
                  <Button size="sm" variant="outline" className="mt-2" onClick={load}>Retry</Button>
                </AlertDescription>
              </Alert>
            ) : state.entries.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon"><History aria-hidden="true" /></EmptyMedia>
                  <EmptyTitle>Nothing has happened yet</EmptyTitle>
                  <EmptyDescription>Changes to this {t.appointment} and messages sent about it will show here.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <HistoryTimeline entries={state.entries} />
            )}
          </FramePanel>
        ) : null}
      </Frame>
    </section>
  );
}
