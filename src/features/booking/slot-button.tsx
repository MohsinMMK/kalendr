"use client";

import type { CSSProperties, MouseEvent } from "react";

import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";

import { formatClock, slotAccessibleName } from "./zone-time";

export interface SlotButtonProps {
  id: string;
  slotId: string;
  startsAt: string;
  locale: string;
  zone: string;
  hour12?: boolean;
  /** Who it is with. Shown under the time when several people are on offer, and always spoken. */
  person?: string;
  showPerson?: boolean;
  /** A shorter name to show where space is tight; the spoken name stays whole. */
  personShort?: string;
  selected: boolean;
  tabStop: boolean;
  onChoose: (slotId: string, viaPointer: boolean) => void;
  onFocusSlot: (slotId: string) => void;
  className?: string;
  style?: CSSProperties;
}

/**
 * One time. Its name is the whole date and time ("Tuesday 3 December, 10:30 am, Dr Rao"), so it makes sense out of
 * context. It is one choice among many, so it is exposed as a radio; the grid around it moves focus with the arrows.
 */
export function SlotButton({ id, slotId, startsAt, locale, zone, hour12, person, showPerson = false, personShort, selected, tabStop, onChoose, onFocusSlot, className, style }: SlotButtonProps) {
  return (
    <Toggle
      id={id}
      type="button"
      role="radio"
      aria-checked={selected}
      aria-pressed={undefined}
      aria-label={slotAccessibleName({ startsAt, locale, zone, hour12, person })}
      data-slot-button={slotId}
      tabIndex={tabStop ? 0 : -1}
      pressed={selected}
      style={style}
      size="lg"
      variant="outline"
      onFocus={() => onFocusSlot(slotId)}
      // A chosen time stays chosen. Every click on a time moves on; the arrow keys only move focus, so they never click.
      onClick={(event: MouseEvent<HTMLButtonElement>) => onChoose(slotId, event.detail > 0)}
      className={cn(
        "min-h-11 w-full data-pressed:border-primary data-pressed:bg-primary data-pressed:text-primary-foreground data-pressed:hover:bg-primary dark:data-pressed:bg-primary dark:data-pressed:hover:bg-primary",
        showPerson && "h-auto flex-col gap-0 py-1.5 sm:h-auto",
        className,
      )}
    >
      {/* The dot says "open" at a glance; the spoken name already says it, so it is hidden from screen readers. */}
      <span className="flex items-center gap-2" aria-hidden="true">
        <span data-open-dot className="size-1.5 shrink-0 rounded-full bg-success" />
        <span className="tabular-nums">{formatClock(startsAt, locale, zone, hour12)}</span>
      </span>
      {showPerson && person ? <span aria-hidden="true" className="max-w-full truncate font-normal text-xs opacity-72">{personShort ?? person}</span> : null}
    </Toggle>
  );
}
