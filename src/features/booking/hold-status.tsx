"use client";

import { ChevronDown, Clock3, LoaderCircle } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HOLD_MINUTES } from "@/lib/booking-page";
import { cn } from "@/lib/utils";

function clockText(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * One short row, "Time held for you · 4:32 left", that opens to say what the hold means. The ticking text is not
 * announced; a separate polite note speaks when the hold starts, at one minute left, and when it ends. The note stays
 * mounted so changes to it are heard.
 */
export function HoldStatus({ remainingSeconds, pending, held }: { remainingSeconds: number | null; pending: boolean; held: boolean }) {
  const [open, setOpen] = useState(false);
  // Derived, so the note changes only when the hold starts and when one minute is left.
  const announcement = !held
    ? ""
    : remainingSeconds !== null && remainingSeconds <= 60
      ? "One minute left on the time we are holding for you."
      : `We are holding this time for you for ${HOLD_MINUTES} minutes.`;

  return (
    <div>
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      {held && remainingSeconds !== null ? (
        <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg bg-muted/48">
          <CollapsibleTrigger
            render={<Button variant="ghost" className="h-10 w-full justify-between gap-3 rounded-lg px-3 font-normal hover:bg-muted" />}
          >
            <span className="flex min-w-0 items-center gap-2 whitespace-nowrap">
              <Clock3 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">Time held for you</span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
              <span aria-live="off" className="font-medium tabular-nums">{clockText(remainingSeconds)} left</span>
              <ChevronDown aria-hidden="true" className={cn("text-muted-foreground transition-transform", open && "rotate-180")} />
            </span>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <p className="px-3 pb-3 text-muted-foreground text-sm">
              Nobody else can book this time while you finish, for up to {HOLD_MINUTES} minutes. If the timer runs out, the time is
              released and you can pick again.
            </p>
          </CollapsiblePanel>
        </Collapsible>
      ) : pending ? (
        <p aria-live="off" className="flex h-10 items-center gap-2 px-3 text-muted-foreground text-sm">
          <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
          Holding this time for you…
        </p>
      ) : null}
    </div>
  );
}
