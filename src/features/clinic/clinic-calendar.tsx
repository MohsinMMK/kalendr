"use client";

import { CalendarDays, ChevronLeft, ChevronRight, List } from "lucide-react";
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { type CalEvent, DEFAULT_COMPONENTS, Kloq, type KloqComponents, type KloqProps, type Lane, type TimelineRowProps, byResourceId, useKloq } from "@/components/kloq";
import { isTypingEvent } from "@/components/kloq/lib/keyboard-scope";
import { dateFromKey, keyFromDate } from "@/components/date-picker";
import { useMediaQuery } from "@/hooks/use-media-query";
import { Button } from "@/components/ui/button";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { TogglePrimitive } from "@/components/ui/toggle";
import { ToggleGroupPrimitive } from "@/components/ui/toggle-group";
import type { Practitioner, TimeSlot } from "@/lib/domain";

import { type ClinicEvent, clinicTimeZone, type LaneShading, pixelsPerSlot, timelineSlotMinutes, timelineStartMinute, timelineWindow } from "./clinic-calendar-events";
import { appointmentTime } from "./clinic-format";
import { clinicDateKey, clinicDateTime, clinicTimeMinutes, minutesTime } from "./schedule-availability";

// Kept for pages that already draw a calendar; pages that only build events import clinic-calendar-events.
export { appointmentEvent, blockEvent, type ClinicEvent, closedTimeConstraint, inactiveStatuses, practitionerLanes } from "./clinic-calendar-events";

const ShadedTimelineRow = memo(function ShadedTimelineRow(props: TimelineRowProps) {
  const { lane, axis } = props;
  const shading = lane.data as LaneShading | undefined;
  return <div className="relative w-fit shrink-0">
    <DEFAULT_COMPONENTS.TimelineRow {...props} />
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {shading?.off.map((band) => <div key={band.start} className="absolute inset-y-0 bg-[repeating-linear-gradient(135deg,var(--color-border)_0_1px,transparent_1px_6px)] bg-muted/60" style={{ left: axis.durationToPx(band.start), width: axis.durationToPx(band.end - band.start) }} />)}
      {shading?.now !== undefined && shading.now >= 0 ? <div className="absolute inset-y-0 w-px bg-(--kloq-now)" style={{ left: axis.durationToPx(shading.now) }} /> : null}
    </div>
  </div>;
});

const clinicSlots: Partial<KloqComponents> = { EventPanel: () => null, TimelineRow: ShadedTimelineRow };
const laneAdapter = byResourceId("practitionerId");

/** Where a click on empty calendar space landed. */
export interface CalendarTimeTarget {
  dateKey: string;
  minute: number;
  practitionerId?: string;
}

export interface ClinicCalendarProps extends KloqProps {
  children?: ReactNode;
  /** A visit was clicked, right-clicked or activated with Enter. `anchor` is the visit on screen, for a popover to point at. */
  onOpenVisit?: (id: string, anchor?: Element | { getBoundingClientRect: () => DOMRect }) => void;
  /** Free time was clicked. */
  onOpenTime?: (target: CalendarTimeTarget) => void;
}

/** KLOQ's shortcuts that delete, duplicate, paste, undo or recolour records. Clinical changes go through the review pages instead. */
function isRecordShortcut(event: KeyboardEvent): boolean {
  const key = event.key?.toLowerCase() ?? "";
  if (event.metaKey || event.ctrlKey) return ["a", "c", "d", "v", "x", "y", "z"].includes(key);
  return !event.altKey && (key === "delete" || key === "backspace" || /^[1-5]$/.test(key));
}

/**
 * KLOQ with the clinic's defaults. Every calendar in the app goes through this, so they all behave alike:
 * a visit opens the same way however it's reached, and KLOQ's own Delete, Duplicate and Cut, in its
 * context menu and its shortcuts, never reach a clinical record.
 */
export function ClinicCalendar({ children, onOpenVisit, onOpenTime, ...props }: ClinicCalendarProps) {
  const root = useRef<HTMLDivElement>(null);
  const pointerStart = useRef<number | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const windowConfig = props.timelineWindow ?? timelineWindow;
  const isTimeline = props.view === "timeline";

  useEffect(() => {
    function holdRecordShortcut(event: KeyboardEvent) {
      const active = document.activeElement;
      const focusHere = !active || active === document.body || root.current?.contains(active);
      if (focusHere && !isTypingEvent(event) && isRecordShortcut(event)) event.stopPropagation();
    }
    window.addEventListener("keydown", holdRecordShortcut, true);
    return () => window.removeEventListener("keydown", holdRecordShortcut, true);
  }, []);

  /** The visit's block when it's on screen, otherwise the point that was clicked. */
  function anchorFor(id: string, point?: { x: number; y: number } | null) {
    const block = root.current?.querySelector(`[data-cal-event="${CSS.escape(id)}"]`);
    if (block) return block;
    if (!point) return undefined;
    return { getBoundingClientRect: () => new DOMRect(point.x, point.y, 0, 0) };
  }

  function openVisit(id: string, point?: { x: number; y: number } | null) {
    onOpenVisit?.(id, anchorFor(id, point));
  }

  function handleClick(event: React.MouseEvent<HTMLDivElement>) {
    // The timeline reports clicks as selection only. A drag ends in a click too, and `onEventsChange` has those.
    if (!isTimeline || (pointerStart.current !== null && Math.abs(event.clientX - pointerStart.current) > 4)) return;
    const hit = timelineHit(event.clientX, event.clientY, windowConfig);
    if (!hit) return;
    if ("visitId" in hit) openVisit(hit.visitId, { x: event.clientX, y: event.clientY });
    else if (props.date) onOpenTime?.({ dateKey: keyFromDate(new Date(props.date)), ...hit });
  }

  function handleKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!isTimeline || event.key !== "Enter" || !(event.target instanceof Element)) return;
    const id = event.target.closest<HTMLElement>("[data-cal-event]")?.dataset.calEvent;
    if (id) openVisit(id);
  }

  function handleContextMenu(event: React.MouseEvent<HTMLDivElement>) {
    event.stopPropagation();
    const id = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-cal-event]")?.dataset.calEvent;
    if (!id) return;
    event.preventDefault();
    openVisit(id, { x: event.clientX, y: event.clientY });
  }

  return <div ref={root} data-clinic-calendar="" className="size-full min-h-0" onPointerDownCapture={(event) => { pointerStart.current = event.clientX; pointer.current = { x: event.clientX, y: event.clientY }; }} onClick={handleClick} onKeyDown={handleKey} onContextMenuCapture={handleContextMenu}>
    <Kloq
      storage={false}
      persistence={false}
      designMode={false}
      commandPalette={false}
      displayTimeZone={clinicTimeZone}
      locale="en-IN"
      hour12
      weekStartsOn={1}
      dayStartHour={7}
      dayEndHour={20}
      workingHours={{ start: 8, end: 18 }}
      snapMinutes={15}
      minEventMinutes={15}
      laneAdapter={laneAdapter}
      timelineWindow={timelineWindow}
      components={clinicSlots}
      onEventClick={(event) => openVisit(event.id, pointer.current)}
      onSlotClick={(slot) => {
        const iso = slot.start.toISOString();
        onOpenTime?.({ dateKey: clinicDateKey(iso), minute: slot.allDay ? 0 : clinicTimeMinutes(iso) });
      }}
      {...props}
    >{children}</Kloq>
  </div>;
}

type TimelineHit = { visitId: string } | { practitionerId: string; minute: number };

/** What a timeline click landed on. Its drag engine captures the pointer, so `event.target` can be the whole canvas. Coordinates are reliable. */
function timelineHit(clientX: number, clientY: number, config: { startOffsetMinutes?: number; slotMinutes?: number; pxPerSlot?: number }): TimelineHit | null {
  const element = document.elementFromPoint(clientX, clientY);
  const visit = element?.closest<HTMLElement>("[data-cal-event]");
  if (visit?.dataset.calEvent) return { visitId: visit.dataset.calEvent };
  const row = element?.closest<HTMLElement>('[data-slot="timeline-row"]');
  if (!row?.dataset.lane) return null;
  const offset = Math.max(0, clientX - row.getBoundingClientRect().left);
  const slot = config.slotMinutes ?? timelineSlotMinutes;
  return { practitionerId: row.dataset.lane, minute: (config.startOffsetMinutes ?? timelineStartMinute) + Math.floor(offset / (config.pxPerSlot ?? pixelsPerSlot)) * slot };
}

/** A read-only timeline of one day's visits, one row per practitioner. */
export function DayTimeline({ dateKey, events, lanes, onOpenVisit, label }: { dateKey: string; events: CalEvent[]; lanes: Lane[]; onOpenVisit: (id: string) => void; label: string }) {
  const anchor = useMemo(() => dateFromKey(dateKey), [dateKey]);
  return <div role="region" aria-label={label} className="size-full min-h-0">
    <ClinicCalendar view="timeline" date={anchor} events={events} lanes={lanes} onOpenVisit={onOpenVisit} onEventsChange={ignoreChanges} />
  </div>;
}

/** Read-only calendars still run KLOQ's gestures. Their events are controlled, so ignoring a change undoes it. */
export function ignoreChanges() {}

export type OpeningsView = "calendar" | "list";

/** A timeline needs width, so phones start on the list. Whatever the user picks then sticks. */
export function useOpeningsView() {
  const [chosen, setChosen] = useState<OpeningsView | null>(null);
  const wide = useMediaQuery("sm");
  return [chosen ?? (wide ? "calendar" : "list"), setChosen] as const;
}

/** Openings shown on a calendar, or as the plain list that suits a small screen or a screen reader. */
export function OpeningsViewControl({ value, onValueChange }: { value: OpeningsView; onValueChange: (next: OpeningsView) => void }) {
  return <SegmentedControl render={<ToggleGroupPrimitive aria-label="Show openings as" value={[value]} onValueChange={(next: string[]) => { if (next[0]) onValueChange(next[0] as OpeningsView); }} />}>
    <SegmentedControlItem render={<TogglePrimitive value="calendar" />}><CalendarDays aria-hidden="true" /> Calendar</SegmentedControlItem>
    <SegmentedControlItem render={<TogglePrimitive value="list" />}><List aria-hidden="true" /> List</SegmentedControlItem>
  </SegmentedControl>;
}

const openingRowHeight = 48;
/** The axis, the sideways scrollbar and the border. */
const openingChromeHeight = 50;

/** A day's openings on a timeline fitted to those openings: one row per practitioner, one chip per half hour. The list view has every start time. */
export function OpeningsCalendar({ dateKey, slots, selected, practitioners, onSelect }: { dateKey: string; slots: readonly TimeSlot[]; selected: TimeSlot | null; practitioners: readonly Pick<Practitioner, "id" | "name">[]; onSelect: (slot: TimeSlot) => void }) {
  const chips = useMemo(() => {
    const seen = new Map<string, TimeSlot>();
    for (const slot of slots) {
      const key = `${slot.startsAt}|${slot.practitionerId}`;
      const isChosen = selected?.startsAt === slot.startsAt && selected.practitionerId === slot.practitionerId;
      if (clinicTimeMinutes(slot.startsAt) % 30 === 0 || isChosen) seen.set(key, isChosen ? selected : seen.get(key) ?? slot);
    }
    return [...seen.values()];
  }, [selected, slots]);
  const events = useMemo(() => chips.map((slot): ClinicEvent => {
    const isChosen = selected?.startsAt === slot.startsAt && selected.practitionerId === slot.practitionerId;
    return {
      id: slot.id,
      kind: "opening",
      title: `${isChosen ? "✓ " : ""}${appointmentTime(slot.startsAt)}`,
      start: slot.startsAt,
      end: clinicDateTime(dateKey, minutesTime(clinicTimeMinutes(slot.startsAt) + 30)),
      color: isChosen ? "blue" : "emerald",
      readOnly: true,
      practitionerId: slot.practitionerId,
    } as ClinicEvent;
  }), [chips, dateKey, selected]);
  const rows = useMemo<Lane[]>(() => practitioners.filter((person) => chips.some((slot) => slot.practitionerId === person.id)).map((person) => ({ id: person.id, label: person.name, height: openingRowHeight })), [chips, practitioners]);
  const fitted = useMemo(() => {
    const minutes = chips.map((slot) => clinicTimeMinutes(slot.startsAt));
    const start = Math.floor(Math.min(...minutes) / 60) * 60;
    const end = Math.ceil((Math.max(...minutes) + 30) / 60) * 60;
    return { startOffsetMinutes: start, spanMinutes: end - start, slotMinutes: 30, pxPerSlot: 96 };
  }, [chips]);
  const anchor = useMemo(() => dateFromKey(dateKey), [dateKey]);
  return <div role="region" aria-label="Openings calendar" className="overflow-hidden rounded-lg border" style={{ height: openingChromeHeight + rows.length * openingRowHeight }}>
    <ClinicCalendar view="timeline" date={anchor} events={events} lanes={rows} timelineWindow={fitted} onEventsChange={ignoreChanges} onOpenVisit={(id) => { const slot = chips.find((item) => item.id === id); if (slot) onSelect(slot); }} />
  </div>;
}

/** Previous, next and the month's name, for a calendar that only ever shows months. Goes inside `<ClinicCalendar>`. */
export function MonthNav() {
  const { date, step } = useKloq();
  return <div className="flex items-center gap-2">
    <Button size="icon-sm" variant="ghost" aria-label="Previous month" onClick={() => step(-1)}><ChevronLeft aria-hidden="true" /></Button>
    <Button size="icon-sm" variant="ghost" aria-label="Next month" onClick={() => step(1)}><ChevronRight aria-hidden="true" /></Button>
    <h3 className="text-sm font-medium tabular-nums">{new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(date)}</h3>
  </div>;
}
