"use client";

import { parseAsString, useQueryState } from "nuqs";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import {
  chooseLayout,
  defaultBookingPageSettings,
  isValidTimeZone,
  layoutForWidth,
  resolveHour12,
  weekStartsOn,
  type BookingLayout,
  type ClockMode,
} from "@/lib/booking-page";
import type { Clinic, Service } from "@/lib/domain";

import { detectVisitorLocale, detectVisitorZone } from "./visitor-zone";

/** True while the screen is narrower than a tablet. Always false on the server, so the first paint matches. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((notify: () => void) => {
    if (typeof window === "undefined" || !window.matchMedia) return () => {};
    const list = window.matchMedia(query);
    list.addEventListener?.("change", notify);
    return () => list.removeEventListener?.("change", notify);
  }, [query]);
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** How the time screen shows times: which layout, in which zone, on which clock. */
export interface BookingDisplay {
  /** The layouts this service allows. The switch is hidden when there is one. */
  layouts: BookingLayout[];
  /** What the visitor chose (or the link said), before the phone fallback. */
  layout: BookingLayout;
  /** What is drawn: wide layouts fall back to month on a phone. */
  shownLayout: BookingLayout;
  onLayoutChange: (layout: BookingLayout) => void;
  zone: string;
  businessZone: string;
  /** The visit only makes sense in the branch's time, so the zone cannot change. */
  zoneLocked: boolean;
  onZoneChange: (zone: string) => void;
  hour12: boolean;
  onHour12Change: (hour12: boolean) => void;
  weekStartsOn: 0 | 1;
  locale: string;
}

/**
 * The display choices for one booking screen. The layout and a shared zone live in the address (`?layout=` and
 * `?tz=`) so a shared link opens the same view. Updates are shallow: the server page is not asked again.
 */
export function useBookingDisplay(input: {
  clinic: Pick<Clinic, "defaultClock" | "weekStart">;
  service?: Pick<Service, "bookingPage">;
  businessZone: string;
  locale: string;
  /** True when this visit has to happen in the branch's time (an in-person visit on a service that locks the zone). */
  inPerson: boolean;
}): BookingDisplay {
  const { clinic, service, businessZone, locale, inPerson } = input;
  const settings = service?.bookingPage ?? defaultBookingPageSettings;
  const [layoutParam, setLayoutParam] = useQueryState("layout", parseAsString.withOptions({ history: "replace", shallow: true }));
  const [zoneParam, setZoneParam] = useQueryState("tz", parseAsString.withOptions({ history: "replace", shallow: true }));
  const [hour12Choice, setHour12Choice] = useState<boolean>();
  const visitorZone = useMemo(() => detectVisitorZone(), []);

  const layout = chooseLayout(layoutParam, settings);
  const narrow = useMediaQuery("(max-width: 767px)");
  const zoneLocked = settings.lockTimezone && inPerson;
  const sharedZone = zoneParam && isValidTimeZone(zoneParam) ? zoneParam : null;
  const zone = zoneLocked ? businessZone : sharedZone ?? visitorZone ?? businessZone;
  const clock: ClockMode = clinic.defaultClock ?? "auto";
  const hour12 = hour12Choice ?? resolveHour12(clock, detectVisitorLocale(locale));

  return {
    layouts: settings.layoutsEnabled,
    layout,
    shownLayout: layoutForWidth(layout, narrow),
    onLayoutChange: (next) => void setLayoutParam(next),
    zone,
    businessZone,
    zoneLocked,
    // The visitor's own zone is the default, so only a different pick is written to the address.
    onZoneChange: (next) => void setZoneParam(next === (visitorZone ?? businessZone) ? null : next),
    hour12,
    onHour12Change: setHour12Choice,
    weekStartsOn: weekStartsOn(settings.weekStart, clinic.weekStart ?? 1),
    locale,
  };
}
