"use client";

import { format } from "date-fns";
import { CalendarDays, CircleCheck, CircleSlash, Clock, Hourglass, Lock, Palmtree, PartyPopper, RefreshCw, TriangleAlert, UserRound } from "lucide-react";
import { useEffect, useState, type ComponentType } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { ResponsiveDrawer, ResponsiveDrawerPopup } from "@/components/responsive-drawer";
import { DrawerDescription, DrawerFooter, DrawerHeader, DrawerPanel, DrawerTitle } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { OptionSelect } from "@/components/form-fields";
import { MenuItem } from "@/components/ui/menu";
import { useTerms } from "@/features/terms/business-profile-context";
import type { ExplainBand, ExplainReason, ExplainResult } from "@/lib/availability-setup";
import { cn } from "@/lib/utils";

import { useCatalogLookups } from "./clinic-catalog";
import { useStaffAccess } from "./staff-access";

/** How each reason looks: a name, an icon and a colour, so colour is never the only signal. */
const reasonStyles: Record<ExplainReason | "offered", { title: string; icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>; bar: string }> = {
  offered: { title: "Offered", icon: CircleCheck, bar: "bg-emerald-500/70" },
  outside_hours: { title: "Outside working hours", icon: Clock, bar: "bg-muted-foreground/25" },
  holiday: { title: "Holiday", icon: PartyPopper, bar: "bg-violet-500/60" },
  out_of_office: { title: "Out of office", icon: Palmtree, bar: "bg-amber-500/60" },
  blocked_off: { title: "Time blocked off", icon: Lock, bar: "bg-rose-500/50" },
  outside_restriction: { title: "Outside the hours for this service", icon: CircleSlash, bar: "bg-muted-foreground/40" },
  already_booked: { title: "Already booked", icon: UserRound, bar: "bg-blue-500/60" },
  buffer_before: { title: "Buffer before a booking", icon: Hourglass, bar: "bg-sky-400/60" },
  buffer_after: { title: "Buffer after a booking", icon: Hourglass, bar: "bg-sky-400/60" },
  within_minimum_notice: { title: "Too soon to book online", icon: Clock, bar: "bg-orange-400/60" },
  beyond_booking_window: { title: "Beyond the booking window", icon: CalendarDays, bar: "bg-orange-500/50" },
  no_free_resource: { title: "No room free", icon: CircleSlash, bar: "bg-rose-400/50" },
  person_does_not_offer: { title: "Not offered by this person", icon: CircleSlash, bar: "bg-muted-foreground/40" },
  not_a_start_time: { title: "Not a start time for this service", icon: Clock, bar: "bg-muted-foreground/15" },
  daily_limit_reached: { title: "Daily limit reached", icon: TriangleAlert, bar: "bg-red-500/55" },
  period_limit_reached: { title: "Limit reached", icon: TriangleAlert, bar: "bg-red-500/55" },
  busy_in_calendar: { title: "Busy in a connected calendar", icon: CalendarDays, bar: "bg-indigo-500/55" },
};

function styleOf(reason: ExplainReason | null) {
  return reasonStyles[reason ?? "offered"];
}

function minutesOf(time: string): number {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function dateKey(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

type Load = { state: "idle" } | { state: "loading" } | { state: "error"; message: string } | { state: "ready"; result: ExplainResult };

async function fetchExplain(query: URLSearchParams): Promise<ExplainResult> {
  const response = await fetch(`/api/staff/availability/explain?${query.toString()}`);
  const body: unknown = await response.json().catch(() => null);
  if (response.ok && typeof body === "object" && body !== null && "data" in body) return (body as { data: ExplainResult }).data;
  const message = typeof body === "object" && body !== null && "error" in body ? (body as { error?: { message?: string } }).error?.message : undefined;
  throw new Error(message ?? "We could not check that day. Try again.");
}

/** Shows which rule closed each stretch of a day for one person and service, read-only. */
export function WhyNoSlotSheet({ open, onOpenChange, practitionerId: initialPractitionerId, locationId: initialLocationId, serviceId: initialServiceId }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  practitionerId?: string;
  locationId?: string;
  /** Starts on this service, for the link from the service editor. */
  serviceId?: string;
}) {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const [practitionerId, setPractitionerId] = useState(initialPractitionerId ?? "");
  const [serviceId, setServiceId] = useState(initialServiceId ?? "");
  const [locationId, setLocationId] = useState(initialLocationId ?? "");
  const [day, setDay] = useState<Date>(() => new Date());
  const [load, setLoad] = useState<Load>({ state: "idle" });

  const people = catalog.practitioners.filter((person) => person.isActive !== false);
  const person = people.find((item) => item.id === practitionerId);
  const services = catalog.services.filter((service) => service.isActive !== false && service.practitionerIds.includes(practitionerId));
  const ownPlaces = catalog.locations.filter((place) => !person || person.locationIds.includes(place.id));
  const places = ownPlaces.length ? ownPlaces : catalog.locations;
  const effectiveLocation = places.some((place) => place.id === locationId) ? locationId : places[0]?.id ?? "";
  const effectiveService = services.some((service) => service.id === serviceId) ? serviceId : "";
  const ready = Boolean(practitionerId && effectiveService && effectiveLocation);
  const dayKey = dateKey(day);

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    let current = true;
    if (!ready) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoad({ state: "idle" });
      return;
    }
    setLoad({ state: "loading" });
    fetchExplain(new URLSearchParams({ practitionerId, serviceId: effectiveService, locationId: effectiveLocation, date: dayKey }))
      .then((result) => { if (current) setLoad({ state: "ready", result }); })
      .catch((cause: unknown) => { if (current) setLoad({ state: "error", message: cause instanceof Error ? cause.message : "We could not check that day. Try again." }); });
    return () => { current = false; };
  }, [open, ready, practitionerId, effectiveService, effectiveLocation, dayKey, attempt]);

  return (
    <ResponsiveDrawer open={open} onOpenChange={onOpenChange}>
      <ResponsiveDrawerPopup variant="inset">
        <DrawerHeader>
          <DrawerTitle>Why no slot?</DrawerTitle>
          <DrawerDescription>Pick {t.aPractitioner}, a {t.service} and a day. We show which rule closed each time.</DrawerDescription>
        </DrawerHeader>
        <DrawerPanel>
          {!catalog.database ? (
            <Alert><AlertDescription>This check needs your real schedule, so it is not available in the preview.</AlertDescription></Alert>
          ) : (
            <div className="flex flex-col gap-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium" id="why-person-label">{t.Practitioner}</span>
                  <OptionSelect aria-label={t.Practitioner} size="default" value={practitionerId} placeholder={`Choose ${t.aPractitioner}`} onValueChange={(next) => { setPractitionerId(next); setServiceId(""); }} options={people.map((item) => ({ value: item.id, label: item.name }))} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">{t.Service}</span>
                  <OptionSelect aria-label={t.Service} size="default" value={effectiveService} disabled={!practitionerId} placeholder={practitionerId ? `Choose a ${t.service}` : `Choose ${t.aPractitioner} first`} onValueChange={setServiceId} options={services.map((item) => ({ value: item.id, label: item.name }))} />
                </div>
                {places.length > 1 ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">Location</span>
                    <OptionSelect aria-label="Location" size="default" value={effectiveLocation} onValueChange={setLocationId} options={places.map((item) => ({ value: item.id, label: item.name }))} />
                  </div>
                ) : null}
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">Day</span>
                  <Popover>
                    <PopoverTrigger render={<Button variant="outline" className="min-h-11 justify-start font-normal" aria-label={`${format(day, "EEE d MMM yyyy")}, change day`} />}>
                      <CalendarDays aria-hidden="true" /> {format(day, "EEE d MMM yyyy")}
                    </PopoverTrigger>
                    <PopoverPopup align="start">
                      <Calendar mode="single" selected={day} onSelect={(next) => { if (next) setDay(next); }} />
                    </PopoverPopup>
                  </Popover>
                </div>
              </div>

              <Result load={load} ready={ready} onRetry={() => setAttempt((count) => count + 1)} />
            </div>
          )}
        </DrawerPanel>
        <DrawerFooter>
          <p className="text-xs text-muted-foreground">This only reads your settings. Nothing changes.</p>
        </DrawerFooter>
      </ResponsiveDrawerPopup>
    </ResponsiveDrawer>
  );
}

function Result({ load, ready, onRetry }: { load: Load; ready: boolean; onRetry: () => void }) {
  if (!ready || load.state === "idle") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><CalendarDays aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>Choose who, what and when</EmptyTitle>
          <EmptyDescription>The day appears here once all three are chosen.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (load.state === "loading") {
    return <div className="flex flex-col gap-2" role="status" aria-label="Checking the day"><Skeleton className="h-10 w-full" /><Skeleton className="h-24 w-full" /></div>;
  }
  if (load.state === "error") {
    return (
      <Alert variant="error">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
          <span>{load.message}</span>
          <Button size="sm" variant="outline" className="min-h-11" onClick={onRetry}><RefreshCw aria-hidden="true" /> Try again</Button>
        </AlertDescription>
      </Alert>
    );
  }
  return <Timeline result={load.result} />;
}

function Timeline({ result }: { result: ExplainResult }) {
  const offeredCount = result.bands.filter((band) => band.reason === null).length;
  const used = [...new Set(result.bands.map((band) => band.reason))];
  return (
    <div className="flex flex-col gap-4">
      {result.outOfOfficeNote ? <Alert><AlertDescription>Out of office: {result.outOfOfficeNote}</AlertDescription></Alert> : null}
      {offeredCount === 0 ? <p className="text-sm text-muted-foreground">Nothing is offered on this day. The reasons are below.</p> : null}

      <div aria-hidden="true" className="flex h-8 w-full overflow-hidden rounded-lg border">
        {result.bands.map((band) => (
          <div key={`${band.from}-${band.to}`} className={cn("h-full", styleOf(band.reason).bar)} style={{ width: `${((minutesOf(band.to === "00:00" ? "24:00" : band.to) - minutesOf(band.from)) / 1440) * 100}%` }} title={`${band.from} to ${band.to}: ${band.label || styleOf(band.reason).title}`} />
        ))}
      </div>
      <div aria-hidden="true" className="-mt-3 flex justify-between text-[11px] tabular-nums text-muted-foreground"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>

      <ol className="flex flex-col divide-y rounded-xl border" aria-label={`What happens on ${result.date}`}>
        {result.bands.map((band) => <BandRow key={`${band.from}-${band.to}`} band={band} />)}
      </ol>

      <ul className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground" aria-label="Legend">
        {used.map((reason) => {
          const style = styleOf(reason);
          return <li key={reason ?? "offered"} className="flex items-center gap-1.5"><span aria-hidden="true" className={cn("size-3 rounded-sm border", style.bar)} />{style.title}</li>;
        })}
      </ul>
    </div>
  );
}

function BandRow({ band }: { band: ExplainBand }) {
  const style = styleOf(band.reason);
  const Icon = style.icon;
  return (
    <li className="flex min-h-11 items-center gap-3 px-3 py-2">
      <span aria-hidden="true" className={cn("h-8 w-1.5 shrink-0 rounded-full", style.bar)} />
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="w-28 shrink-0 text-sm tabular-nums">{band.from} to {band.to === "00:00" ? "24:00" : band.to}</span>
      <span className="min-w-0 flex-1 text-sm">{band.reason === null ? "Offered" : band.label || style.title}</span>
    </li>
  );
}

/** The ⋯ menu entry that opens the sheet. Renders nothing for people without `schedule.read`. */
export function WhyNoSlotMenuItem({ onOpen }: { onOpen: () => void }) {
  const access = useStaffAccess();
  if (!access.can("schedule.read")) return null;
  return <MenuItem onClick={onOpen}><CircleSlash aria-hidden="true" /> Why no slot?</MenuItem>;
}

/** A quiet link-style button for a person's settings; opens the sheet for that person. */
export function WhyNoSlotButton({ practitionerId }: { practitionerId: string }) {
  const access = useStaffAccess();
  const [open, setOpen] = useState(false);
  if (!access.can("schedule.read")) return null;
  return (
    <>
      <Button type="button" variant="ghost" size="sm" className="min-h-11 self-start" onClick={() => setOpen(true)}><CircleSlash aria-hidden="true" /> Why is a time missing?</Button>
      {open ? <WhyNoSlotSheet open onOpenChange={setOpen} practitionerId={practitionerId} /> : null}
    </>
  );
}
