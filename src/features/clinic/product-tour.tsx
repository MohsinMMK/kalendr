"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverDescription, PopoverPopup, PopoverTitle } from "@/components/ui/popover";
import { useTerms } from "@/features/terms/business-profile-context";

import { useCatalogLookups } from "./clinic-catalog";
import { useNavLabels } from "./sidebar-nav";
import { useOnboarding, useTourAction } from "./queries/onboarding";
import { useStaffAccess } from "./staff-access";

/**
 * The five-stop tour of the real screens (feature 11): schedule, new appointment, customers, messages, settings. Each stop
 * is a small popover anchored to the real control, and the tour moves between pages as it goes. It can be closed at any
 * point (that counts as seen) and is opened again from Help. Where the control is not on screen, as on a phone with the
 * menu closed, the stop shows in the middle of the screen instead.
 */

const eventName = "kalendr:start-tour";
const storageKey = "kalendr-tour-stop";

/** Starts the tour from the first stop. Help calls this. */
export function requestProductTour(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(eventName));
}

interface Stop {
  id: string;
  route: string;
  title: string;
  body: string;
  /** Finds the real control on this page. Null when it is not shown, and the stop is centred. */
  find: () => Element | null;
}

function visible(element: Element | null): Element | null {
  if (!element) return null;
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 ? element : null;
}

function buttonStartingWith(prefix: string, extra?: string) {
  return () => {
    for (const button of document.querySelectorAll("button, a")) {
      const text = (button.textContent ?? "").trim().toLowerCase();
      if ((text.startsWith(prefix) || (extra && text.startsWith(extra))) && visible(button)) return button;
    }
    return null;
  };
}

/** The sidebar entry itself, found by its id so a renamed entry is still found. */
const navEntry = (id: string) => () => {
  for (const entry of document.querySelectorAll(`[data-nav-id="${id}"]`)) {
    if (visible(entry)) return entry;
  }
  return null;
};

function useStops(): Stop[] {
  const t = useTerms();
  const labels = useNavLabels();
  return useMemo(() => [
    { id: "schedule", route: "/schedule", find: navEntry("schedule"), title: `Your ${labels.schedule.toLowerCase()}`, body: `Every ${t.appointment} lands here, by day or by week. Drag to move one, tap to open it.` },
    { id: "new", route: "/dashboard", find: buttonStartingWith(`new ${t.appointment}`, "new "), title: `Add ${t.anAppointment}`, body: `Someone phones or walks in? Add them here in a few seconds. Online bookings come in on their own.` },
    { id: "customers", route: "/patients", find: navEntry("patients"), title: labels.patients, body: `Everyone who has booked, with their history and contact details. You can import a list from a spreadsheet.` },
    { id: "messages", route: "/messages", find: navEntry("messages"), title: labels.messages, body: `Reminders and replies from ${t.customers} come in here, so nothing is missed.` },
    { id: "settings", route: "/dashboard", find: navEntry("settings"), title: labels.settings, body: "Hours, team, payments, your logo, cover photo and colours, and your own web address. The Getting started list on your dashboard walks you through the important ones." },
  ], [t, labels]);
}

function centre(): { getBoundingClientRect: () => DOMRect } {
  return {
    getBoundingClientRect: () => new DOMRect(window.innerWidth / 2, window.innerHeight / 3, 0, 0),
  };
}

function readStop(): number | null {
  try {
    const value = window.sessionStorage.getItem(storageKey);
    if (value === null) return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= 0 && parsed < 5 ? parsed : null;
  } catch {
    return null;
  }
}

function writeStop(value: number | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(storageKey);
    else window.sessionStorage.setItem(storageKey, String(value));
  } catch {
    // The tour still works without storage; it just cannot resume after a full page load.
  }
}

export function ProductTour() {
  const database = useCatalogLookups().database;
  const canManage = useStaffAccess().can("settings.manage");
  return database && canManage ? <TourBody /> : null;
}

function TourBody() {
  const router = useRouter();
  const pathname = usePathname();
  const stops = useStops();
  const onboarding = useOnboarding();
  const tour = useTourAction();
  const [index, setIndex] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<Element | null>(null);
  const tourState = onboarding.data?.tour;

  // Begin on the first visit, and carry on after a page change.
  useEffect(() => {
    if (!tourState) return;
    const resumed = readStop();
    queueMicrotask(() => {
      if (resumed !== null) setIndex(resumed);
      else if (tourState === "new" && pathname === "/dashboard") {
        // Only a business that registered through the guided flow has a tour state at all, so this is the owner's first visit
        // to the dashboard. Closing the tour, or finishing it, records it as seen on the server.
        writeStop(0);
        setIndex(0);
      }
    });
  }, [tourState, pathname]);

  useEffect(() => {
    function start() {
      writeStop(0);
      setIndex(0);
    }
    window.addEventListener(eventName, start);
    return () => window.removeEventListener(eventName, start);
  }, []);

  const stop = index === null ? null : (stops[index] ?? null);

  // Take the owner to the stop's page, then find the control once the page has drawn.
  useEffect(() => {
    if (!stop) return;
    if (pathname !== stop.route) {
      router.push(stop.route);
      return;
    }
    let frame = 0;
    let tries = 0;
    function look() {
      const found = stop ? stop.find() : null;
      if (found || tries >= 40) {
        setAnchor(found);
        return;
      }
      tries += 1;
      frame = window.setTimeout(look, 50);
    }
    queueMicrotask(look);
    return () => window.clearTimeout(frame);
  }, [stop, pathname, router]);

  const finish = useCallback((action: "done" | "skip") => {
    writeStop(null);
    setIndex(null);
    setAnchor(null);
    tour.mutate(action);
  }, [tour]);

  useEffect(() => {
    if (index === null) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") finish("skip");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, finish]);

  if (!stop || index === null || pathname !== stop.route) return null;
  const last = index === stops.length - 1;
  const go = (next: number) => {
    writeStop(next);
    setAnchor(null);
    setIndex(next);
  };
  return (
    <Popover open onOpenChange={(open) => { if (!open) finish("skip"); }}>
      <PopoverPopup
        anchor={anchor ?? centre()}
        side={anchor ? "right" : "bottom"}
        align="start"
        sideOffset={12}
        className="w-80 max-w-[calc(100vw-2rem)]"
        aria-label="Product tour"
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <p className="text-muted-foreground text-xs" aria-live="polite">Stop {index + 1} of {stops.length}</p>
            <PopoverTitle>{stop.title}</PopoverTitle>
            <PopoverDescription>{stop.body}</PopoverDescription>
          </div>
          <div className="flex flex-nowrap items-center justify-between gap-2">
            <Button size="sm" variant="ghost" onClick={() => finish("skip")}>Close tour</Button>
            <div className="flex items-center gap-2">
              {index > 0 ? <Button size="sm" variant="outline" onClick={() => go(index - 1)}>Back</Button> : null}
              <Button size="sm" onClick={() => (last ? finish("done") : go(index + 1))}>{last ? "Finish" : "Next"}</Button>
            </div>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
