"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { classKeys, dayRange, fallbackZone, fetchSessions, seatsText, timeRange } from "./class-model";
import { useCatalogLookups } from "./clinic-catalog";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * The classes on the day the Schedule is showing (feature 18). Shows nothing when there are none, while loading, when
 * the list cannot be read, and in preview, so it never takes room from the schedule without something to say.
 */
export function ClassSessionsStrip({ dateKey }: { dateKey: string }) {
  const lookups = useCatalogLookups();
  const range = dayRange(dateKey);
  const query = useQuery({
    queryKey: classKeys.range(range.from, range.to),
    queryFn: ({ signal }) => fetchSessions(range.from, range.to, signal),
    enabled: lookups.database,
    retry: false,
  });
  const sessions = (query.data ?? []).filter((session) => session.status !== "cancelled");
  if (!lookups.database || sessions.length === 0) return null;
  return (
    <ScrollArea className="h-auto! shrink-0" clampContentMinWidth={false}>
    <section aria-label="Classes today" className="flex items-stretch gap-2 pb-1">
      {sessions.map((session) => (
        <Link
          key={session.id}
          href="/classes"
          className="flex min-h-11 min-w-44 shrink-0 flex-col justify-center gap-0.5 rounded-lg border bg-card px-3 py-1.5 text-xs outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{session.serviceName}</span><ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" /></span>
          <span className="truncate tabular-nums text-muted-foreground">{timeRange(session, lookups.getLocation(session.locationId)?.timezone ?? fallbackZone)} · {session.teacherName}</span>
          <span className="tabular-nums text-muted-foreground">{seatsText(session)}</span>
        </Link>
      ))}
    </section>
    </ScrollArea>
  );
}
