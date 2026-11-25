"use client";

import { CalendarX, Repeat } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import type { Appointment } from "@/lib/domain";

import { appointmentDuration, appointmentTime, statusLabel } from "./clinic-format";
import { clinicDateKey } from "./schedule-availability";
import { dayLabel } from "./schedule-model";
import { appointmentStatusTone } from "./task-ui";
import { layoutRows, visibleRange } from "./windowing";
import { ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";

/** One visit as the list shows it. The workspace works out names so the list stays a plain view. */
export interface ListVisit {
  appointment: Appointment;
  patientName: string;
  phone: string;
  serviceName: string;
  practitionerName: string;
  roomName: string;
}

export type ListGrouping = "day" | "staff" | "room" | "none";

type ListRow =
  | { kind: "heading"; key: string; label: string; count: number }
  | { kind: "visit"; key: string; visit: ListVisit };

const headingHeight = 40;

function groupLabel(visit: ListVisit, grouping: ListGrouping): string {
  if (grouping === "day") return dayLabel(clinicDateKey(visit.appointment.startsAt), { weekday: "long", day: "numeric", month: "long" });
  if (grouping === "staff") return visit.practitionerName;
  if (grouping === "room") return visit.roomName || "No room";
  return "";
}

/** Flat rows: a heading before each group, then that group's visits. Grouping by staff or room re-sorts within the group by time. */
export function buildListRows(visits: readonly ListVisit[], grouping: ListGrouping): ListRow[] {
  if (grouping === "none") return visits.map((visit) => ({ kind: "visit", key: visit.appointment.id, visit }));
  const groups = new Map<string, ListVisit[]>();
  for (const visit of visits) {
    const label = groupLabel(visit, grouping);
    groups.set(label, [...(groups.get(label) ?? []), visit]);
  }
  const ordered = grouping === "day" ? [...groups.entries()] : [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  return ordered.flatMap(([label, members]): ListRow[] => [
    { kind: "heading", key: `heading:${label}`, label, count: members.length },
    ...members.map((visit): ListRow => ({ kind: "visit", key: visit.appointment.id, visit })),
  ]);
}

export interface ScheduleListProps {
  visits: readonly ListVisit[];
  grouping: ListGrouping;
  selectedIds: ReadonlySet<string>;
  openId: string;
  /** Show checkboxes for choosing several. Off for people who cannot change appointments. */
  selectable: boolean;
  /** Bigger rows for a finger. */
  touch: boolean;
  label: string;
  emptyTitle: string;
  emptyDescription: string;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[], on: boolean) => void;
  onOpen: (id: string, anchor?: Element) => void;
  onClearFilters?: () => void;
  /** Shown in the header in place of the count while visits are selected. Same height, so the rows never move. */
  bulkBar?: ReactNode;
}

/**
 * A day or a week as rows. Only the rows in view exist in the page, so a day with hundreds of visits
 * scrolls as smoothly as one with five. Arrow keys move between rows; the checkbox picks a row for a bulk action.
 */
export function ScheduleList({ visits, grouping, selectedIds, openId, selectable, touch, label, emptyTitle, emptyDescription, onToggle, onToggleAll, onOpen, onClearFilters, bulkBar }: ScheduleListProps) {
  const rowHeight = touch ? 76 : 60;
  const rows = useMemo(() => buildListRows(visits, grouping), [grouping, visits]);
  const heights = useMemo(() => rows.map((row) => row.kind === "heading" ? headingHeight : rowHeight), [rowHeight, rows]);
  const layout = useMemo(() => layoutRows(heights), [heights]);
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 640 });
  const frame = useRef(0);
  const focusAfterRender = useRef<number | null>(null);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setViewport((current) => current.height === element.clientHeight ? current : { ...current, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onScroll = useCallback(() => {
    // One state update per frame however fast the wheel spins.
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const element = scroller.current;
      if (element) setViewport({ top: element.scrollTop, height: element.clientHeight });
    });
  }, []);

  const range = visibleRange(layout, heights, viewport.top, viewport.height);
  const visitIndexes = useMemo(() => rows.flatMap((row, index) => row.kind === "visit" ? [index] : []), [rows]);
  const allIds = useMemo(() => visits.map((visit) => visit.appointment.id), [visits]);
  const selectedCount = allIds.filter((id) => selectedIds.has(id)).length;

  useEffect(() => {
    const target = focusAfterRender.current;
    if (target === null) return;
    const button = scroller.current?.querySelector<HTMLElement>(`[data-row-index="${target}"] [data-row-open]`);
    if (button) { focusAfterRender.current = null; button.focus(); }
  });

  function moveFocus(from: number, direction: -1 | 1) {
    const position = visitIndexes.indexOf(from);
    const next = visitIndexes[position + direction];
    if (next === undefined) return;
    focusAfterRender.current = next;
    const element = scroller.current;
    if (element) {
      const top = layout.offsets[next];
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + heights[next] > element.scrollTop + element.clientHeight) element.scrollTop = top + heights[next] - element.clientHeight;
    }
    setViewport((current) => ({ ...current, top: element?.scrollTop ?? current.top }));
  }

  if (rows.length === 0) {
    return <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon"><CalendarX aria-hidden="true" /></EmptyMedia>
        <EmptyTitle>{emptyTitle}</EmptyTitle>
        <EmptyDescription>{emptyDescription}</EmptyDescription>
      </EmptyHeader>
      {onClearFilters ? <Button variant="outline" size="sm" onClick={onClearFilters}>Clear filters</Button> : null}
    </Empty>;
  }

  return <div className="flex size-full min-h-0 flex-col">
    {selectable ? <div className={cn("flex min-h-14 shrink-0 items-center gap-3 border-b px-3 text-sm", selectedCount > 0 && "bg-accent/48")}>
      <Checkbox
        aria-label="Select every visit in this list"
        checked={selectedCount > 0 && selectedCount === allIds.length}
        indeterminate={selectedCount > 0 && selectedCount < allIds.length}
        onCheckedChange={(on) => onToggleAll(allIds, on === true)}
      />
      {selectedCount > 0 && bulkBar ? bulkBar : <span className="text-muted-foreground tabular-nums" aria-live="polite">{allIds.length} {allIds.length === 1 ? "visit" : "visits"}</span>}
    </div> : null}
    <ScrollAreaPrimitive.Root role="region" aria-label={label} className="min-h-0 flex-1">
    <ScrollAreaPrimitive.Viewport ref={scroller} onScroll={onScroll} className="size-full rounded-[inherit] overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset" data-slot="scroll-area-viewport">
    <ScrollAreaPrimitive.Content style={{ minWidth: 0 }}>
      <div className="relative" style={{ height: layout.total }}>
        {rows.slice(range.start, range.end).map((row, offset) => {
          const index = range.start + offset;
          const style = { top: layout.offsets[index], height: heights[index] };
          if (row.kind === "heading") {
            return <h3 key={row.key} style={style} className="absolute inset-x-0 flex items-center gap-2 border-b bg-muted/48 px-3 text-sm font-medium">
              {row.label}<span className="font-normal text-muted-foreground tabular-nums">{row.count}</span>
            </h3>;
          }
          const { appointment } = row.visit;
          const selected = selectedIds.has(appointment.id);
          return <div key={row.key} data-row-index={index} style={style} className={cn("absolute inset-x-0 flex items-stretch border-b", selected && "bg-accent/48", openId === appointment.id && "bg-accent")}>
            {selectable ? <label className="flex w-12 shrink-0 cursor-pointer items-center justify-center sm:w-11">
              <Checkbox aria-label={`Select ${row.visit.patientName}, ${appointmentTime(appointment.startsAt)}`} checked={selected} onCheckedChange={() => onToggle(appointment.id)} />
            </label> : <span className="w-2 shrink-0" aria-hidden="true" />}
            <button
              type="button"
              data-row-open
              data-visit-id={appointment.id}
              className="flex min-w-0 flex-1 items-center gap-3 px-2 text-start outline-none hover:bg-accent/64 focus-visible:bg-accent/64 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              onClick={(event) => onOpen(appointment.id, event.currentTarget)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); moveFocus(index, event.key === "ArrowDown" ? 1 : -1); }
              }}
            >
              <span className="w-[5.5rem] shrink-0 text-sm tabular-nums sm:w-28">
                <span className="block font-medium">{appointmentTime(appointment.startsAt)}</span>
                <span className="block text-muted-foreground text-xs">{appointmentDuration(appointment)} min</span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{row.visit.patientName}{appointment.seriesId ? <Repeat role="img" aria-label="Repeating" className="ms-1.5 inline size-3.5 align-[-2px] text-muted-foreground" /> : null}</span>
                <span className="block truncate text-muted-foreground text-xs">{[row.visit.serviceName, row.visit.practitionerName, row.visit.roomName].filter(Boolean).join(" · ")}</span>
              </span>
              <StatusBadge tone={appointmentStatusTone(appointment.status)} className="max-sm:hidden">{statusLabel(appointment.status)}</StatusBadge>
            </button>
          </div>;
        })}
      </div>
    </ScrollAreaPrimitive.Content>
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar orientation="vertical" />
    </ScrollAreaPrimitive.Root>
  </div>;
}
