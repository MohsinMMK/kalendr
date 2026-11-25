"use client";

import { CalendarDays, Plus, X } from "lucide-react";
import { useState } from "react";

import { dateFromKey, keyFromDate } from "@/components/date-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { dayRangesSchema, type DateOverride, type TimeRange } from "@/lib/availability-setup";

import { nextRange, summariseDay } from "./schedule-ranges";
import { RangeRow } from "./weekly-ranges-editor";

const dayFormat = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

export function overrideLabel(date: string): string {
  const parsed = dateFromKey(date);
  return parsed ? dayFormat.format(parsed) : date;
}

/** Past overrides are kept on the server but not shown. */
export function upcomingOverrides(overrides: readonly DateOverride[], today: string): DateOverride[] {
  return overrides.filter((entry) => entry.date >= today).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Date overrides: pick one or more days on the calendar, then give them other hours or close them.
 * An override wins over the weekly pattern for that day.
 */
export function ScheduleOverrides({ overrides, today, disabled, saving, onApply, onRemove }: {
  overrides: readonly DateOverride[];
  today: string;
  disabled?: boolean;
  saving?: boolean;
  onApply: (dates: string[], ranges: TimeRange[] | null) => Promise<void> | void;
  onRemove: (date: string) => Promise<void> | void;
}) {
  const [dates, setDates] = useState<Date[]>([]);
  const [closed, setClosed] = useState(true);
  const [ranges, setRanges] = useState<TimeRange[]>([{ start: "09:00", end: "13:00" }]);
  const upcoming = upcomingOverrides(overrides, today);
  const rangeIssue = closed ? null : (dayRangesSchema.safeParse(ranges).error?.issues[0]?.message ?? null);
  const minDate = dateFromKey(today);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-[auto_1fr]">
        <div className="flex justify-center rounded-xl border p-2">
          <Calendar mode="multiple" selected={dates} onSelect={(next: Date[] | undefined) => setDates(next ?? [])} disabled={minDate ? { before: minDate } : undefined} />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {dates.length === 0 ? "Pick one or more days." : `${dates.length} day${dates.length === 1 ? "" : "s"} picked.`}
          </p>
          <Label className="min-h-11 justify-between gap-3 font-medium">
            Closed on these days
            <Switch checked={closed} onCheckedChange={setClosed} disabled={disabled} />
          </Label>
          {closed ? null : (
            <div className="flex flex-col gap-2">
              {ranges.map((range, index) => (
                <RangeRow
                  key={index}
                  label={`Override range ${index + 1}`}
                  range={range}
                  disabled={disabled}
                  onChange={(patch) => setRanges((current) => current.map((entry, position) => position === index ? { ...entry, ...patch } : entry))}
                  onRemove={ranges.length > 1 ? () => setRanges((current) => current.filter((_, position) => position !== index)) : undefined}
                />
              ))}
              <Button type="button" variant="outline" size="sm" className="self-start" disabled={disabled} onClick={() => setRanges((current) => [...current, nextRange(current)])}>
                <Plus aria-hidden="true" /> Add a range
              </Button>
              {rangeIssue ? <p role="alert" className="text-xs text-destructive-foreground">{rangeIssue}</p> : null}
            </div>
          )}
          <Button
            type="button"
            className="self-start"
            disabled={disabled || saving || dates.length === 0 || Boolean(rangeIssue)}
            onClick={async () => {
              await onApply(dates.map(keyFromDate).sort(), closed ? null : ranges);
              setDates([]);
            }}
          >
            {saving ? <Spinner aria-hidden="true" /> : null}
            {saving ? "Saving…" : "Set these days"}
          </Button>
        </div>
      </div>

      {upcoming.length === 0 ? (
        <Empty className="py-6">
          <EmptyHeader>
            <EmptyMedia variant="icon"><CalendarDays aria-hidden="true" /></EmptyMedia>
            <EmptyDescription>No date changes coming up. The weekly pattern applies every day.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border" aria-label="Upcoming date changes">
          {upcoming.map((entry) => (
            <li key={entry.date} className="flex min-h-12 items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{overrideLabel(entry.date)}</p>
                <p className="text-xs text-muted-foreground">{entry.ranges === null ? "Closed" : summariseDay(entry.ranges)}</p>
              </div>
              <Button type="button" variant="ghost" size="icon-lg" aria-label={`Remove the change on ${overrideLabel(entry.date)}`} disabled={disabled} onClick={() => void onRemove(entry.date)}><X aria-hidden="true" /></Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
