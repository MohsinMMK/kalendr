"use client";

import { CalendarDays, CalendarRange, Columns3, Globe, type LucideIcon } from "lucide-react";
import { useMemo, type FocusEvent } from "react";

import { Combobox, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxPopup } from "@/components/ui/combobox";
import { Label } from "@/components/ui/label";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import { allTimeZones, layoutLabels, timeZoneNotice, zoneCity, type BookingLayout } from "@/lib/booking-page";

import { useTerms } from "../terms/business-profile-context";
import type { BookingDisplay } from "./use-booking-display";

const layoutIcons: Record<BookingLayout, LucideIcon> = { month: CalendarDays, week: CalendarRange, column: Columns3 };

/**
 * The line above the times: which layout, and one sentence when the visitor's time differs from the business's.
 * In the week and column layouts it also holds the time zone and the 12h / 24h buttons; the month layout puts the
 * zone under the calendar and the buttons beside the chosen day (`MonthView`). The sentence sits in a polite live
 * region that stays mounted, so changing the zone is spoken.
 */
export function PickerHeader({ id, display, settingsInPanel = false }: {
  id: string;
  display: BookingDisplay;
  /** From 1024px the booking side panel carries the time zone and clock, so they show here only below that. */
  settingsInPanel?: boolean;
}) {
  const t = useTerms();
  const notice = timeZoneNotice(display.zone, display.businessZone, t.business);
  const spoken = notice ?? `Times shown in ${zoneCity(display.zone)} time.`;
  const month = display.layout === "month";
  const showLayouts = display.layouts.length > 1;

  return (
    <div className="flex flex-col gap-3">
      <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-3", month && !showLayouts && "hidden", month && "max-md:hidden")}>
        {showLayouts ? (
          // Week and columns fall back to the month on a phone, so the switch is only offered from tablet width up.
          // Icons only, in the card's corner; each one is named for screen readers and keyboard users.
          <SegmentedControl
            size="sm"
            className="order-last ms-auto max-md:hidden"
            render={
              <RadioGroupPrimitive
                aria-label="View"
                value={display.layout}
                onValueChange={(next: unknown) => display.onLayoutChange(next as BookingLayout)}
              />
            }
          >
            {display.layouts.map((layout) => {
              const Icon = layoutIcons[layout];
              return (
                <SegmentedControlItem key={layout} className="min-h-11 min-w-11 justify-center" render={<RadioPrimitive.Root value={layout} aria-label={layoutLabels[layout]} title={layoutLabels[layout]} />}>
                  <Icon aria-hidden="true" className="size-4" />
                </SegmentedControlItem>
              );
            })}
          </SegmentedControl>
        ) : null}

        {month ? null : (
          <>
            <ZoneSetting id={`${id}-zone`} display={display} className={cn("flex-1 basis-56 sm:max-w-72", settingsInPanel && "lg:hidden")} />
            <ClockToggle display={display} className="mb-0.5" />
          </>
        )}
      </div>
      <p role="status" aria-live="polite" className={notice ? "text-muted-foreground text-sm" : "sr-only"}>
        {spoken}
      </p>
    </div>
  );
}

/** The visitor's time zone, searchable. Used above the times and in the booking side panel. */
export function TimeZoneField({ id, display, className, compact = false }: { id: string; display: BookingDisplay; className?: string; compact?: boolean }) {
  const zones = useMemo(() => {
    const list = allTimeZones();
    return list.includes(display.zone) ? list : [display.zone, ...list];
  }, [display.zone]);
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label htmlFor={id} className={compact ? "sr-only" : "text-muted-foreground text-xs"}>Time zone</Label>
      <Combobox items={zones} value={display.zone} onValueChange={(next: string | null) => next && display.onZoneChange(next)}>
        <ComboboxInput
          id={id}
          placeholder="Search time zones"
          startAddon={<Globe />}
          triggerProps={{ "aria-label": "Show time zones" }}
          // The zone's name is selected on focus, so typing starts a search instead of adding to it.
          onFocus={(event: FocusEvent<HTMLInputElement>) => event.currentTarget.select()}
        />
        <ComboboxPopup>
          <ComboboxEmpty>No time zone found.</ComboboxEmpty>
          <ComboboxList>
            {(zone: string) => (
              <ComboboxItem key={zone} value={zone}>{zone.replaceAll("_", " ")}</ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}

/** The time zone to show times in, or one sentence when in-person times are fixed to the business's clock. */
export function ZoneSetting({ id, display, className }: { id: string; display: BookingDisplay; className?: string }) {
  const t = useTerms();
  return display.zoneLocked ? (
    <p className={cn("flex min-h-9 items-center gap-2 text-muted-foreground text-sm", className)}>
      <Globe aria-hidden="true" className="size-4 shrink-0" />
      In-person visits are shown in {zoneCity(display.businessZone)} time, so the times match the {t.business}&apos;s clock.
    </p>
  ) : (
    <TimeZoneField id={id} display={display} className={className} />
  );
}

/** 12-hour or 24-hour times, as two buttons (12h, 24h) like cal.com. */
export function ClockToggle({ display, className }: { display: BookingDisplay; className?: string }) {
  return (
    <SegmentedControl
      size="sm"
      className={className}
      render={
        <RadioGroupPrimitive
          aria-label="Clock"
          value={display.hour12 ? "12h" : "24h"}
          onValueChange={(next: unknown) => display.onHour12Change(next === "12h")}
        />
      }
    >
      <SegmentedControlItem render={<RadioPrimitive.Root value="12h" aria-label="12-hour clock" />}>12h</SegmentedControlItem>
      <SegmentedControlItem render={<RadioPrimitive.Root value="24h" aria-label="24-hour clock" />}>24h</SegmentedControlItem>
    </SegmentedControl>
  );
}
