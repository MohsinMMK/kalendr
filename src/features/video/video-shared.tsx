"use client";

import { Phone } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { phoneHref } from "@/features/booking/booking-format";

/** "If the call won't work, phone us instead." with the business number as a tap-to-call link. */
export function PhoneFallback({ phone, who = "us" }: { phone: string | null | undefined; who?: string }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-xl border bg-muted/40 p-4 text-sm" data-testid="phone-fallback">
      <p>{who === "us" ? "If the call won't work, phone us instead." : `If the call won't work, phone ${who} instead.`}</p>
      {phone ? (
        <Button variant="outline" className="min-h-11 tabular-nums" render={<a href={phoneHref(phone)} />}>
          <Phone aria-hidden="true" />
          {phone}
        </Button>
      ) : null}
    </div>
  );
}

/** A time in the viewer's own zone, with the zone's name: "10:30 am IST". */
export function formatViewerTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso));
}

export function formatViewerDay(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(new Date(iso));
}

/** Re-renders every second while `active`, and returns the current time in milliseconds. */
export function useNow(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [active, everyMs]);
  return now;
}

/** "12 min 05 s", "1 h 02 min" */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, "0")} min`;
  return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
}

/** Runs `tick` every `everyMs` while `active`. The latest `tick` is always the one called. */
export function useInterval(tick: () => void, everyMs: number, active: boolean) {
  const saved = useRef(tick);
  useEffect(() => {
    saved.current = tick;
  });
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => saved.current(), everyMs);
    return () => window.clearInterval(id);
  }, [active, everyMs]);
}
