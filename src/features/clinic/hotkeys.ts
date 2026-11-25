"use client";

import { useEffect, useRef } from "react";

/** The daily actions that have a single key. Ctrl or Cmd + K belongs to the search palette. */
export type ShortcutId = "new" | "today" | "previous" | "next" | "search" | "help";

export interface ShortcutInfo {
  id: ShortcutId;
  keys: string[];
  label: string;
}

/** What the "?" sheet lists, in the order staff reach for them. */
export const shortcutList: readonly ShortcutInfo[] = [
  { id: "new", keys: ["N"], label: "New appointment" },
  { id: "today", keys: ["T"], label: "Go to today" },
  { id: "previous", keys: ["←"], label: "Previous day (or week)" },
  { id: "next", keys: ["→"], label: "Next day (or week)" },
  { id: "search", keys: ["/"], label: "Search" },
  { id: "help", keys: ["?"], label: "Show this list" },
];

const typingTags = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const typingRoles = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

/**
 * True when the key press belongs to something being typed into, so a shortcut must stay out of the way:
 * form fields, anything editable, and the search inside a menu or palette.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (typingTags.has(target.tagName)) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  const role = target.getAttribute("role");
  return role !== null && typingRoles.has(role);
}

/** An open dialog, sheet or menu has its own keys; a shortcut underneath it would act on a screen nobody is looking at. */
export function overlayIsOpen(root: ParentNode = document): boolean {
  // Some dialogs stay in the page after they close, hidden; only one that is showing counts.
  const showing = (element: Element) => !element.hasAttribute("hidden") && !element.hasAttribute("data-closed") && element.getAttribute("aria-hidden") !== "true";
  return [...root.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')].some(showing);
}

/** Which shortcut a key press means, if any. Pure: no page state, so every case can be tested. */
export function shortcutFor(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "isComposing" | "repeat" | "defaultPrevented" | "target">): ShortcutId | null {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return null;
  if (isTypingTarget(event.target)) return null;
  switch (event.key) {
    case "n":
    case "N":
      return event.repeat ? null : "new";
    case "t":
    case "T":
      return event.repeat ? null : "today";
    case "ArrowLeft":
      return "previous";
    case "ArrowRight":
      return "next";
    case "/":
      return "search";
    case "?":
      return "help";
    default:
      return null;
  }
}

/**
 * Runs the handler for a key press that means a shortcut. Keys pressed while typing, with a modifier, or with a
 * dialog open are left alone, and so are keys inside `ignoreInside` (the calendar has its own arrow keys).
 */
export function useHotkeys(handlers: Partial<Record<ShortcutId, () => void>>, options: { enabled?: boolean; ignoreInside?: string } = {}) {
  const latest = useRef(handlers);
  useEffect(() => { latest.current = handlers; });
  const { enabled = true, ignoreInside } = options;
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent) {
      const id = shortcutFor(event);
      if (!id) return;
      if (overlayIsOpen()) return;
      if (ignoreInside && event.target instanceof Element && event.target.closest(ignoreInside)) return;
      const handler = latest.current[id];
      if (!handler) return;
      event.preventDefault();
      handler();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, ignoreInside]);
}
