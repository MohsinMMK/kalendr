"use client";

import { useEffect, useRef } from "react";

/** What changed, or "all" after a reconnect or while polling. */
export type LiveChange = ReadonlySet<string> | "all";

const EVENTS_PATH = "/api/staff/events";
/** Several changes in a burst (a walk-in is an appointment and a token) become one refetch. */
const DEBOUNCE_MS = 300;
/** While the live stream is down, the screen still catches up this often. */
const POLL_MS = 30_000;
const RETRY_MIN_MS = 15_000;
const RETRY_MAX_MS = 5 * 60_000;

/** A wait between `base` and twice `base`, so screens do not all reconnect at the same moment. */
export function jittered(base: number, random: () => number = Math.random): number {
  return Math.round(base + base * random());
}

/**
 * Keeps a staff screen current: the server says what kind of thing changed and the screen refetches.
 * Event data is never shown. After a reconnect the screen refetches in case it missed something;
 * while the stream is down it polls every 30 seconds and tries the stream again with backoff.
 */
export function useLiveEvents(onChange: (change: LiveChange) => void, enabled = true): void {
  const latest = useRef(onChange);
  useEffect(() => { latest.current = onChange; }, [onChange]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof EventSource === "undefined") return;
    let source: EventSource | null = null;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = RETRY_MIN_MS;
    /** Set when the stream dropped or was refused, so changes may have been missed. */
    let missed = false;
    let stopped = false;

    let pending: Set<string> | "all" = new Set();
    const refetch = (kind: string | "all") => {
      if (kind === "all") pending = "all";
      else if (pending !== "all") pending.add(kind);
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const change = pending;
        pending = new Set();
        latest.current(change);
      }, DEBOUNCE_MS);
    };
    const readKind = (event: Event): string | "all" => {
      try {
        const data: unknown = JSON.parse((event as MessageEvent<string>).data);
        if (data && typeof data === "object" && "kind" in data && typeof data.kind === "string") return data.kind;
      } catch {
        // Unknown shape: refetch everything.
      }
      return "all";
    };
    const startPolling = () => {
      poll ??= setInterval(() => latest.current("all"), POLL_MS);
    };
    const stopPolling = () => {
      clearInterval(poll);
      poll = undefined;
    };

    const connect = () => {
      if (stopped) return;
      source = new EventSource(EVENTS_PATH);
      source.addEventListener("ready", () => {
        stopPolling();
        retryDelay = RETRY_MIN_MS;
        // The first connection follows the first load; after a drop or refusal, catch up.
        if (missed) refetch("all");
        missed = false;
      });
      source.addEventListener("change", (event) => refetch(readKind(event)));
      source.addEventListener("resync", () => refetch("all"));
      source.onerror = () => {
        missed = true;
        startPolling();
        // The browser retries a dropped stream itself. A refused one (signed out, server error)
        // is closed for good, so try again later, backing off.
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          source = null;
          clearTimeout(retry);
          retry = setTimeout(connect, jittered(retryDelay));
          retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
        }
      };
    };

    connect();
    return () => {
      stopped = true;
      source?.close();
      clearTimeout(debounce);
      clearTimeout(retry);
      stopPolling();
    };
  }, [enabled]);
}
