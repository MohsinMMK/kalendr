"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { createConstraints, Kloq, slotAllowed, type CalEvent, type KloqComponents } from "@/components/kloq";
import { dateFromKey, keyFromDate } from "@/components/date-picker";
import { Button } from "@/components/ui/button";
import type { TimeSlot } from "@/lib/domain";

import { formatShortDate } from "./booking-format";
import { openingConstraints, openingsAround, cellMinutesFor, visibleHours } from "./kloq-times";
import { PeriodNav } from "./period-nav";
import type { PickerViewProps } from "./picker-types";
import { addDaysToKey, dayStartUtc, formatClock, formatDayKey } from "./zone-time";

// The visitor only chooses a time: no editor opens, and nothing the grid hands back (a drag, a paste) is kept.
const components: Partial<KloqComponents> = { EventPanel: () => null };
const ignore = () => {};
/**
 * Kloq rounds a click to the nearest line, so with a coarser snap the bottom of a cell would land in the next one (half
 * of every 5-minute cell at a 5-minute snap). At one minute a click anywhere in a free cell lands inside it.
 */
const SNAP_MINUTES = 1;

/**
 * Week and column layouts: Kloq's "Booking calendar" example. Free time comes from our openings; everything else is
 * refused (hatched) through `constraints`. Clicking a free cell chooses that time, asking who first when several
 * people are free at that start.
 */
export default function KloqPicker({ view, days, kind, label, previousLabel, nextLabel, previousAnchor, nextAnchor }: {
  view: PickerViewProps;
  days: string[];
  /** "week" or the number of days side by side. */
  kind: "week" | number;
  label: string;
  previousLabel: string;
  nextLabel: string;
  previousAnchor: string | null;
  nextAnchor: string | null;
}) {
  const { zone } = view;
  const allSlots = useMemo(() => [...view.slotsByDay.values()].flat(), [view.slotsByDay]);
  const shownSlots = useMemo(() => days.flatMap((day) => view.slotsByDay.get(day) ?? []), [days, view.slotsByDay]);
  const cellMinutes = useMemo(() => cellMinutesFor(allSlots, zone), [allSlots, zone]);
  const { dayStartHour, dayEndHour } = useMemo(() => visibleHours(shownSlots, zone, cellMinutes), [shownSlots, zone, cellMinutes]);
  const minDate = useMemo(() => dayStartUtc(view.today, zone), [view.today, zone]);
  const constraints = useMemo(() => openingConstraints(allSlots, cellMinutes, minDate), [allSlots, cellMinutes, minDate]);
  // The same pure helpers the grid runs, to re-check the whole visit before choosing.
  const resolved = useMemo(() => createConstraints(constraints), [constraints]);

  const selected = allSlots.find((slot) => slot.id === view.selectedSlotId);
  const events = useMemo<CalEvent[]>(() => selected
    ? [{
      id: selected.id,
      title: `Your time${view.showPractitioner ? ` with ${view.personNames.get(selected.practitionerId) ?? "your choice"}` : ""}`,
      start: selected.startsAt,
      end: selected.endsAt,
      color: "emerald",
      readOnly: true,
    }]
    : [], [selected, view.personNames, view.showPractitioner]);

  const periodKey = `${days[0]}:${days.length}`;
  const [asking, setAsking] = useState<{ instant: number; options: TimeSlot[] }>();
  // The "who would you like to see" question belongs to the days it was asked on; turning the page drops it
  // (adjusted while rendering, as React's "you might not need an effect" guide shows, so paging back does not revive it).
  const [askedPeriod, setAskedPeriod] = useState(periodKey);
  if (askedPeriod !== periodKey) {
    setAskedPeriod(periodKey);
    setAsking(undefined);
  }
  const askingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (asking) askingRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [asking]);

  function choose(slot: TimeSlot) {
    setAsking(undefined);
    view.onChoose(slot, true);
  }

  const todayInView = days.includes(view.today);
  const hourHeight = Math.max(64, Math.round((32 * 60) / cellMinutes));
  const fullInView = days.filter((day) => view.fullDays.has(day) && !view.slotsByDay.has(day));
  const total = shownSlots.length;
  const openings = new Set(shownSlots.map((slot) => slot.startsAt)).size;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <PeriodNav
        label={label}
        previousLabel={previousLabel}
        nextLabel={nextLabel}
        canPrevious={previousAnchor !== null}
        canNext={nextAnchor !== null}
        onPrevious={() => previousAnchor && view.onAnchorChange(previousAnchor)}
        onNext={() => nextAnchor && view.onAnchorChange(nextAnchor)}
        status={view.loading ? "Loading times…" : `${openings} ${openings === 1 ? "opening" : "openings"}${fullInView.length > 0 ? ` · Fully booked: ${fullInView.map((day) => formatDayKey(day, view.locale, { weekday: "short", day: "numeric" })).join(", ")}` : ""}`}
      />
      <div
        role="group"
        aria-label={`Times for ${label}. Click a free time to choose it.`}
        aria-describedby={view.describedBy}
        aria-busy={view.loading}
        data-booking-grid=""
        data-today-in-view={todayInView || undefined}
        className="h-[32rem] max-h-[75dvh] min-h-0 overflow-hidden rounded-xl border bg-background"
      >
        <Kloq
          storage={false}
          persistence={false}
          designMode={false}
          commandPalette={false}
          responsive={false}
          workingHours={false}
          view={kind === "week" ? "week" : kind}
          date={dateFromKey(days[0])}
          onDateChange={(date) => {
            // Kloq's own arrow and PageUp/PageDown keys page the range; keep to the days that can be booked. A range
            // that starts before today but still reaches it starts from today, as the previous button does.
            const key = keyFromDate(date);
            if (key > view.maxDay || addDaysToKey(key, days.length) <= view.today) return;
            view.onAnchorChange(key < view.today ? view.today : key);
          }}
          weekStartsOn={view.weekStartsOn}
          displayTimeZone={zone}
          locale={view.locale}
          hour12={view.hour12}
          dayStartHour={dayStartHour}
          dayEndHour={dayEndHour}
          hourHeight={hourHeight}
          snapMinutes={SNAP_MINUTES}
          minEventMinutes={SNAP_MINUTES}
          constraints={constraints}
          components={components}
          events={events}
          onEventsChange={ignore}
          onEventClick={ignore}
          onSlotClick={(slot) => {
            if (slot.allDay || !slotAllowed(resolved, slot)) return;
            const instant = slot.start.getTime();
            const options = openingsAround(allSlots, instant, cellMinutes);
            if (options.length === 0) return;
            if (options.length === 1 || !view.showPractitioner) choose(options[0]);
            else setAsking({ instant, options });
          }}
        />
      </div>
      {asking ? (
        <div
          ref={askingRef}
          role="group"
          aria-labelledby={`${view.id}-who`}
          className="flex flex-col gap-2 rounded-xl border bg-card p-3"
          onKeyDown={(event) => { if (event.key === "Escape") setAsking(undefined); }}
        >
          <p id={`${view.id}-who`} className="font-medium text-sm">
            Who would you like to see on {formatShortDate(asking.options[0].startsAt, view.locale, zone)} at {formatClock(asking.options[0].startsAt, view.locale, zone, view.hour12)}?
          </p>
          <div className="flex flex-wrap gap-2">
            {asking.options.map((option) => (
              <Button key={option.id} variant="outline" className="min-h-11" onClick={() => choose(option)}>
                {view.personNames.get(option.practitionerId) ?? "Anyone"}
              </Button>
            ))}
            <Button variant="ghost" className="min-h-11" onClick={() => setAsking(undefined)}>Cancel</Button>
          </div>
        </div>
      ) : null}
      <span className="sr-only">{total === 0 ? "No free times in this period." : "Free times are the unshaded blocks."}</span>
    </div>
  );
}
