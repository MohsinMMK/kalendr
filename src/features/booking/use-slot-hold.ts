"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { HOLD_MINUTES, type HoldResult } from "@/lib/booking-page";
import type { TimeSlot } from "@/lib/domain";


/** What a hold request needs besides the time itself. */
export interface HoldTarget {
  locationId: string;
  serviceId: string;
}

export type HoldOutcome = "held" | "taken" | "skipped";

export interface SlotHold {
  token: string;
  slotId: string;
  /** Local clock time (ms) the hold ends. Worked out from when the answer arrived, so a wrong device clock cannot end it early. */
  deadline: number;
}

function errorCode(payload: unknown): string | undefined {
  const error = (payload as { error?: { code?: unknown } } | undefined)?.error;
  return typeof error?.code === "string" ? error.code : undefined;
}

const storageKey = (clinicSlug: string) => `kalendr.hold.${clinicSlug}`;

function readStored(clinicSlug: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(clinicSlug));
  } catch {
    return null;
  }
}

function writeStored(clinicSlug: string, token: string | null) {
  try {
    if (token) window.sessionStorage.setItem(storageKey(clinicSlug), token);
    else window.sessionStorage.removeItem(storageKey(clinicSlug));
  } catch {
    // Private windows can refuse storage; the hold still works for this page.
  }
}

function sendRelease(clinicSlug: string, holdToken: string) {
  // keepalive lets the request finish while the page is closing.
  void fetch("/api/public/holds", {
    method: "DELETE",
    keepalive: true,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ clinicSlug, holdToken }),
  }).catch(() => undefined);
}

/**
 * One live hold per browser. A picked time is held for a few minutes while the customer fills in the form.
 * The hold lives with the booking flow, not the time screen: tapping a time moves on, and the hold must survive that.
 */
export function useSlotHold(input: {
  clinicSlug: string;
  /** False in preview mode, where there is nothing to hold. */
  enabled: boolean;
  /** The hold ran out. The booking clears the time and asks again. */
  onExpired: () => void;
  /** A routing form's token (feature 46), so the held person is one the form picked. */
  routingToken?: string;
}) {
  const { clinicSlug, enabled, onExpired, routingToken } = input;
  const [hold, setHold] = useState<SlotHold | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const holdRef = useRef<SlotHold | null>(null);
  const sequence = useRef(0);
  // A link that already holds the time for this customer, such as one an AI assistant made (feature 54): its token is
  // handed over with the first hold request, which swaps it for this browser's own, so the hold never blocks the customer it was made for.
  const linkedHold = useRef<string | null>(null);
  const onExpiredRef = useRef(onExpired);
  useEffect(() => {
    onExpiredRef.current = onExpired;
  });

  const store = useCallback((next: SlotHold | null) => {
    holdRef.current = next;
    setHold(next);
    writeStored(clinicSlug, next?.token ?? null);
    setRemainingSeconds(next ? Math.max(0, Math.ceil((next.deadline - Date.now()) / 1000)) : null);
  }, [clinicSlug]);

  /** Lets the hold go (picked another time, left, or closed the page). */
  const release = useCallback(() => {
    sequence.current += 1;
    setPending(false);
    const current = holdRef.current;
    if (current) sendRelease(clinicSlug, current.token);
    store(null);
  }, [clinicSlug, store]);

  /** The booking took the hold over, so there is nothing to release. */
  const forget = useCallback(() => {
    sequence.current += 1;
    setPending(false);
    store(null);
  }, [store]);

  const request = useCallback(async (slot: TimeSlot, target: HoldTarget): Promise<HoldOutcome> => {
    if (!enabled) return "skipped";
    const mine = ++sequence.current;
    setPending(true);
    const replaceToken = holdRef.current?.token ?? linkedHold.current ?? undefined;
    linkedHold.current = null;
    try {
      const response = await fetch("/api/public/holds", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          clinicSlug,
          locationId: target.locationId,
          serviceId: target.serviceId,
          practitionerId: slot.practitionerId,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          ...(replaceToken ? { replaceToken } : {}),
          ...(routingToken ? { routingToken } : {}),
        }),
      });
      const payload: unknown = await response.json().catch(() => undefined);
      const stale = mine !== sequence.current;
      if (response.status === 409 && errorCode(payload) === "slot_unavailable") {
        if (stale) return "skipped";
        // The time is gone, and so is whatever was held before it.
        store(null);
        setPending(false);
        return "taken";
      }
      const data = (payload as { data?: Partial<HoldResult> } | undefined)?.data;
      if (!response.ok || typeof data?.holdToken !== "string") {
        if (!stale) setPending(false);
        return "skipped";
      }
      if (stale) {
        // Another time was picked while this was on its way.
        sendRelease(clinicSlug, data.holdToken);
        return "skipped";
      }
      const received = Date.now();
      const serverMs = typeof data.expiresAt === "string" ? Date.parse(data.expiresAt) - received : Number.NaN;
      const full = HOLD_MINUTES * 60_000;
      const length = serverMs >= 10_000 && serverMs <= full + 5_000 ? serverMs : full;
      store({ token: data.holdToken, slotId: slot.id, deadline: received + length });
      setPending(false);
      return "held";
    } catch {
      if (mine === sequence.current) setPending(false);
      return "skipped";
    }
  }, [clinicSlug, enabled, routingToken, store]);

  useEffect(() => {
    const linked = new URLSearchParams(window.location.search).get("hold");
    if (linked && linked.length >= 20 && linked.length <= 200) linkedHold.current = linked;
  }, []);

  // A hold left behind by a page reload belongs to nobody now.
  useEffect(() => {
    const stale = readStored(clinicSlug);
    if (stale) {
      sendRelease(clinicSlug, stale);
      writeStored(clinicSlug, null);
    }
  }, [clinicSlug]);

  // The countdown. It reads the clock each second and stops at the end.
  useEffect(() => {
    if (!hold) return;
    const timer = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((hold.deadline - Date.now()) / 1000));
      setRemainingSeconds(left);
      if (left === 0) {
        window.clearInterval(timer);
        store(null);
        onExpiredRef.current();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hold, store]);

  // Closing the tab or leaving the booking lets the time go.
  useEffect(() => {
    const onHide = () => {
      const current = holdRef.current;
      if (current) sendRelease(clinicSlug, current.token);
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      const current = holdRef.current;
      if (current) {
        sendRelease(clinicSlug, current.token);
        writeStored(clinicSlug, null);
      }
    };
  }, [clinicSlug]);

  return { hold, remainingSeconds, pending, request, release, forget };
}
