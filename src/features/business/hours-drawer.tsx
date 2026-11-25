"use client";

import { AccessibilityIcon, ChevronRightIcon, ClockIcon, MapPinIcon } from "lucide-react";
import { useState } from "react";

import { Drawer, DrawerHeader, DrawerPanel, DrawerPopup, DrawerTitle } from "@/components/ui/drawer";
import { Separator } from "@/components/ui/separator";
import { formatDayHours, mapHref, todayStatus, weekdayNames, type WeekHours } from "@/lib/business-page";
import type { Clinic, Location } from "@/lib/domain";

import { useTerms } from "../terms/business-profile-context";

/**
 * The "Open today" line on the profile card. It is a button: it opens the week's hours for every
 * location in a drawer from the right, with today highlighted and the address.
 */
export function HoursButton({
  clinic,
  locations,
  hours,
  todayIndex,
}: {
  clinic: Pick<Clinic, "name" | "locale">;
  locations: Location[];
  hours: Record<string, WeekHours>;
  todayIndex: number;
}) {
  const t = useTerms();
  const [open, setOpen] = useState(false);
  const first = locations[0];
  const status = first ? todayStatus(hours[first.id], todayIndex, clinic.locale) : undefined;
  if (!status) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="inline-flex items-center gap-1.5 rounded-md text-start text-muted-foreground text-sm underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ClockIcon aria-hidden="true" className="size-4 shrink-0" />
        <span>{status.label}</span>
        <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="sr-only">, see all opening hours</span>
      </button>
      <Drawer open={open} onOpenChange={setOpen} position="right">
        <DrawerPopup showCloseButton variant="inset">
          <DrawerHeader>
            <DrawerTitle className="font-heading text-xl">Opening hours</DrawerTitle>
          </DrawerHeader>
          <DrawerPanel className="flex flex-col gap-5">
            {locations.map((location, index) => (
              <div key={location.id} className="flex flex-col gap-3">
                {index > 0 ? <Separator /> : null}
                <div className="flex flex-col gap-1">
                  <h3 className="font-medium text-sm">{locations.length > 1 ? location.name : t.Location}</h3>
                  <a
                    href={mapHref(location, clinic.name)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-start gap-1.5 text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
                  >
                    <MapPinIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    <span>
                      {[location.address, location.city].filter(Boolean).join(", ")}
                      <span className="sr-only"> (opens a map in a new tab)</span>
                    </span>
                  </a>
                  {location.accessibleEntrance ? (
                    <p className="inline-flex items-center gap-1.5 text-muted-foreground text-sm">
                      <AccessibilityIcon aria-hidden="true" className="size-4 shrink-0" />
                      Step-free entrance
                    </p>
                  ) : null}
                </div>
                {hours[location.id] ? (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
                    {weekdayNames.map((name, day) => (
                      <div key={name} className={day === todayIndex ? "contents font-medium" : "contents"}>
                        <dt className={day === todayIndex ? "" : "text-muted-foreground"}>
                          {name}
                          {day === todayIndex ? <span className="sr-only"> (today)</span> : null}
                        </dt>
                        <dd className="tabular-nums">{formatDayHours(hours[location.id]?.[day] ?? null, clinic.locale)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </div>
            ))}
          </DrawerPanel>
        </DrawerPopup>
      </Drawer>
    </>
  );
}
