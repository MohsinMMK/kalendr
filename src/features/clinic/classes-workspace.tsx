"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { CalendarPlus, ChevronLeft, ChevronRight, CloudOff, Dumbbell, Plus, TriangleAlert } from "lucide-react";

import type { ActionMenuEntry, BarAction } from "@/components/action-bar";
import { WorkspaceFrame, WorkspacePage } from "@/components/workspace-page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useTerms } from "@/features/terms/business-profile-context";

import { ClassTypeDialog } from "./class-type-dialog";
import { addDays, classKeys, dayHeading, fallbackZone, fetchSessions, groupByDay, todayKey, weekRange, weekStartOf, weekTitle } from "./class-model";
import { NewSessionDialog } from "./class-new-session-dialog";
import { RosterSheet } from "./class-roster-sheet";
import { SessionCard } from "./class-session-card";
import { useCatalogLookups } from "./clinic-catalog";
import { useStaffAccess } from "./staff-access";

/**
 * Classes (feature 18): the week's sessions, who has a seat, and the controls to add a session, change seats, cancel
 * and tell everyone. Tapping a session opens its roster.
 */
export function ClassesWorkspace() {
  const t = useTerms();
  const lookups = useCatalogLookups();
  const canManage = useStaffAccess().can("classes.manage");
  const [weekStart, setWeekStart] = useState(() => weekStartOf(todayKey()));
  const [dialog, setDialog] = useState<"session" | "class" | null>(null);
  const [newClassId, setNewClassId] = useState<string | undefined>(undefined);
  const [openId, setOpenId] = useState<string | null>(null);
  const range = weekRange(weekStart);
  const query = useQuery({
    queryKey: classKeys.range(range.from, range.to),
    queryFn: ({ signal }) => fetchSessions(range.from, range.to, signal),
    enabled: lookups.database,
  });
  const sessions = query.data ?? null;
  const error = query.error instanceof Error ? query.error.message : query.error ? "The sessions could not be loaded." : "";
  const zoneOf = (locationId: string) => lookups.getLocation(locationId)?.timezone ?? fallbackZone;
  const thisWeek = weekStartOf(todayKey());
  const manyPlaces = lookups.locations.length > 1;
  const reason = canManage ? undefined : "Ask the owner for the classes permission.";

  const pageProps: { nav: "classes"; bar: BarAction[]; menu: ActionMenuEntry[] } = {
    nav: "classes",
    bar: canManage ? [{ id: "new-session", label: "New session", icon: <Plus />, variant: "default", pinned: true, onSelect: () => setDialog("session") }] : [],
    menu: canManage ? [{ id: "new-class", label: "New class", icon: <Dumbbell />, hint: "A class has a length and seats", onSelect: () => setDialog("class") }] : [],
  };

  if (!lookups.database) {
    return (
      <WorkspacePage {...pageProps}>
        <WorkspaceFrame>
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon"><CloudOff aria-hidden="true" /></EmptyMedia>
            <EmptyTitle className="text-base">Classes need the live database</EmptyTitle>
            <EmptyDescription>This is a preview with sample data. Sign in to a real {t.business} to run classes.</EmptyDescription>
          </EmptyHeader>
        </Empty>
        </WorkspaceFrame>
      </WorkspacePage>
    );
  }

  const days = sessions ? groupByDay(sessions, (session) => zoneOf(session.locationId)) : [];
  return (
    <WorkspacePage {...pageProps}>
      <WorkspaceFrame
        start={<div className="flex min-w-0 items-center gap-2" role="group" aria-label="Choose a week">
        <Button variant="outline" size="icon" className="max-sm:size-11" aria-label="Previous week" onClick={() => setWeekStart((current) => addDays(current, -7))}><ChevronLeft aria-hidden="true" /></Button>
        <Button variant="outline" size="icon" className="max-sm:size-11" aria-label="Next week" onClick={() => setWeekStart((current) => addDays(current, 7))}><ChevronRight aria-hidden="true" /></Button>
        <Button variant="outline" className="max-sm:min-h-11" disabled={weekStart === thisWeek} onClick={() => setWeekStart(thisWeek)}>This week</Button>
        <h2 className="min-w-0 truncate text-sm font-medium tabular-nums" aria-live="polite">{weekTitle(weekStart)}</h2>
        </div>}
      >

      {error && sessions ? (
        <Alert variant="error" role="alert">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>The list may be out of date. {error}</span>
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>Try again</Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {query.isPending ? (
        <div aria-busy="true" role="status" className="flex flex-col gap-3">
          <span className="sr-only">Loading the sessions</span>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-20 w-full rounded-xl" />
        </div>
      ) : error && !sessions ? (
        <Alert variant="error" role="alert">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>Try again</Button>
          </AlertDescription>
        </Alert>
      ) : days.length === 0 ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon"><CalendarPlus aria-hidden="true" /></EmptyMedia>
            <EmptyTitle className="text-base">No sessions this week</EmptyTitle>
            <EmptyDescription>{canManage ? "Add a session, or a timetable that repeats." : "Sessions that are added will show here."}</EmptyDescription>
          </EmptyHeader>
          {canManage ? <EmptyContent><Button className="max-sm:min-h-11" onClick={() => setDialog("session")}><Plus aria-hidden="true" /> New session</Button></EmptyContent> : null}
        </Empty>
      ) : (
        <div className="flex flex-col gap-5">
          {days.map((group) => (
            <section key={group.day} aria-label={dayHeading(group.day)} className="flex flex-col gap-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{dayHeading(group.day)}</h3>
              <ul className="flex flex-col gap-2">
                {group.sessions.map((session) => (
                  <SessionCard
                    key={session.id}
                    session={session}
                    zone={zoneOf(session.locationId)}
                    {...(manyPlaces ? { locationName: lookups.locationName(session.locationId) } : {})}
                    onOpen={() => setOpenId(session.id)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      </WorkspaceFrame>

      {openId ? <RosterSheet sessionId={openId} canManage={canManage} disabledReason={reason} onClose={() => setOpenId(null)} /> : null}
      {dialog === "session" ? (
        <NewSessionDialog
          {...(newClassId ? { initialServiceId: newClassId } : {})}
          onClose={() => { setDialog(null); setNewClassId(undefined); }}
          onCreated={(date) => setWeekStart(weekStartOf(date))}
          onAddClass={() => setDialog("class")}
        />
      ) : null}
      {dialog === "class" ? <ClassTypeDialog onClose={() => setDialog(null)} onCreated={(serviceId) => { setNewClassId(serviceId); setDialog("session"); }} /> : null}
    </WorkspacePage>
  );
}
