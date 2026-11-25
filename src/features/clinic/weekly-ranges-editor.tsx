"use client";

import { Copy, Plus, X } from "lucide-react";
import { useState } from "react";

import { TimePicker } from "@/components/reui/time-picker";
import { Button } from "@/components/ui/button";
import { Menu, MenuCheckboxItem, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { weekdayLabels, weekdays, type TimeRange, type Weekday, type WeeklyHours } from "@/lib/availability-setup";

import { addRange, allWeekdays, changeRange, copyDay, dayIssue, removeRange, workWeekdays } from "./schedule-ranges";

/** One range: two time pickers on a 15 minute grid and a remove button. */
export function RangeRow({ label, range, onChange, onRemove, disabled }: {
  label: string;
  range: TimeRange;
  onChange: (patch: Partial<TimeRange>) => void;
  onRemove?: () => void;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className="flex min-w-0 items-center gap-2">
      <TimePicker aria-label={`${label} starts at`} className="min-w-0 flex-1" hourCycle={12} minuteStep={15} disabled={disabled} value={range.start} onValueChange={(next) => next && onChange({ start: next })} />
      <span aria-hidden="true" className="text-xs text-muted-foreground">to</span>
      <TimePicker aria-label={`${label} ends at`} className="min-w-0 flex-1" hourCycle={12} minuteStep={15} disabled={disabled} value={range.end} onValueChange={(next) => next && onChange({ end: next })} />
      {onRemove ? (
        <Button type="button" variant="ghost" size="icon-lg" aria-label={`Remove ${label}`} disabled={disabled} onClick={onRemove}><X aria-hidden="true" /></Button>
      ) : null}
    </div>
  );
}

/**
 * The weekly pattern: each day lists its ranges, "+" adds one, "×" removes one, and "Copy" sends a
 * day's times to other days. Overlapping ranges are refused inline with the same sentence the server uses.
 */
export function WeeklyRangesEditor({ value, onChange, disabled }: { value: WeeklyHours; onChange: (next: WeeklyHours) => void; disabled?: boolean }) {
  const [copying, setCopying] = useState<Weekday | null>(null);
  const [picked, setPicked] = useState<Weekday[]>([]);

  return (
    <ul className="flex flex-col divide-y rounded-xl border">
      {weekdays.map((day) => {
        const ranges = value[day];
        const issue = dayIssue(ranges);
        const name = weekdayLabels[day];
        return (
          <li key={day} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-3 py-3">
            <div className="order-1 flex min-h-11 flex-1 items-center sm:w-32 sm:flex-none"><span className="text-sm font-medium">{name}</span></div>
            <div className="order-3 flex min-w-0 w-full flex-col gap-2 sm:order-2 sm:w-auto sm:flex-1">
              {ranges.length === 0 ? <p className="flex min-h-11 items-center text-xs text-muted-foreground">Closed</p> : null}
              {ranges.map((range, index) => (
                <RangeRow
                  key={`${day}-${index}`}
                  label={`${name} ${ranges.length > 1 ? `range ${index + 1}` : "hours"}`}
                  range={range}
                  disabled={disabled}
                  onChange={(patch) => onChange(changeRange(value, day, index, patch))}
                  onRemove={() => onChange(removeRange(value, day, index))}
                />
              ))}
              {issue ? <p role="alert" className="text-xs text-destructive-foreground">{issue}</p> : null}
            </div>
            <div className="order-2 flex items-center sm:order-3">
              <DayActions name={name} day={day} copying={copying} picked={picked} setCopying={setCopying} setPicked={setPicked} disabled={disabled} value={value} onChange={onChange} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function DayActions({ name, day, disabled, value, onChange, copying, picked, setCopying, setPicked }: {
  name: string;
  day: Weekday;
  disabled?: boolean;
  value: WeeklyHours;
  onChange: (next: WeeklyHours) => void;
  copying: Weekday | null;
  picked: Weekday[];
  setCopying: (day: Weekday | null) => void;
  setPicked: (days: Weekday[]) => void;
}) {
  const open = copying === day;
  const toggle = (other: Weekday, on: boolean) => {
    const next = on ? [...picked, other] : picked.filter((entry) => entry !== other);
    setPicked(next);
    if (on) onChange(copyDay(value, day, [other]));
  };
  return (
    <>
      <Button type="button" variant="ghost" size="icon-lg" aria-label={`Add a range on ${name}`} disabled={disabled} onClick={() => onChange(addRange(value, day))}><Plus aria-hidden="true" /></Button>
      <Menu open={open} onOpenChange={(next) => { setCopying(next ? day : null); setPicked([]); }}>
        <MenuTrigger render={<Button type="button" variant="ghost" size="icon-lg" aria-label={`Copy ${name}'s times to other days`} disabled={disabled || value[day].length === 0} />}><Copy aria-hidden="true" /></MenuTrigger>
        <MenuPopup align="end">
          <MenuGroupLabel>Copy {name}&apos;s times to…</MenuGroupLabel>
          <MenuItem onClick={() => { onChange(copyDay(value, day, workWeekdays)); setCopying(null); }}>All weekdays</MenuItem>
          <MenuItem onClick={() => { onChange(copyDay(value, day, allWeekdays)); setCopying(null); }}>Every day</MenuItem>
          <MenuSeparator />
          {weekdays.filter((other) => other !== day).map((other) => (
            <MenuCheckboxItem key={other} checked={picked.includes(other)} onCheckedChange={(on) => toggle(other, on)}>{weekdayLabels[other]}</MenuCheckboxItem>
          ))}
        </MenuPopup>
      </Menu>
    </>
  );
}
