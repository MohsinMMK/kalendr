"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

/**
 * Keyboard movement over times laid out in day columns. Only one time is in the tab order (a roving tab stop),
 * the arrows move between times and days, Home and End jump to the first and last time of the day, and Page Up
 * and Page Down ask for the previous or next period. After a page the first time of the new period takes focus
 * once it has loaded.
 */
export function useSlotGrid(input: {
  /** Ids of the times on screen, in reading order. */
  visibleIds: string[];
  selectedId?: string;
  /** Previous (-1) or next (1) period. Leave out where the keys should do nothing. */
  onPage?: (direction: -1 | 1) => void;
  /** Changes whenever the period changes, so a pending focus can land. */
  periodKey: string;
}) {
  const { visibleIds, selectedId, onPage, periodKey } = input;
  const rootRef = useRef<HTMLDivElement>(null);
  const [lastFocused, setLastFocused] = useState<string>();
  const pendingFocus = useRef<number | null>(null);

  const tabStop = lastFocused && visibleIds.includes(lastFocused)
    ? lastFocused
    : selectedId && visibleIds.includes(selectedId)
      ? selectedId
      : visibleIds[0];

  useEffect(() => {
    if (pendingFocus.current === null) return;
    if (Date.now() - pendingFocus.current > 5000) {
      pendingFocus.current = null;
      return;
    }
    const first = rootRef.current?.querySelector<HTMLElement>("[data-slot-button]");
    if (first) {
      pendingFocus.current = null;
      first.focus();
    }
  }, [periodKey, visibleIds]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const root = rootRef.current;
    const current = (event.target as HTMLElement).closest<HTMLElement>("[data-slot-button]");
    if (!root || !current) return;
    const columns = [...root.querySelectorAll<HTMLElement>("[data-day-column]")]
      .map((column) => [...column.querySelectorAll<HTMLElement>("[data-slot-button]")])
      .filter((column) => column.length > 0);
    const columnIndex = columns.findIndex((column) => column.includes(current));
    if (columnIndex < 0) return;
    const column = columns[columnIndex];
    const row = column.indexOf(current);
    let next: HTMLElement | undefined;
    switch (event.key) {
      case "ArrowDown": next = column[Math.min(row + 1, column.length - 1)]; break;
      case "ArrowUp": next = column[Math.max(row - 1, 0)]; break;
      case "ArrowRight": next = columns[Math.min(columnIndex + 1, columns.length - 1)]?.[Math.min(row, (columns[Math.min(columnIndex + 1, columns.length - 1)]?.length ?? 1) - 1)]; break;
      case "ArrowLeft": next = columns[Math.max(columnIndex - 1, 0)]?.[Math.min(row, (columns[Math.max(columnIndex - 1, 0)]?.length ?? 1) - 1)]; break;
      case "Home": next = event.ctrlKey ? columns[0][0] : column[0]; break;
      case "End": next = event.ctrlKey ? columns[columns.length - 1].at(-1) : column[column.length - 1]; break;
      case "PageDown":
      case "PageUp":
        if (!onPage) return;
        event.preventDefault();
        pendingFocus.current = Date.now();
        onPage(event.key === "PageDown" ? 1 : -1);
        return;
      default: return;
    }
    event.preventDefault();
    next?.focus();
  }, [onPage]);

  return { rootRef, tabStop, onKeyDown, onFocusSlot: setLastFocused };
}
