"use client";

import { useSyncExternalStore } from "react";

/** Header the service worker sets on an answer it gave from its private cache: when that copy was saved. */
export const OFFLINE_HEADER = "x-kalendr-offline-at";

let offlineAt: string | null = null;
const listeners = new Set<() => void>();

/** The time the schedule on screen was last loaded, when the worker is showing a saved copy; otherwise null. */
export function setOfflineAt(value: string | null): void {
  if (value === offlineAt) return;
  offlineAt = value;
  for (const listener of listeners) listener();
}

export function noteResponse(response: Response): void {
  const value = response.headers.get(OFFLINE_HEADER);
  setOfflineAt(value && !Number.isNaN(Date.parse(value)) ? value : null);
}

export function useOfflineAt(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => offlineAt,
    () => null,
  );
}

/** "9:42 am" in the viewer's own clock. */
export function formatOfflineTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase();
}
