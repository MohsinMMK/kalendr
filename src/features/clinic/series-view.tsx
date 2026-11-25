"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CalendarOff, Repeat, RotateCw, TriangleAlert } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Skeleton } from "@/components/ui/skeleton";
import { useTerms } from "@/features/terms/business-profile-context";
import type { AppointmentStatus } from "@/lib/domain";
import type { SeriesView } from "@/lib/series-contracts";

import { appointmentStatusTone } from "./task-ui";
import { statusLabel } from "./clinic-format";
import { loadSeries } from "./series-api";

type State = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; view: SeriesView };

/** Loads one series, with a way to try again. Shared by the series screen and the panel on a visit. */
export function useSeries(seriesId: string | undefined): { state: State; reload: () => void } {
  const [state, setState] = useState<State>({ state: "loading" });
  const run = useCallback(() => {
    if (!seriesId) return;
    loadSeries(seriesId).then((view) => setState({ state: "ready", view })).catch((cause: unknown) => setState({ state: "error", message: cause instanceof Error ? cause.message : "The series could not be loaded." }));
  }, [seriesId]);
  useEffect(() => { run(); }, [run]);
  const reload = () => { setState({ state: "loading" }); run(); };
  return { state, reload };
}

const dayTime = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));

/** A line on a visit's own screen: that it repeats, which one it is, and the way to the whole list. */
export function SeriesPanel({ seriesId, appointmentId }: { seriesId: string; appointmentId: string }) {
  const t = useTerms();
  const { state, reload } = useSeries(seriesId);
  return (
    <section aria-label={`Repeating ${t.visit}`} className="lg:col-start-1">
      <Frame>
        <FrameHeader className="px-3 py-2"><h2 className="flex items-center gap-2 text-sm font-medium"><Repeat aria-hidden="true" className="size-4 text-muted-foreground" /> Repeating {t.visit}</h2></FrameHeader>
        <FramePanel className="flex flex-col gap-2 p-4">
          {state.state === "loading" ? <div role="status"><span className="sr-only">Loading the series</span><Skeleton className="h-5 w-2/3" /></div> : null}
          {state.state === "error" ? <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">{state.message}<Button size="xs" variant="outline" onClick={reload}><RotateCw aria-hidden="true" /> Try again</Button></p> : null}
          {state.state === "ready" ? (() => {
            const position = state.view.visits.findIndex((visit) => visit.appointmentId === appointmentId) + 1;
            return <>
              <p className="text-sm font-medium">{state.view.summary}</p>
              <p className="text-xs text-muted-foreground tabular-nums">{position > 0 ? `${t.Visit} ${position} of ${state.view.visits.length}. ` : ""}Moving or cancelling asks which ones to change.</p>
            </>;
          })() : null}
        </FramePanel>
        <FrameFooter className="px-3 py-2"><Button size="sm" variant="outline" render={<Link href={`/appointments/series/${seriesId}`} />}>See every {t.visit}</Button></FrameFooter>
      </Frame>
    </section>
  );
}

/** Every visit of one series with its status, and the series it continues or was continued by. */
export function SeriesWorkspace({ seriesId, returnTo }: { seriesId: string; returnTo: "schedule" | "dashboard" | "bookings" }) {
  const t = useTerms();
  const { state, reload } = useSeries(seriesId);
  const back = returnTo === "dashboard" ? "/dashboard" : returnTo === "bookings" ? "/bookings?tab=repeating" : "/schedule";
  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <Button size="sm" variant="ghost" className="-ms-2 self-start" render={<Link href={back} />}><ArrowLeft aria-hidden="true" /> Back to {returnTo === "dashboard" ? "Today" : returnTo === "bookings" ? "Bookings" : "Schedule"}</Button>
      <PageHeader title={`Repeating ${t.appointments}`} description={state.state === "ready" ? state.view.summary : "Every date in this series and where it stands."} />
      {state.state === "loading" ? (
        <div role="status" className="flex max-w-3xl flex-col gap-2"><span className="sr-only">Loading the series</span>{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-12" />)}</div>
      ) : null}
      {state.state === "error" ? (
        <Alert variant="error" className="max-w-3xl"><TriangleAlert aria-hidden="true" /><AlertDescription className="flex flex-wrap items-center justify-between gap-2"><span>{state.message}</span><Button size="xs" variant="outline" onClick={reload}><RotateCw aria-hidden="true" /> Try again</Button></AlertDescription></Alert>
      ) : null}
      {state.state === "ready" && state.view.visits.length === 0 ? (
        <Empty><EmptyHeader><EmptyMedia variant="icon"><CalendarOff aria-hidden="true" /></EmptyMedia><EmptyTitle>No {t.appointments} in this series</EmptyTitle><EmptyDescription>Every {t.visit} was moved to another series or removed.</EmptyDescription></EmptyHeader></Empty>
      ) : null}
      {state.state === "ready" && state.view.visits.length > 0 ? (
        <Frame className="max-w-3xl">
          <FrameHeader className="flex-row flex-wrap items-center justify-between gap-2 px-3 py-2">
            <h2 className="text-sm font-medium tabular-nums">{state.view.visits.length} {state.view.visits.length === 1 ? t.appointment : t.appointments}</h2>
            <StatusBadge tone={state.view.status === "active" ? "success" : "neutral"}>{state.view.status === "active" ? "Running" : state.view.status === "cancelled" ? "Cancelled" : "Ended"}</StatusBadge>
          </FrameHeader>
          <FramePanel className="p-2">
            <ol aria-label={`Every ${t.visit}`} className="flex flex-col">
              {state.view.visits.map((visit) => (
                <li key={visit.appointmentId} className="border-b last:border-b-0">
                  <Link href={`/appointments/${visit.appointmentId}?from=${returnTo}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-md px-2 py-2 outline-none hover:bg-accent/64 focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="text-sm font-medium tabular-nums"><span className="me-2 text-xs font-normal text-muted-foreground">{visit.index}</span>{dayTime(visit.startsAt, state.view.timezone)}</span>
                    <StatusBadge tone={appointmentStatusTone(visit.status as AppointmentStatus)}>{statusLabel(visit.status as AppointmentStatus)}</StatusBadge>
                  </Link>
                </li>
              ))}
            </ol>
          </FramePanel>
          {state.view.continuedFromId || state.view.continuedById ? (
            <FrameFooter className="flex flex-row flex-wrap gap-2 px-3 py-2">
              {state.view.continuedFromId ? <Button size="sm" variant="outline" render={<Link href={`/appointments/series/${state.view.continuedFromId}`} />}>Earlier part of this series</Button> : null}
              {state.view.continuedById ? <Button size="sm" variant="outline" render={<Link href={`/appointments/series/${state.view.continuedById}`} />}>Changed from here: see the new part</Button> : null}
            </FrameFooter>
          ) : null}
        </Frame>
      ) : null}
    </div>
  );
}
