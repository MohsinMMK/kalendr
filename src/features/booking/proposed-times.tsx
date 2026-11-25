"use client";

import { CalendarPlus, ChevronDown } from "lucide-react";
import { useId, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";
import type { TimeSlot } from "@/lib/domain";
import { MAX_PROPOSED_TIMES } from "@/lib/approval";

import { getDateKey } from "./booking-format";
import { formatClock, formatDayKey } from "./zone-time";

/** Open times that could be offered as other choices: same person, not the chosen time. Earliest first. */
export function proposableSlots(slots: TimeSlot[], chosen: TimeSlot | undefined): TimeSlot[] {
  if (!chosen) return [];
  return slots
    .filter((slot) => slot.id !== chosen.id && slot.startsAt !== chosen.startsAt && slot.practitionerId === chosen.practitionerId)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

/**
 * "These also work for me": a dropdown of other open times the customer can tick, up to ten. Shown only for services
 * that may wait for approval, so the business can offer one of them instead if the first time does not suit.
 */
export function ProposedTimes({
  options,
  selectedIds,
  onChange,
  locale,
  zone,
  hour12,
}: {
  options: TimeSlot[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  locale: string;
  zone: string;
  hour12?: boolean;
}) {
  const id = useId();
  const groups = useMemo(() => {
    const byDay = new Map<string, TimeSlot[]>();
    for (const slot of options) {
      const key = getDateKey(slot.startsAt, zone);
      byDay.set(key, [...(byDay.get(key) ?? []), slot]);
    }
    return [...byDay.entries()];
  }, [options, zone]);

  if (options.length === 0) return null;
  const full = selectedIds.length >= MAX_PROPOSED_TIMES;

  function toggle(slotId: string, checked: boolean) {
    onChange(checked ? [...selectedIds.filter((entry) => entry !== slotId), slotId] : selectedIds.filter((entry) => entry !== slotId));
  }

  return (
    <section aria-labelledby={`${id}-title`} className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-4">
      <h2 id={`${id}-title`} className="font-heading font-semibold text-base">
        These also work for me <span className="font-normal text-muted-foreground text-sm">(optional)</span>
      </h2>
      <p id={`${id}-hint`} className="text-muted-foreground text-sm">
        If we need to approve your booking, we can offer you any of these times instead.
      </p>
      <Popover>
        <PopoverTrigger
          render={
            <Button variant="outline" size="lg" className="w-full justify-between sm:w-fit" aria-describedby={`${id}-hint`}>
              <span className="flex items-center gap-2">
                <CalendarPlus aria-hidden="true" />
                {selectedIds.length === 0 ? "Choose other times" : `${selectedIds.length} other ${selectedIds.length === 1 ? "time" : "times"} chosen`}
              </span>
              <ChevronDown aria-hidden="true" />
            </Button>
          }
        />
        <PopoverPopup align="start" className="w-80 max-w-[calc(100vw-2rem)]" aria-label="Other times that work for you">
          <div className="flex w-full min-w-0 flex-col gap-3">
            <p className="text-muted-foreground text-xs" role="status">
              {selectedIds.length} of {MAX_PROPOSED_TIMES} chosen
            </p>
            <ScrollAreaPrimitive.Root className="min-h-0">
            <ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className="max-h-72 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ScrollAreaPrimitive.Content className="flex flex-col gap-3 pe-1" style={{ minWidth: 0 }}>
              {groups.map(([day, daySlots]) => (
                <fieldset key={day} className="flex min-w-0 flex-col gap-1">
                  <legend className="mb-1 font-medium text-sm">{formatDayKey(day, locale)}</legend>
                  <div className="grid grid-cols-2 gap-1.5">
                    {daySlots.map((slot) => {
                      const checked = selectedIds.includes(slot.id);
                      const time = formatClock(slot.startsAt, locale, zone, hour12);
                      return (
                        <Label key={slot.id} className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border px-3 tabular-nums has-data-checked:border-primary has-data-checked:bg-primary/4">
                          <Checkbox
                            checked={checked}
                            disabled={full && !checked}
                            onCheckedChange={(value) => toggle(slot.id, value)}
                            aria-label={`${formatDayKey(day, locale)}, ${time}`}
                          />
                          {time}
                        </Label>
                      );
                    })}
                  </div>
                </fieldset>
              ))}
            </ScrollAreaPrimitive.Content>
            </ScrollAreaPrimitive.Viewport>
            <ScrollBar orientation="vertical" />
            </ScrollAreaPrimitive.Root>
            {full ? <p className="text-muted-foreground text-xs">That is the most you can offer. Untick one to pick another.</p> : null}
          </div>
        </PopoverPopup>
      </Popover>
    </section>
  );
}
