"use client";

import { ChevronRight, Hourglass } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Progress, ProgressIndicator, ProgressTrack } from "@/components/ui/progress";
import type { SessionView } from "@/lib/classes-contracts";
import { cn } from "@/lib/utils";

import { seatsText, timeRange } from "./class-model";

/** How full a session is, as a bar and as words, so it never rests on colour alone. */
export function SeatsMeter({ session, className }: { session: Pick<SessionView, "seatsTaken" | "capacity" | "serviceName">; className?: string }) {
  const full = session.seatsTaken >= session.capacity;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-xs tabular-nums text-muted-foreground">{seatsText(session)}{full ? " (full)" : ""}</span>
      <Progress aria-label={`Seats taken in ${session.serviceName}`} value={Math.min(session.seatsTaken, session.capacity)} min={0} max={session.capacity}>
        <ProgressTrack><ProgressIndicator className={full ? "bg-warning" : undefined} /></ProgressTrack>
      </Progress>
    </div>
  );
}

/** One session in the week list. The whole card opens the roster. */
export function SessionCard({ session, zone, locationName, onOpen }: { session: SessionView; zone: string; locationName?: string; onOpen: () => void }) {
  const cancelled = session.status === "cancelled";
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="grid min-h-16 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl border bg-card p-3 text-start outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-20"
        aria-label={`${session.serviceName}, ${timeRange(session, zone)}, ${seatsText(session)}${cancelled ? ", cancelled" : ""}. Open the roster.`}
      >
        <span className="flex min-w-0 flex-col gap-2">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-medium">{session.serviceName}</span>
            {cancelled ? <StatusBadge tone="danger">Cancelled</StatusBadge> : null}
            {session.waiting > 0 && !cancelled ? <Badge variant="warning" size="lg"><Hourglass aria-hidden="true" />{session.waiting} waiting</Badge> : null}
          </span>
          <span className="truncate text-xs text-muted-foreground tabular-nums">{timeRange(session, zone)} · {session.teacherName}{locationName ? ` · ${locationName}` : ""}</span>
          {cancelled ? null : <SeatsMeter session={session} />}
        </span>
        <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
      </button>
    </li>
  );
}
