import { useMemo } from "react";

import type { BookerSlot } from "./api";

export interface AvailabilityPickerProps {
  slots: readonly BookerSlot[];
  /** IANA zone the times are shown in. */
  timeZone: string;
  selectedId?: string | undefined;
  onSelect: (slot: BookerSlot) => void;
  /** Words for an empty list. */
  emptyMessage?: string;
}

function dayKey(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Open times grouped by day. Each time is a real button, so the keyboard and screen readers work without extra code. */
export function AvailabilityPicker({ slots, timeZone, selectedId, onSelect, emptyMessage = "No open times in this period." }: AvailabilityPickerProps) {
  const groups = useMemo(() => {
    const byDay = new Map<string, BookerSlot[]>();
    for (const slot of slots) {
      const key = dayKey(new Date(slot.startsAt), timeZone);
      byDay.set(key, [...(byDay.get(key) ?? []), slot]);
    }
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [slots, timeZone]);

  if (groups.length === 0) return <p className="kalendr-booker__empty" role="status">{emptyMessage}</p>;
  const heading = new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone });
  const clock = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone });
  return (
    <div className="kalendr-booker__days">
      {groups.map(([key, daySlots]) => (
        <section key={key} aria-label={heading.format(new Date(daySlots[0]!.startsAt))}>
          <h3 className="kalendr-booker__day">{heading.format(new Date(daySlots[0]!.startsAt))}</h3>
          <ul className="kalendr-booker__times">
            {daySlots.map((slot) => (
              <li key={slot.id}>
                <button
                  type="button"
                  className="kalendr-booker__time"
                  aria-pressed={selectedId === slot.id}
                  onClick={() => onSelect(slot)}
                >
                  {clock.format(new Date(slot.startsAt)).toLowerCase()}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
