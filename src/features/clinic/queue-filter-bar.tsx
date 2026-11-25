"use client";

import type { ReactNode, Ref } from "react";
import { X } from "lucide-react";

import { ExpandingSearch } from "@/components/expanding-search";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

export interface FilterChoice {
  value: string;
  label: string;
  /** How many of today's visits match, before this filter is applied. */
  count: number;
  icon?: ReactNode;
}

export interface FilterGroup {
  id: string;
  label: string;
  icon: ReactNode;
  choices: FilterChoice[];
  selected: string[];
  onChange: (next: string[]) => void;
}

/** A filter that picks several values at once, with how many visits each one has. */
function FilterPopover({ group }: { group: FilterGroup }) {
  const active = group.selected.length;
  const toggle = (value: string, on: boolean) => group.onChange(on ? [...group.selected, value] : group.selected.filter((item) => item !== value));
  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="outline" size="sm" className={cn("shrink-0", active && "border-primary/40 bg-primary/4")} />}
        aria-label={active ? `${group.label}, ${active} selected` : group.label}
      >
        {active ? (
          <Badge size="sm" className="tabular-nums" aria-hidden="true">{active}</Badge>
        ) : group.icon}
        {group.label}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-60 [&_[data-slot=popover-viewport]]:p-1">
        <ScrollArea className="flex h-auto! max-h-72 flex-col">
        <div role="group" aria-label={group.label} className="flex flex-col">
          {group.choices.map((choice) => {
            const checked = group.selected.includes(choice.value);
            return (
              <label
                key={choice.value}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent has-focus-visible:bg-accent"
              >
                <Checkbox aria-label={`${choice.label}, ${choice.count}`} checked={checked} onCheckedChange={(on) => toggle(choice.value, Boolean(on))} />
                {choice.icon ? <span aria-hidden="true" className="text-muted-foreground [&_svg]:size-3.5">{choice.icon}</span> : null}
                <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{choice.count}</span>
              </label>
            );
          })}
          {!group.choices.length ? <p className="px-2 py-1.5 text-sm text-muted-foreground">Nothing to filter yet</p> : null}
        </div>
        </ScrollArea>
        {active ? (
          <div className="mt-1 border-t pt-1">
            <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => group.onChange([])}>
              <X aria-hidden="true" />Clear {group.label.toLocaleLowerCase()}
            </Button>
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

export interface ViewChoice<V extends string> {
  value: V;
  label: string;
  icon: ReactNode;
}

interface QueueFilterBarProps<V extends string> {
  /** `start` is the filters; `end` is the search and the view switch. */
  part: "start" | "end";
  search: string;
  onSearch: (value: string) => void;
  searchLabel: string;
  placeholder: string;
  filters: FilterGroup[];
  onClear: () => void;
  view: V;
  views: ViewChoice<V>[];
  onView: (view: V) => void;
  /** So "/" can focus the search from anywhere on the page. */
  searchRef?: Ref<HTMLInputElement>;
}

/** Filters on the left; search (an icon until opened) and the view switch on the right. Wraps to two rows on a phone. */
export function QueueFilterBar<V extends string>({ part, search, onSearch, searchLabel, placeholder, filters, onClear, view, views, onView, searchRef }: QueueFilterBarProps<V>) {
  const shown = filters.filter((group) => group.choices.length);
  const activeCount = filters.reduce((total, group) => total + group.selected.length, 0) + (search.trim() ? 1 : 0);
  if (part === "end") return (
    <>
      {/* First on the right, so it opens into the free space beside the filters without moving the view switch. */}
      <ExpandingSearch value={search} onValueChange={onSearch} label={searchLabel} placeholder={placeholder} inputRef={searchRef} shortcut="/" />
      <SegmentedControl size="sm" aria-label="Show today as" className="shrink-0">
        {views.map((item) => (
          <SegmentedControlItem
            key={item.value}
            aria-pressed={view === item.value}
            data-pressed={view === item.value ? "" : undefined}
            onClick={() => onView(item.value)}
            aria-label={item.label}
          >
            {item.icon}
            <span className="max-md:sr-only">{item.label}</span>
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    </>
  );
  return (
    <div className="flex min-w-0 items-center gap-1.5" role="toolbar" aria-label="Filters">
      {shown.map((group) => <FilterPopover key={group.id} group={group} />)}
      {activeCount ? (
        <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground" onClick={onClear}>
          <X aria-hidden="true" />Clear
        </Button>
      ) : null}
    </div>
  );
}
