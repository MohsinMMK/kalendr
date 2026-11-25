"use client";

import { useMemo, useRef, type ReactNode } from "react";

import { dateFromKey, keyFromDate } from "@/components/date-picker";
import { Calendar } from "@/components/ui/calendar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import { formatShortDate } from "./booking-format";
import type { PickerViewProps } from "./picker-types";
import { SlotButton } from "./slot-button";
import { useEntrance } from "./booking-motion";
import { useSlotGrid } from "./slot-grid";

const dayParts = [
  { id: "morning", label: "Morning", until: 12 },
  { id: "afternoon", label: "Afternoon", until: 17 },
  { id: "evening", label: "Evening", until: 24 },
] as const;

function hourIn(value: string, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(new Date(value));
  return Number.parseInt(hour, 10) || 0;
}

/** The calendar with open days enabled and the chosen day's times beside it. Based on the coss `p-calendar-19` composition. */
export function MonthView({ view, activeDate, onDateChange, month, onMonthChange, firstMonth, lastMonth, belowCalendar, timesAside }: {
  view: PickerViewProps;
  /** The day whose times are shown. */
  activeDate: string | undefined;
  onDateChange: (day: string) => void;
  /** The month the calendar shows. */
  month: Date | undefined;
  onMonthChange: (month: Date) => void;
  firstMonth: Date | undefined;
  lastMonth: Date | undefined;
  /** Under the calendar: the time zone. */
  belowCalendar?: ReactNode;
  /** Beside the chosen day above its times: the 12h / 24h buttons. The count of openings shows when there is none. */
  timesAside?: ReactNode;
}) {
  const timesRef = useRef<HTMLDivElement>(null);
  const dateSlots = useMemo(() => (activeDate ? view.slotsByDay.get(activeDate) : undefined) ?? [], [activeDate, view.slotsByDay]);
  const activeDay = activeDate ? dateFromKey(activeDate) : undefined;
  // Open days get a filled tile, as on cal.com; the chosen day keeps the solid primary fill instead.
  const openDates = useMemo(
    () => [...view.slotsByDay.keys()].filter((key) => key !== activeDate).flatMap((key) => dateFromKey(key) ?? []),
    [activeDate, view.slotsByDay],
  );
  const fullDayDates = useMemo(() => [...view.fullDays].flatMap((key) => dateFromKey(key) ?? []), [view.fullDays]);
  const timesLabelId = `${view.id}-times-label`;
  const groups = useMemo(
    () => dayParts
      .map((part, index) => {
        const start = index === 0 ? 0 : dayParts[index - 1].until;
        return {
          ...part,
          slots: dateSlots.filter((slot) => {
            const hour = hourIn(slot.startsAt, view.zone);
            return hour >= start && hour < part.until;
          }),
        };
      })
      .filter((group) => group.slots.length > 0),
    [dateSlots, view.zone],
  );
  const visibleIds = useMemo(() => groups.flatMap((group) => group.slots.map((slot) => slot.id)), [groups]);
  const { rootRef, tabStop, onKeyDown, onFocusSlot } = useSlotGrid({ visibleIds, selectedId: view.selectedSlotId, periodKey: activeDate ?? "" });
  // A new day's times rise in group by group; a new month's days slide in from the side it came from.
  useEntrance(rootRef, activeDate ?? "", { selector: "[data-time-group]", directional: true });
  const calendarRef = useRef<HTMLDivElement>(null);
  useEntrance(calendarRef, month ? keyFromDate(month).slice(0, 7) : "", { selector: "[role='grid']", directional: true });

  function showTimesOnPhone() {
    if (typeof window === "undefined" || !window.matchMedia?.("(max-width: 767px)").matches) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.requestAnimationFrame(() => timesRef.current?.scrollIntoView?.({ block: "start", behavior: reduce ? "auto" : "smooth" }));
  }

  return (
    <div className="flex max-md:flex-col">
      <div
        id={`${view.id}-date`}
        role="group"
        aria-labelledby={`${view.id}-date-label`}
        ref={calendarRef}
        className="flex shrink-0 flex-col items-center max-md:pb-3 md:pe-5"
      >
        <span id={`${view.id}-date-label`} className="sr-only">Choose a date</span>
        <Calendar
          // A big month, easy to tap: larger days from tablet up, and larger again on wide screens.
          className="[--cell-size:--spacing(11)] sm:[--cell-size:--spacing(12)] xl:[--cell-size:--spacing(14)] max-[22rem]:[--cell-size:--spacing(9)]"
          classNames={{
            caption_label: "text-base font-semibold",
            day_button: "mx-auto size-[calc(var(--cell-size)-0.25rem)] text-base",
          }}
          mode="single"
          required
          weekStartsOn={view.weekStartsOn}
          today={dateFromKey(view.today)}
          selected={activeDay}
          month={month}
          onMonthChange={onMonthChange}
          startMonth={firstMonth}
          endMonth={lastMonth}
          disabled={(date: Date) => !view.slotsByDay.has(keyFromDate(date))}
          modifiers={{ open: openDates, full: fullDayDates }}
          modifiersClassNames={{
            open: "[&>button]:bg-accent [&>button]:font-semibold [&>button]:text-foreground [&>button]:hover:bg-primary/12",
            full: "line-through decoration-muted-foreground/60",
          }}
          onSelect={(date: Date | undefined) => {
            if (!date) return;
            onDateChange(keyFromDate(date));
            showTimesOnPhone();
          }}
        />
        {view.fullDays.size > 0 ? (
          <p className="mt-2 max-w-64 text-center text-muted-foreground text-xs">Crossed-out days are fully booked.</p>
        ) : null}
        {belowCalendar ? <div className="mt-4 w-full empty:hidden">{belowCalendar}</div> : null}
      </div>
      {dateSlots.length > 0 ? (
        <div ref={timesRef} className="relative min-w-0 flex-1 max-md:scroll-mt-4">
          {/* From 768px the column scrolls beside the calendar. Phone: times flow with the page. */}
          <div className="max-md:border-t md:absolute md:inset-0">
            <ScrollArea className="h-full md:border-s" overscrollContain scrollbarGutter scrollFade>
              <div className="flex flex-col gap-3 pt-3 md:pt-0 md:pb-2">
                <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2 md:px-5">
                  <p id={timesLabelId} className="font-medium text-sm">
                    {formatShortDate(dateSlots[0].startsAt, view.locale, view.zone)}
                  </p>
                  <p role="status" className={timesAside ? "sr-only" : "text-muted-foreground text-xs tabular-nums"}>
                    {dateSlots.length} {dateSlots.length === 1 ? "opening" : "openings"}
                  </p>
                  {timesAside}
                </div>
                <div ref={rootRef} onKeyDown={onKeyDown}>
                <div
                  data-day-column={activeDate}
                  role="radiogroup"
                  aria-labelledby={timesLabelId}
                  aria-describedby={view.describedBy}
                  className="@container flex w-full flex-col items-stretch gap-4 md:px-5"
                >
                  {groups.map((group) => (
                    <div key={group.id} data-time-group className="flex flex-col gap-2">
                      <p className="font-medium text-muted-foreground text-xs">{group.label}</p>
                      <div className={cn("grid gap-2", view.showPractitioner ? "grid-cols-1 @[16rem]:grid-cols-2 @[30rem]:grid-cols-3" : "grid-cols-2 @[18rem]:grid-cols-3 @[30rem]:grid-cols-4")}>
                        {group.slots.map((slot) => (
                          <SlotButton
                            key={slot.id}
                            id={`${view.name}-${slot.id}`}
                            slotId={slot.id}
                            startsAt={slot.startsAt}
                            locale={view.locale}
                            zone={view.zone}
                            hour12={view.hour12}
                            person={view.personNames.get(slot.practitionerId)}
                            showPerson={view.showPractitioner}
                            selected={slot.id === view.selectedSlotId}
                            tabStop={slot.id === tabStop}
                            onFocusSlot={onFocusSlot}
                            onChoose={(slotId, viaPointer) => view.onChoose(slot, viaPointer)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                </div>
              </div>
            </ScrollArea>
          </div>
        </div>
      ) : null}
    </div>
  );
}
