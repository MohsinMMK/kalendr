"use client";

import { ChartNoAxesColumn } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface TrackerCount {
  id: string;
  label: string;
  value: number;
  /** Draws the number in the warning colour, like a long wait. */
  attention?: boolean;
}

/**
 * Today at a glance, from a small button beside the queue's title: how many are booked, waiting, with someone and done,
 * then one bar per service with how many came for it. Numbers first, the fewest words possible.
 */
export function TodayTracker({ counts, services, serviceLabel, note }: {
  counts: TrackerCount[];
  /** Today's visits per service, most first. */
  services: { id: string; name: string; count: number }[];
  /** What a service is called in this business, for the bars' heading. */
  serviceLabel: string;
  /** One short line under the numbers, like the longest wait. */
  note?: string;
}) {
  const most = Math.max(1, ...services.map((item) => item.count));
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={<PopoverTrigger render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Today at a glance" />} />}
        >
          <ChartNoAxesColumn aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup>Today at a glance</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" className="w-72" aria-label="Today at a glance">
        <dl className="grid grid-cols-4 gap-1 text-center">
          {counts.map((item) => (
            <div key={item.id} className="flex flex-col-reverse gap-0.5 rounded-md bg-muted/50 px-1 py-2">
              <dt className="truncate text-[0.6875rem] text-muted-foreground">{item.label}</dt>
              <dd className={cn("text-xl font-semibold tabular-nums leading-none", item.attention && "text-warning-foreground")}>{item.value}</dd>
            </div>
          ))}
        </dl>
        {note ? <p className="mt-2 text-xs text-muted-foreground">{note}</p> : null}
        {services.length ? (
          <>
            <p className="mt-3 mb-1.5 text-xs font-medium text-muted-foreground">By {serviceLabel}</p>
            <ul className="flex flex-col gap-1.5">
              {services.map((item) => (
                <li key={item.id} className="grid grid-cols-[minmax(0,6.5rem)_1fr_auto] items-center gap-2 text-xs">
                  <span className="truncate">{item.name}</span>
                  <Meter value={item.count} max={most} aria-label={`${item.name}: ${item.count}`}>
                    <MeterTrack className="h-1.5"><MeterIndicator /></MeterTrack>
                  </Meter>
                  <span className="tabular-nums font-medium">{item.count}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
