"use client";

import { CalendarDays, ChevronLeft, ChevronRight, DoorOpen, List, Users } from "lucide-react";
import type { ReactNode, Ref } from "react";

import { DatePicker } from "@/components/date-picker";
import { OptionSelect } from "@/components/form-fields";
import { ExpandingSearch } from "@/components/expanding-search";
import { Button } from "@/components/ui/button";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { TogglePrimitive } from "@/components/ui/toggle";
import { ToggleGroupPrimitive } from "@/components/ui/toggle-group";
import { useTerms } from "@/features/terms/business-profile-context";

import { type ListRange, listRanges, type ScheduleView, scheduleViews } from "./schedule-view";

const shortDate = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short" });
const viewIcons = { staff: Users, rooms: DoorOpen, week: CalendarDays, list: List } as const;

/** The schedule's frame toolbar, in two parts: `start` moves the date, `end` picks the view, search and filters. */
export function ScheduleToolbar({ part, summary, view, onViewChange, range, onRangeChange, phone, dateKey, title, stepLabel, onStep, onToday, onPickDate, search, onSearch, searchRef, filters }: {
  part: "start" | "end";
  /** Short count beside the date, like "12 visits". */
  summary?: string;
  view: ScheduleView;
  onViewChange: (view: ScheduleView) => void;
  range: ListRange;
  onRangeChange: (range: ListRange) => void;
  phone: boolean;
  dateKey: string;
  title: string;
  stepLabel: "day" | "week";
  onStep: (direction: -1 | 1) => void;
  onToday: () => void;
  onPickDate: (dateKey: string) => void;
  search: string;
  onSearch: (value: string) => void;
  searchRef: Ref<HTMLInputElement>;
  filters: ReactNode;
}) {
  const t = useTerms();
  const labels: Record<ScheduleView, string> = { staff: `By ${t.practitioner}`, rooms: `By ${t.resource}`, week: "Week", list: "List" };
  if (part === "start") return <>
    <div className="flex items-center gap-1" role="group" aria-label="Change date">
      <Button size="icon" variant="outline" aria-label={`Previous ${stepLabel}`} onClick={() => onStep(-1)}><ChevronLeft aria-hidden="true" /></Button>
      <Button variant="outline" onClick={onToday}>Today</Button>
      <Button size="icon" variant="outline" aria-label={`Next ${stepLabel}`} onClick={() => onStep(1)}><ChevronRight aria-hidden="true" /></Button>
      <DatePicker aria-label="Go to date" size="default" formatLabel={phone ? shortDate.format : undefined} className="ms-1 w-auto min-w-0 font-medium" value={dateKey} onValueChange={onPickDate} />
    </div>
    {summary ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums max-md:hidden">{summary}</span> : null}
    <h2 className="sr-only" aria-live="polite">{title}</h2>
  </>;
  return <>
    <ExpandingSearch inputRef={searchRef} shortcut="/" label={`Search schedule ${t.customers}`} placeholder={`Search ${t.customers}`} value={search} onValueChange={onSearch} />
    {phone ? <OptionSelect aria-label="Show" size="default" className="min-w-0 w-40" value={view} onValueChange={(next) => onViewChange(next as ScheduleView)} options={scheduleViews.map((item) => ({ value: item, label: labels[item] }))} />
      : <SegmentedControl render={<ToggleGroupPrimitive aria-label="Show the schedule as" value={[view]} onValueChange={(next: string[]) => { if (next[0]) onViewChange(next[0] as ScheduleView); }} />}>
        {scheduleViews.map((item) => {
          const Icon = viewIcons[item];
          return <SegmentedControlItem key={item} render={<TogglePrimitive value={item} />}><Icon aria-hidden="true" /> {labels[item]}</SegmentedControlItem>;
        })}
      </SegmentedControl>}
    {view === "list" ? <SegmentedControl render={<ToggleGroupPrimitive aria-label="List covers" value={[range]} onValueChange={(next: string[]) => { if (next[0]) onRangeChange(next[0] as ListRange); }} />}>
      {listRanges.map((item) => <SegmentedControlItem key={item} render={<TogglePrimitive value={item} />}>{item === "day" ? "Day" : "Week"}</SegmentedControlItem>)}
    </SegmentedControl> : null}
    {filters}
  </>;
}
