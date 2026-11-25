"use client";

import Image from "next/image";
import { CalendarCheck2, CircleCheck } from "lucide-react";
import type { MouseEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Radio } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import type { Service } from "@/lib/domain";

import { serviceDotClass, serviceMeta } from "./booking-options";

export { serviceMeta };

/** A small dot in the service's own colour, so the card matches the staff calendar. */
function ColorDot({ service }: { service: Service }) {
  const classes = serviceDotClass(service);
  return classes ? <span aria-hidden="true" className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", classes)} /> : null;
}

interface ServiceCardProps {
  service: Service;
  /** Cards with pictures when any service has one; compact text rows when none do. */
  layout: "picture" | "text";
  onPick?: (event: MouseEvent<HTMLLabelElement>) => void;
}

/**
 * One service as a whole-card radio (the coss `p-radio-group-6` pattern): the
 * radio is hidden and the card shows the choice. Phone: a row with a small
 * picture. From 768px: a grid card with the picture on top.
 */
export function ServiceCard({ service, layout, onPick }: ServiceCardProps) {
  const isRequest = service.bookingMode === "request";
  // The coss Radio keeps its own position and size, so it is hidden from a wrapper.
  const radio = <span className="sr-only"><Radio id={`service-${service.id}`} value={service.id} /></span>;

  if (layout === "text") {
    return (
      <Label
        onClick={onPick}
        className="group relative flex min-h-14 w-full min-w-0 cursor-pointer items-start gap-3 rounded-xl border bg-card p-3.5 font-normal transition-colors hover:bg-accent/40 has-focus-visible:ring-2 has-focus-visible:ring-ring has-data-checked:border-primary/48 has-data-checked:bg-accent/50 has-data-checked:ring-2 has-data-checked:ring-primary/48"
      >
        {radio}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <ColorDot service={service} />
            <span className="font-medium text-foreground">{service.name}</span>
            {isRequest ? <Badge variant="outline">Request</Badge> : null}
          </span>
          <span className="text-muted-foreground text-sm tabular-nums">{serviceMeta(service)}</span>
          {service.description ? (
            <span className="line-clamp-1 text-muted-foreground text-sm md:text-xs">{service.description}</span>
          ) : null}
        </span>
        <CircleCheck className="mt-0.5 hidden size-5 shrink-0 text-primary group-has-data-checked:block" aria-hidden="true" />
      </Label>
    );
  }

  return (
    <Label
      onClick={onPick}
      className="group relative flex w-full min-w-0 cursor-pointer items-stretch gap-3 overflow-hidden rounded-xl border bg-card p-2.5 font-normal transition-colors hover:bg-accent/40 has-focus-visible:ring-2 has-focus-visible:ring-ring has-data-checked:border-primary/48 has-data-checked:bg-accent/50 has-data-checked:ring-2 has-data-checked:ring-primary/48 md:flex-col md:gap-0 md:p-0"
    >
      {radio}
      <span className="relative size-22 shrink-0 overflow-hidden rounded-lg bg-accent md:aspect-[4/3] md:size-auto md:w-full md:rounded-none">
        {service.imageUrl ? (
          <Image
            src={service.imageUrl}
            alt=""
            fill
            unoptimized
            sizes="(min-width: 1024px) 320px, (min-width: 768px) 50vw, 88px"
            className="object-cover transition-transform duration-300 motion-safe:group-hover:scale-[1.03]"
          />
        ) : (
          <span className="flex size-full items-center justify-center text-muted-foreground">
            <CalendarCheck2 className="size-6 md:size-8" aria-hidden="true" />
          </span>
        )}
        {isRequest ? (
          <Badge variant="outline" className="absolute top-2 left-2 bg-background/90 max-md:hidden">Request</Badge>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 md:justify-start md:p-4">
        <span className="flex items-start justify-between gap-2">
          <span className="flex min-w-0 items-start gap-2">
            <ColorDot service={service} />
            <span className="font-medium text-foreground">{service.name}</span>
          </span>
          <CircleCheck className="mt-0.5 hidden size-5 shrink-0 text-primary md:group-has-data-checked:block" aria-hidden="true" />
        </span>
        <span className="text-muted-foreground text-sm tabular-nums">{serviceMeta(service)}</span>
        {service.description ? (
          <span className={cn("line-clamp-1 text-muted-foreground text-sm md:line-clamp-2 md:text-xs")}>{service.description}</span>
        ) : null}
        {isRequest ? <Badge variant="outline" className="mt-1 w-fit md:hidden">Request</Badge> : null}
      </span>
    </Label>
  );
}
