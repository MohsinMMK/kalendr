"use client";

import { CalendarX2, ChevronLeft, ChevronRight, Clock3, TriangleAlert, UserRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SelectField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type { TimetableSession } from "@/lib/classes-contracts";
import { formatMoney } from "@/lib/money";

import { useTerms } from "../terms/business-profile-context";
import { formatTimeZoneName, getDateKey } from "./booking-format";
import { ClassEnrolDialog } from "./class-enrol-dialog";
import { addDaysToKey, dayStartUtc, formatClock, formatDayKey, todayKey } from "./zone-time";

export interface TimetablePlace {
  id: string;
  name: string;
  timezone: string;
}

const MAX_WEEKS_AHEAD = 12;
const ALL = "__all__";

/** The window for a week: this week starts now, later weeks start at midnight in the business's zone. */
export function weekRange(weekIndex: number, zone: string, now: Date = new Date()): { from: Date; to: Date } {
  const today = todayKey(zone, now);
  return {
    from: weekIndex === 0 ? now : dayStartUtc(addDaysToKey(today, weekIndex * 7), zone),
    to: dayStartUtc(addDaysToKey(today, (weekIndex + 1) * 7), zone),
  };
}

type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; sessions: TimetableSession[] };

function seatsText(session: TimetableSession): string {
  if (session.state === "closed") return "Closed";
  if (session.state === "full") return "Full: join the waiting list";
  return `${session.seatsLeft} left`;
}

/**
 * The public class timetable (feature 18). Days of classes with the time, teacher and seats left; each open or full class
 * has one button that opens the enrol dialog. Filters work on what is loaded; the week arrows fetch the next seven days.
 */
export function ClassTimetable({ clinicSlug, businessName, businessZone, locale, places, initialSessions }: {
  clinicSlug: string;
  businessName: string;
  businessZone: string;
  locale: string;
  places: TimetablePlace[];
  initialSessions: TimetableSession[] | null;
}) {
  const t = useTerms();
  const [week, setWeek] = useState(0);
  const [load, setLoad] = useState<Load>(initialSessions ? { kind: "ready", sessions: initialSessions } : { kind: "loading" });
  const [classFilter, setClassFilter] = useState(ALL);
  const [placeFilter, setPlaceFilter] = useState(ALL);
  const [chosen, setChosen] = useState<TimetableSession | null>(null);
  const [known, setKnown] = useState<Map<string, string>>(() => new Map((initialSessions ?? []).map((session) => [session.serviceId, session.serviceName])));
  const requestRef = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const skipInitial = useRef(initialSessions !== null);

  const zoneOf = useCallback((locationId: string) => places.find((place) => place.id === locationId)?.timezone ?? businessZone, [places, businessZone]);

  const fetchWeek = useCallback(async (weekIndex: number, quiet = false) => {
    const ticket = ++requestRef.current;
    if (!quiet) setLoad({ kind: "loading" });
    const { from, to } = weekRange(weekIndex, businessZone);
    try {
      const response = await fetch(`/api/public/classes?${new URLSearchParams({ clinicSlug, from: from.toISOString(), to: to.toISOString() })}`, { headers: { Accept: "application/json" } });
      const body = (await response.json().catch(() => null)) as { data?: { sessions: TimetableSession[] }; error?: { message?: string } } | null;
      if (ticket !== requestRef.current) return;
      if (!response.ok || !body?.data) {
        setLoad({ kind: "error", message: body?.error?.message ?? "We could not load the timetable." });
        return;
      }
      const { sessions } = body.data;
      setKnown((current) => {
        const next = new Map(current);
        for (const session of sessions) next.set(session.serviceId, session.serviceName);
        return next;
      });
      setLoad({ kind: "ready", sessions });
    } catch {
      if (ticket === requestRef.current) setLoad({ kind: "error", message: "We could not reach the server. Check your connection and try again." });
    }
  }, [businessZone, clinicSlug]);

  useEffect(() => {
    if (skipInitial.current) { skipInitial.current = false; return; }
    void fetchWeek(week);
  }, [week, fetchWeek]);

  const sessions = useMemo(() => (load.kind === "ready" ? load.sessions : []), [load]);
  const visible = useMemo(
    () => sessions.filter((session) => (classFilter === ALL || session.serviceId === classFilter) && (placeFilter === ALL || session.locationId === placeFilter)),
    [sessions, classFilter, placeFilter],
  );
  const days = useMemo(() => {
    const groups = new Map<string, TimetableSession[]>();
    for (const session of visible) {
      const key = getDateKey(session.startsAt, zoneOf(session.locationId));
      groups.set(key, [...(groups.get(key) ?? []), session]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visible, zoneOf]);

  const classOptions = [{ value: ALL, label: "All classes" }, ...[...known.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }))];
  const placeOptions = [{ value: ALL, label: `All ${t.locations}` }, ...places.map((place) => ({ value: place.id, label: place.name }))];
  const filtered = classFilter !== ALL || placeFilter !== ALL;
  const { from, to } = weekRange(week, businessZone);
  const rangeLabel = `${formatDayKey(getDateKey(from.toISOString(), businessZone), locale, { day: "numeric", month: "short" })} to ${formatDayKey(getDateKey(new Date(to.getTime() - 1).toISOString(), businessZone), locale, { day: "numeric", month: "short" })}`;
  const today = todayKey(businessZone);

  function dayHeading(key: string): string {
    if (key === today) return "Today";
    if (key === addDaysToKey(today, 1)) return "Tomorrow";
    return formatDayKey(key, locale);
  }

  function go(next: number) {
    setWeek(next);
    headingRef.current?.focus();
  }

  return (
    <section aria-labelledby="class-timetable-title" className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 id="class-timetable-title" ref={headingRef} tabIndex={-1} className="font-heading font-semibold text-2xl outline-none">Class timetable</h1>
        <p className="text-muted-foreground text-sm">{`Pick a class at ${businessName} and book a seat. Times are in ${formatTimeZoneName(businessZone, locale)}.`}</p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SelectField id="class-filter" label="Class" value={classFilter} onValueChange={(next) => setClassFilter(next || ALL)} options={classOptions} />
        {places.length > 1 ? (
          <SelectField id="place-filter" label={t.Location} value={placeFilter} onValueChange={(next) => setPlaceFilter(next || ALL)} options={placeOptions} />
        ) : null}
      </div>

      <nav aria-label="Week" className="flex items-center justify-between gap-2">
        <Button variant="outline" size="lg" disabled={week === 0 || load.kind === "loading"} onClick={() => go(week - 1)} aria-label="Previous week">
          <ChevronLeft aria-hidden="true" /> <span className="max-sm:sr-only">Previous</span>
        </Button>
        <p className="text-center font-medium text-sm tabular-nums" aria-live="polite">{week === 0 ? `Next 7 days, ${rangeLabel}` : rangeLabel}</p>
        <Button variant="outline" size="lg" disabled={week >= MAX_WEEKS_AHEAD || load.kind === "loading"} onClick={() => go(week + 1)} aria-label="Next week">
          <span className="max-sm:sr-only">Next</span> <ChevronRight aria-hidden="true" />
        </Button>
      </nav>

      {load.kind === "loading" ? (
        <div role="status" aria-label="Loading the timetable" className="flex flex-col gap-3">
          {[0, 1, 2].map((index) => <Skeleton key={index} className="h-24 w-full rounded-xl" />)}
        </div>
      ) : load.kind === "error" ? (
        <Alert variant="error" role="alert">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>{load.message}</span>
            <Button variant="outline" size="lg" onClick={() => void fetchWeek(week)}>Retry</Button>
          </AlertDescription>
        </Alert>
      ) : sessions.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><CalendarX2 aria-hidden="true" /></EmptyMedia>
            <EmptyTitle className="font-semibold"><h2>No classes in this week</h2></EmptyTitle>
            <EmptyDescription>Try the next week, or check back soon.</EmptyDescription>
          </EmptyHeader>
          {week < MAX_WEEKS_AHEAD ? <EmptyContent><Button size="lg" onClick={() => go(week + 1)}>See next week</Button></EmptyContent> : null}
        </Empty>
      ) : visible.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><CalendarX2 aria-hidden="true" /></EmptyMedia>
            <EmptyTitle className="font-semibold"><h2>No classes match</h2></EmptyTitle>
            <EmptyDescription>Nothing this week fits the choices above.</EmptyDescription>
          </EmptyHeader>
          {filtered ? <EmptyContent><Button size="lg" variant="outline" onClick={() => { setClassFilter(ALL); setPlaceFilter(ALL); }}>Show all classes</Button></EmptyContent> : null}
        </Empty>
      ) : (
        <div className="flex flex-col gap-6">
          {days.map(([key, daySessions]) => (
            <section key={key} aria-labelledby={`day-${key}`} className="flex flex-col gap-2">
              <h2 id={`day-${key}`} className="font-heading font-semibold text-base">{dayHeading(key)}{key === today || key === addDaysToKey(today, 1) ? <span className="ms-2 font-normal text-muted-foreground text-sm">{formatDayKey(key, locale, { day: "numeric", month: "long" })}</span> : null}</h2>
              <ul className="flex flex-col gap-2">
                {daySessions.map((session) => {
                  const zone = zoneOf(session.locationId);
                  const place = places.length > 1 ? places.find((candidate) => candidate.id === session.locationId)?.name : undefined;
                  const closed = session.state === "closed";
                  const low = session.state === "open" && session.seatsLeft <= 3;
                  return (
                    <li key={session.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 flex-col gap-1">
                        <p className="flex items-center gap-1.5 font-medium text-sm tabular-nums">
                          <Clock3 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                          {`${formatClock(session.startsAt, locale, zone)} to ${formatClock(session.endsAt, locale, zone)}`}
                        </p>
                        <p className="wrap-break-word font-heading font-semibold text-base">{session.serviceName}</p>
                        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-sm">
                          <span className="flex items-center gap-1.5"><UserRound aria-hidden="true" className="size-4" />{session.teacherName}</span>
                          {place ? <span>{place}</span> : null}
                          {session.priceMinor !== null && session.priceMinor > 0 ? <span>{formatMoney(session.priceMinor, session.currency, locale)}</span> : null}
                        </p>
                        <p className="mt-0.5">
                          <Badge variant={closed ? "outline" : session.state === "full" || low ? "warning" : "success"} size="lg">{seatsText(session)}</Badge>
                        </p>
                      </div>
                      {closed ? null : (
                        <Button size="lg" className="w-full shrink-0 sm:w-auto" onClick={() => setChosen(session)} aria-label={`${session.state === "full" ? "Join waiting list" : "Book a seat"}: ${session.serviceName}, ${dayHeading(key)} ${formatClock(session.startsAt, locale, zone)}`}>
                          {session.state === "full" ? "Join waiting list" : "Book a seat"}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      <ClassEnrolDialog
        session={chosen}
        clinicSlug={clinicSlug}
        businessName={businessName}
        locale={locale}
        zone={chosen ? zoneOf(chosen.locationId) : businessZone}
        onClose={() => setChosen(null)}
        onChanged={() => void fetchWeek(week, true)}
      />
    </section>
  );
}
