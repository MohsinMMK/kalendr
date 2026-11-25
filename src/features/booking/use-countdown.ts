"use client";

import { useEffect, useState } from "react";

export function clockText(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Whole seconds left until `expiresAt` (never below 0), ticking each second. Null when there is no end time. */
export function useCountdown(expiresAt: string | null | undefined): number | null {
  const end = expiresAt ? new Date(expiresAt).getTime() : Number.NaN;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (Number.isNaN(end)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [end]);
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.ceil((end - now) / 1000));
}
