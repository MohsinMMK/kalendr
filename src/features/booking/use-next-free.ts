"use client";

import { useEffect, useState } from "react";

export interface NextFreeInput {
  enabled: boolean;
  clinicSlug: string;
  locationId?: string;
  serviceId?: string;
  durationMinutes?: number;
}

export interface NextFree {
  nextByPerson: Record<string, string>;
  /** The earliest free time of anyone, or null when nobody is free in the next 14 days. */
  earliest: string | null;
  loading: boolean;
  error: boolean;
}

const windowDays = 14;
const empty: NextFree = { nextByPerson: {}, earliest: null, loading: false, error: false };

type Result = { key: string; nextByPerson: Record<string, string>; earliest: string | null; error: boolean };

/** Each person's next free time in the next 14 days, for the "Who would you like to see?" screen. */
export function useNextFree({ enabled, clinicSlug, locationId, serviceId, durationMinutes }: NextFreeInput): NextFree {
  const key = enabled && locationId && serviceId ? [clinicSlug, locationId, serviceId, durationMinutes ?? ""].join("|") : null;
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (!key || !locationId || !serviceId) return;
    const controller = new AbortController();
    const from = new Date();
    const to = new Date(from.getTime() + windowDays * 24 * 60 * 60 * 1000);
    const query = new URLSearchParams({ clinicSlug, locationId, serviceId, practitionerId: "anyone", from: from.toISOString(), to: to.toISOString() });
    if (durationMinutes !== undefined) query.set("durationMinutes", String(durationMinutes));
    void (async () => {
      try {
        const response = await fetch(`/api/public/availability?${query.toString()}`, { signal: controller.signal });
        const body = (await response.json().catch(() => null)) as { data?: { slots?: Array<{ startsAt: string }>; nextByPerson?: Record<string, string> } } | null;
        if (!response.ok || !body?.data) throw new Error("availability");
        const nextByPerson = body.data.nextByPerson ?? {};
        const times = [...(body.data.slots ?? []).map((slot) => slot.startsAt), ...Object.values(nextByPerson)].filter((value) => !Number.isNaN(Date.parse(value)));
        const earliest = times.length > 0 ? times.reduce((best, value) => (Date.parse(value) < Date.parse(best) ? value : best)) : null;
        if (!controller.signal.aborted) setResult({ key, nextByPerson, earliest, error: false });
      } catch {
        if (!controller.signal.aborted) setResult({ key, nextByPerson: {}, earliest: null, error: true });
      }
    })();
    return () => controller.abort();
  }, [key, clinicSlug, locationId, serviceId, durationMinutes]);

  if (!key) return empty;
  if (!result || result.key !== key) return { ...empty, loading: true };
  return { nextByPerson: result.nextByPerson, earliest: result.earliest, loading: false, error: result.error };
}
