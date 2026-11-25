"use client";

import { useId } from "react";
import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { TimePicker } from "@/components/reui/time-picker";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useTerms } from "@/features/terms/business-profile-context";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatClock, type HoursDraft } from "@/lib/working-hours";

import { minutesTime, timeMinutes } from "./schedule-availability";

const days = [
  { iso: 1, label: "Mon" },
  { iso: 2, label: "Tue" },
  { iso: 3, label: "Wed" },
  { iso: 4, label: "Thu" },
  { iso: 5, label: "Fri" },
  { iso: 6, label: "Sat" },
  { iso: 7, label: "Sun" },
];

const earliest = 6 * 60;
const latest = 22 * 60;
const step = 15;
const defaultLunch = { start: 13 * 60, end: 14 * 60 };

function clock(minutes: number) {
  return formatClock(minutesTime(minutes));
}

function duration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Keeps lunch inside the working day when the day shrinks, and drops it when it no longer fits. */
export function fitBreak(draft: HoursDraft): HoursDraft {
  if (!draft.breakStart || !draft.breakEnd) return draft;
  const start = Math.max(timeMinutes(draft.breakStart), timeMinutes(draft.start) + step);
  const end = Math.min(timeMinutes(draft.breakEnd), timeMinutes(draft.end) - step);
  if (end - start < step) return { ...draft, breakStart: null, breakEnd: null };
  return { ...draft, breakStart: minutesTime(start), breakEnd: minutesTime(end) };
}

function pair(value: number | readonly number[]): [number, number] | null {
  return Array.isArray(value) && value.length === 2 ? [value[0] as number, value[1] as number] : null;
}

/** A from–to pair of time pickers on the clinic's 15 minute grid; each limits the other so the range stays valid. */
function RangePickers({ label, startLabel, endLabel, start, end, min, max, onStart, onEnd }: {
  label: string;
  startLabel: string;
  endLabel: string;
  start: number;
  end: number;
  min: number;
  max: number;
  onStart: (minutes: number) => void;
  onEnd: (minutes: number) => void;
}) {
  const pick = (setter: (minutes: number) => void) => (next: string | null) => {
    if (next) setter(timeMinutes(next));
  };
  return (
    <div role="group" aria-label={label} className="flex min-w-0 items-center gap-2">
      <TimePicker
        aria-label={startLabel}
        className="min-w-0 flex-1"
        hourCycle={12}
        minuteStep={step}
        value={minutesTime(start)}
        min={minutesTime(min)}
        max={minutesTime(end - step)}
        onValueChange={pick(onStart)}
      />
      <span aria-hidden="true" className="text-xs text-muted-foreground">to</span>
      <TimePicker
        aria-label={endLabel}
        className="min-w-0 flex-1"
        hourCycle={12}
        minuteStep={step}
        value={minutesTime(end)}
        min={minutesTime(start + step)}
        max={minutesTime(max)}
        onValueChange={pick(onEnd)}
      />
    </div>
  );
}

function Readout({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="font-medium">{label}</span>
      <span className="tabular-nums">{value} <span className="text-muted-foreground">· {detail}</span></span>
    </div>
  );
}

export function HoursEditor({ value, onChange, affectedCount, uniform }: {
  value: HoursDraft;
  onChange: (next: HoursDraft) => void;
  /** Upcoming bookings these hours would move. */
  affectedCount: number;
  /** False when saved days differ from each other, because saving here sets them all the same. */
  uniform: boolean;
}) {
  const daysLabel = useId();
  const t = useTerms();
  const start = timeMinutes(value.start);
  const end = timeMinutes(value.end);
  const lunchStart = value.breakStart ? timeMinutes(value.breakStart) : null;
  const lunchEnd = value.breakEnd ? timeMinutes(value.breakEnd) : null;
  const lunch = lunchStart !== null && lunchEnd !== null ? lunchEnd - lunchStart : 0;
  const canHaveLunch = end - start >= step * 3;
  // Saved hours outside the usual day stay reachable instead of being clamped away.
  const min = Math.min(earliest, start);
  const max = Math.max(latest, end);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <span id={daysLabel} className="text-sm font-medium">Working days</span>
        <ToggleGroup
          aria-labelledby={daysLabel}
          multiple
          variant="outline"
          className="w-full"
          value={value.days.map(String)}
          onValueChange={(next) => onChange({ ...value, days: next.map(Number).sort((first, second) => first - second) })}
        >
          {days.map((day) => <ToggleGroupItem key={day.iso} value={String(day.iso)} className="flex-1 px-0">{day.label}</ToggleGroupItem>)}
        </ToggleGroup>
        {value.days.length === 0 ? <p className="text-xs text-destructive-foreground">Choose at least one day.</p> : null}
      </div>

      <div className="flex flex-col gap-3">
        <Readout label="Hours" value={duration(end - start - lunch)} detail="open" />
        <RangePickers
          label="Working hours"
          startLabel="Starts at"
          endLabel="Ends at"
          start={start}
          end={end}
          min={min}
          max={max}
          onStart={(minutes) => onChange(fitBreak({ ...value, start: minutesTime(minutes) }))}
          onEnd={(minutes) => onChange(fitBreak({ ...value, end: minutesTime(minutes) }))}
        />
        <Slider
          value={[start, end]}
          min={min}
          max={max}
          step={step}
          minStepsBetweenValues={2}
          getAriaLabel={(index) => index === 0 ? "Starts at" : "Ends at"}
          getAriaValueText={(_formatted, minutes) => clock(minutes)}
          onValueChange={(next) => {
            const range = pair(next);
            if (range) onChange(fitBreak({ ...value, start: minutesTime(range[0]), end: minutesTime(range[1]) }));
          }}
        />
      </div>

      <div className="flex flex-col gap-3">
        <Label className="justify-between gap-3">
          Lunch break
          <Switch
            checked={lunch > 0}
            disabled={!canHaveLunch}
            onCheckedChange={(checked) => {
              if (!checked) {
                onChange({ ...value, breakStart: null, breakEnd: null });
                return;
              }
              const fits = defaultLunch.start > start && defaultLunch.end < end;
              const middle = Math.floor((start + end) / 2 / step) * step;
              onChange(fitBreak({
                ...value,
                breakStart: minutesTime(fits ? defaultLunch.start : middle - step),
                breakEnd: minutesTime(fits ? defaultLunch.end : middle + step),
              }));
            }}
          />
        </Label>
        {lunchStart !== null && lunchEnd !== null ? (
          <>
            <Readout label="Away" value={duration(lunch)} detail="lunch" />
            <RangePickers
              label="Lunch break"
              startLabel="Lunch starts at"
              endLabel="Lunch ends at"
              start={lunchStart}
              end={lunchEnd}
              min={start + step}
              max={end - step}
              onStart={(minutes) => onChange({ ...value, breakStart: minutesTime(minutes) })}
              onEnd={(minutes) => onChange({ ...value, breakEnd: minutesTime(minutes) })}
            />
            <Slider
              value={[lunchStart, lunchEnd]}
              min={start + step}
              max={end - step}
              step={step}
              minStepsBetweenValues={1}
              getAriaLabel={(index) => index === 0 ? "Lunch starts at" : "Lunch ends at"}
              getAriaValueText={(_formatted, minutes) => clock(minutes)}
              onValueChange={(next) => {
                const range = pair(next);
                if (range) onChange({ ...value, breakStart: minutesTime(range[0]), breakEnd: minutesTime(range[1]) });
              }}
            />
          </>
        ) : null}
      </div>

      {!uniform ? (
        <Alert variant="info">
          <AlertDescription>This {t.practitioner} has different hours on different days. Saving a change here sets one set of hours for every selected day. Per-day hours are in Settings, under Hours.</AlertDescription>
        </Alert>
      ) : null}
      {affectedCount > 0 ? (
        <Alert variant="warning">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>
            {affectedCount} upcoming booking{affectedCount === 1 ? " falls" : "s fall"} outside these hours. When you save, Kalendr moves {affectedCount === 1 ? "it" : "each one"} to the nearest opening with this {t.practitioner} and queues {t.aCustomer} update.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
