"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { dateFromKey, keyFromDate } from "@/components/date-picker";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import type { Practitioner, TimeSlot } from "@/lib/domain";

import { formatClock } from "./zone-time";
import { formatShortDate } from "./booking-format";
import { ColumnView } from "./column-view";
import { MonthView } from "./month-view";
import { ClockToggle, PickerHeader, ZoneSetting } from "./picker-header";
import type { PickerViewProps } from "./picker-types";
import type { BookingDisplay } from "./use-booking-display";
import { WeekView } from "./week-view";
import { useEntrance } from "./booking-motion";
import {
  addDaysToKey,
  addMonthsToKey,
  dayStartUtc,
  startOfMonthKey,
  startOfWeekKey,
  todayKey,
  visitorFullDays,
} from "./zone-time";
import { getDateKey } from "./booking-format";

/** How far ahead the customer can browse when more times load as they page. */
export const BROWSE_DAYS = 180;

interface SlotPickerProps {
  id: string;
  name: string;
  slots: TimeSlot[];
  practitioners: Practitioner[];
  selectedSlotId?: string;
  onSelect: (slot: TimeSlot) => void;
  /** Called after a time is chosen (tap, click, Enter or Space), so the booking can move on. */
  onTimePicked?: () => void;
  locale: string;
  /** The business's zone. Times are shown in it unless `display` says otherwise. */
  timeZone: string;
  showPractitioner?: boolean;
  error?: string;
  /** A day ("YYYY-MM-DD") to show first, before anything is chosen. Ignored when it has no free times. */
  initialDate?: string;
  /** Days ("YYYY-MM-DD", in the business's zone) a booking limit filled. They are marked as full instead of looking closed. */
  fullDays?: string[];
  /**
   * Layout, zone and clock choices. With it the picker shows its header (layout switch, time zone, 24-hour clock).
   * Without it the picker is the plain calendar in the business's zone.
   */
  display?: BookingDisplay;
  /** Asks for the times in a range (instants in ms) when the customer pages to days that are not loaded yet. */
  onViewRange?: (range: { from: number; to: number }) => void;
  isFetching?: boolean;
  rangeError?: string;
  onRetryRange?: () => void;
  /** The booking side panel shows the time zone and clock from 1024px. */
  settingsInPanel?: boolean;
}

/** Date and time picker: month, week or columns, in the visitor's zone and clock. */
export function SlotPicker({
  id,
  name,
  slots,
  practitioners,
  selectedSlotId,
  onSelect,
  onTimePicked,
  locale,
  timeZone,
  showPractitioner = false,
  error,
  initialDate,
  settingsInPanel = false,
  fullDays = [],
  display,
  onViewRange,
  isFetching = false,
  rangeError,
  onRetryRange,
}: SlotPickerProps) {
  const zone = display?.zone ?? timeZone;
  const hour12 = display?.hour12;
  const weekStart = display?.weekStartsOn ?? 1;
  const layout = display?.shownLayout ?? "month";
  const today = useMemo(() => todayKey(zone), [zone]);

  const slotsByDay = useMemo(() => [...slots]
    .sort((first, second) => new Date(first.startsAt).getTime() - new Date(second.startsAt).getTime())
    .reduce<Map<string, TimeSlot[]>>((groups, slot) => {
      const key = getDateKey(slot.startsAt, zone);
      const current = groups.get(key) ?? [];
      current.push(slot);
      groups.set(key, current);
      return groups;
    }, new Map()), [slots, zone]);
  const personNames = useMemo(() => new Map(practitioners.map((person) => [person.id, person.name])), [practitioners]);
  const fullDayKeys = useMemo(
    () => new Set(visitorFullDays({ fullDays, businessZone: display?.businessZone ?? timeZone, displayZone: zone, openDayKeys: new Set(slotsByDay.keys()) })),
    [display?.businessZone, fullDays, slotsByDay, timeZone, zone],
  );

  const [browsedDate, setBrowsedDate] = useState<string>();
  // Month paging only holds while the active date is unchanged; any date change re-centres the calendar.
  const [pagedMonth, setPagedMonth] = useState<{ date?: string; month: Date }>();
  const selectedSlot = slots.find((slot) => slot.id === selectedSlotId);
  const selectedDate = selectedSlot ? getDateKey(selectedSlot.startsAt, zone) : undefined;
  const firstOpenDay = slotsByDay.keys().next().value as string | undefined;
  // With nothing chosen yet, the earliest open date is shown so times appear without a tap.
  const activeDate = browsedDate && slotsByDay.has(browsedDate)
    ? browsedDate
    : selectedDate ?? (initialDate && slotsByDay.has(initialDate) ? initialDate : firstOpenDay);
  const anchor = browsedDate ?? selectedDate ?? (initialDate && slotsByDay.has(initialDate) ? initialDate : firstOpenDay) ?? today;
  const openDays = [...slotsByDay.keys()].sort();
  const maxDay = onViewRange ? addDaysToKey(today, BROWSE_DAYS) : (openDays[openDays.length - 1] ?? today);

  const activeDay = activeDate ? dateFromKey(activeDate) : undefined;
  const shownMonth = pagedMonth && pagedMonth.date === activeDate ? pagedMonth.month : activeDay;

  // What is on screen decides which times to ask for.
  let range: { from: string; to: string };
  if (layout === "week") {
    const from = startOfWeekKey(anchor, weekStart);
    range = { from, to: addDaysToKey(from, 7) };
  } else if (layout === "column") {
    const from = anchor < today ? today : anchor;
    range = { from, to: addDaysToKey(from, 5) };
  } else {
    const from = startOfMonthKey(shownMonth ? keyFromDate(shownMonth) : today);
    range = { from, to: addMonthsToKey(from, 1) };
  }
  useEffect(() => {
    if (!onViewRange) return;
    onViewRange({ from: dayStartUtc(range.from, zone).getTime(), to: dayStartUtc(range.to, zone).getTime() });
  }, [onViewRange, range.from, range.to, zone]);

  const errorId = error ? `${id}-error` : undefined;
  // Switching between month, week and columns settles the new layout gently into place.
  const layoutRef = useRef<HTMLDivElement>(null);
  useEntrance(layoutRef, layout);
  const view: PickerViewProps = {
    id,
    name,
    slotsByDay,
    zone,
    locale,
    hour12,
    weekStartsOn: weekStart,
    today,
    maxDay,
    fullDays: fullDayKeys,
    personNames,
    showPractitioner,
    selectedSlotId,
    anchor,
    onAnchorChange: (day) => {
      setPagedMonth(undefined);
      setBrowsedDate(day);
    },
    // A click on a time is a tap, Enter or Space; the arrows only move focus, so every choice moves on.
    onChoose: (slot) => {
      onSelect(slot);
      onTimePicked?.();
    },
    describedBy: errorId,
    loading: isFetching,
  };

  const monthHasTimes = openDays.some((day) => day >= range.from && day < range.to);
  const selectedOutOfView = selectedSlot && selectedDate !== undefined && (
    layout === "month" ? selectedDate !== activeDate : selectedDate < range.from || selectedDate >= range.to
  );
  const hasAnything = slotsByDay.size > 0 || Boolean(onViewRange);

  return (
    <div id={id} tabIndex={-1} className="flex min-w-0 flex-col gap-3 outline-none" aria-describedby={errorId}>
      {display ? <PickerHeader id={id} display={display} settingsInPanel={settingsInPanel} /> : null}
      {hasAnything ? (
        <div ref={layoutRef} className="min-w-0">
          {layout === "week" ? <WeekView view={view} /> : null}
          {layout === "column" ? <ColumnView view={view} /> : null}
          {layout === "month" ? (
            <MonthView
              view={view}
              activeDate={activeDate}
              onDateChange={(day) => {
                setPagedMonth(undefined);
                setBrowsedDate(day);
              }}
              month={shownMonth}
              onMonthChange={(month) => setPagedMonth({ date: activeDate, month })}
              firstMonth={onViewRange ? dateFromKey(startOfMonthKey(today)) : dateFromKey(openDays[0] ?? today)}
              lastMonth={dateFromKey(maxDay)}
              belowCalendar={display ? <ZoneSetting id={`${id}-zone`} display={display} className={settingsInPanel ? "lg:hidden" : undefined} /> : undefined}
              timesAside={display ? <ClockToggle display={display} /> : undefined}
            />
          ) : null}
        </div>
      ) : null}
      {onViewRange ? (
        <p role="status" aria-live="polite" className="min-h-4 text-muted-foreground text-xs">
          {isFetching ? "Loading more times…" : !monthHasTimes && layout === "month" ? "No openings this month. Try another month." : ""}
        </p>
      ) : null}
      {rangeError ? (
        <div className="flex flex-wrap items-center gap-2 text-sm" role="alert">
          <span>{rangeError}</span>
          {onRetryRange ? <Button variant="outline" size="sm" onClick={onRetryRange}>Try again</Button> : null}
        </div>
      ) : null}
      {selectedSlot && selectedOutOfView ? (
        <p className="text-muted-foreground text-sm tabular-nums">
          Selected: {formatShortDate(selectedSlot.startsAt, locale, zone)} at {formatClock(selectedSlot.startsAt, locale, zone, hour12)}.{" "}
          <Button
            variant="link"
            className="h-auto px-0"
            onClick={() => {
              setPagedMonth(undefined);
              setBrowsedDate(selectedDate);
            }}
          >
            View selected time
          </Button>
        </p>
      ) : null}
      {error ? (
        <Field invalid>
          <FieldError id={`${id}-error`} match className="font-medium text-sm">
            {error}
          </FieldError>
        </Field>
      ) : null}
    </div>
  );
}
