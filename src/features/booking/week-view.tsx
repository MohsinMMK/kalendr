"use client";

import { useMemo } from "react";

import type { PickerViewProps } from "./picker-types";
import { KloqPickerLoader } from "./kloq-picker-loader";
import { addDaysToKey, startOfWeekKey } from "./zone-time";

/** One week as a calendar of hours, like a diary: days across, times where they fall in the day. */
export function WeekView({ view }: { view: PickerViewProps }) {
  const start = startOfWeekKey(view.anchor, view.weekStartsOn);
  const thisWeek = startOfWeekKey(view.today, view.weekStartsOn);
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDaysToKey(start, index)), [start]);
  const nextStart = addDaysToKey(start, 7);
  const range = new Intl.DateTimeFormat(view.locale, { day: "numeric", month: "short", timeZone: "UTC" });
  const toDate = (key: string) => new Date(`${key}T00:00:00Z`);
  const label = range.formatRange(toDate(days[0]), toDate(days[6]));
  return (
    <KloqPickerLoader
      view={view}
      days={days}
      kind="week"
      label={label}
      previousLabel="Previous week"
      nextLabel="Next week"
      previousAnchor={start > thisWeek ? addDaysToKey(start, -7) : null}
      nextAnchor={nextStart <= view.maxDay ? nextStart : null}
    />
  );
}
