"use client";

import { useMemo } from "react";

import { useMediaQuery } from "./use-booking-display";
import { KloqPickerLoader } from "./kloq-picker-loader";
import type { PickerViewProps } from "./picker-types";
import { addDaysToKey } from "./zone-time";

/** Several days side by side, starting from the chosen day. Wide screens show five, narrower ones three. */
export function ColumnView({ view }: { view: PickerViewProps }) {
  const wide = useMediaQuery("(min-width: 1024px)");
  const count = wide ? 5 : 3;
  const start = view.anchor < view.today ? view.today : view.anchor;
  const days = useMemo(() => Array.from({ length: count }, (_, index) => addDaysToKey(start, index)), [count, start]);
  const next = addDaysToKey(start, count);
  const range = new Intl.DateTimeFormat(view.locale, { day: "numeric", month: "short", timeZone: "UTC" });
  const toDate = (key: string) => new Date(`${key}T00:00:00Z`);
  const previous = addDaysToKey(start, -count);
  return (
    <KloqPickerLoader
      view={view}
      days={days}
      kind={count}
      label={range.formatRange(toDate(days[0]), toDate(days[count - 1]))}
      previousLabel={`Previous ${count} days`}
      nextLabel={`Next ${count} days`}
      previousAnchor={start > view.today ? (previous < view.today ? view.today : previous) : null}
      nextAnchor={next <= view.maxDay ? next : null}
    />
  );
}
