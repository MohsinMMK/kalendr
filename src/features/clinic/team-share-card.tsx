"use client";

import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";

import { OptionSelect } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Skeleton } from "@/components/ui/skeleton";
import type { TeamShareView } from "@/lib/routing-contracts";

import { StaffApiError, staffQuery } from "./queries/http";
import { staffKeys } from "./queries/keys";

function monthValue(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** The current month and the five before it, newest first. */
export function recentMonths(now = new Date()): Array<{ value: string; label: string }> {
  return Array.from({ length: 6 }, (_, back) => {
    const date = new Date(now.getFullYear(), now.getMonth() - back, 1);
    return { value: monthValue(date), label: date.toLocaleDateString("en", { month: "long", year: "numeric" }) };
  });
}

/** Share of a month's bookings per person, next to the share each was meant to take. */
export function TeamShareCard() {
  const months = recentMonths();
  const [month, setMonth] = useState(months[0]!.value);
  const query = useQuery({
    queryKey: [...staffKeys.all, "routing", "share", month] as const,
    queryFn: ({ signal }) => staffQuery<TeamShareView>(`/api/staff/routing/share?month=${month}`, signal),
  });
  const data = query.data;

  return (
    <Frame>
      <FrameHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-56">
          <FrameTitle>Share of bookings this month</FrameTitle>
          <FrameDescription>How many bookings each person took, against the share they were meant to take.</FrameDescription>
        </div>
        <div className="w-44 max-sm:w-full">
          <OptionSelect aria-label="Month" value={month} onValueChange={(next) => next && setMonth(next)} options={months} />
        </div>
      </FrameHeader>
      <FramePanel>
        {query.isPending ? (
          <div role="status" aria-label="Loading share of bookings" className="flex flex-col gap-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
        ) : query.isError ? (
          <Alert variant="error">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>
              <p>{query.error instanceof StaffApiError || query.error instanceof Error ? query.error.message : "Something went wrong."}</p>
              <Button type="button" size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void query.refetch()}>Retry</Button>
            </AlertDescription>
          </Alert>
        ) : !data || data.total === 0 ? (
          <p className="text-muted-foreground text-sm">No bookings yet this month.</p>
        ) : (
          <div className="flex flex-col gap-4">
            <ul className="flex flex-col gap-3">
              {data.people.map((person) => (
                <li key={person.practitionerId} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate font-medium">{person.name}</span>
                    <span className="shrink-0 text-muted-foreground text-xs">{person.bookings} {person.bookings === 1 ? "booking" : "bookings"}, {person.sharePercent}%</span>
                  </div>
                  <div
                    role="img"
                    aria-label={`${person.name}: ${person.sharePercent}% of bookings, meant to take ${person.weightPercent}%`}
                    className="relative h-2.5 w-full rounded-full bg-muted"
                  >
                    <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, Math.max(0, person.sharePercent))}%` }} />
                    <div className="absolute -top-0.5 h-3.5 w-0.5 rounded-full bg-foreground" style={{ left: `${Math.min(100, Math.max(0, person.weightPercent))}%` }} />
                  </div>
                  <p className="text-muted-foreground text-xs">Meant to take {person.weightPercent}%</p>
                </li>
              ))}
            </ul>
            <p className="border-t pt-3 text-sm">{data.total} {data.total === 1 ? "booking" : "bookings"} in total.</p>
          </div>
        )}
      </FramePanel>
    </Frame>
  );
}
