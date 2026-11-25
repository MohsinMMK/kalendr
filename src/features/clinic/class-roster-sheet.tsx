"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Ban, Hourglass, MessageSquare, Pencil, TriangleAlert, UserPlus } from "lucide-react";

import { ActionMenuButton } from "@/components/action-bar";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ResponsiveDrawer, ResponsiveDrawerPopup } from "@/components/responsive-drawer";
import { DrawerDescription, DrawerHeader, DrawerPanel, DrawerTitle } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { useIsMobile } from "@/hooks/use-media-query";
import { useTerms } from "@/features/terms/business-profile-context";
import type { RosterEntry, SessionDetail } from "@/lib/classes-contracts";

import { CancelSessionDialog, MessageDialog, SeatsDialog, WalkInDialog } from "./class-roster-dialogs";
import { RosterRow } from "./class-roster-row";
import { SeatsMeter } from "./class-session-card";
import { classKeys, clockText, dayHeading, dateKeyIn, fallbackZone, fetchSession, markAttendance, timeRange } from "./class-model";
import { useCatalogLookups } from "./clinic-catalog";
import { StaffApiError } from "./queries/http";

type Dialog = "walk-in" | "message" | "seats" | "cancel" | null;

/**
 * The roster of one session: its facts, who has a seat with one-tap Present and Absent, who is waiting, and the
 * controls to add a walk-in, message everyone, change seats or cancel. A bottom sheet on a phone.
 */
export function RosterSheet({ sessionId, canManage, disabledReason, onClose }: { sessionId: string; canManage: boolean; disabledReason?: string | undefined; onClose: () => void }) {
  const t = useTerms();
  const mobile = useIsMobile();
  const lookups = useCatalogLookups();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busyId, setBusyId] = useState("");
  const query = useQuery({ queryKey: classKeys.detail(sessionId), queryFn: ({ signal }) => fetchSession(sessionId, signal) });
  const session = query.data ?? null;
  const error = query.error instanceof Error ? query.error.message : query.error ? "The roster could not be loaded." : "";
  const zone = session ? lookups.getLocation(session.locationId)?.timezone ?? fallbackZone : fallbackZone;

  /** Stores the session the server sent back, and lets the week list look again. */
  function accept(next: SessionDetail) {
    queryClient.setQueryData(classKeys.detail(sessionId), next);
    void queryClient.invalidateQueries({ queryKey: [...classKeys.all, "range"] });
  }

  async function mark(entry: RosterEntry, outcome: "attended" | "no_show" | "booked") {
    setBusyId(entry.enrolmentId);
    try {
      accept(await markAttendance(sessionId, { enrolmentId: entry.enrolmentId, expectedVersion: entry.version, outcome }));
    } catch (cause: unknown) {
      if (cause instanceof StaffApiError && cause.code === "version_conflict") {
        await query.refetch();
        toastManager.add({ title: "Someone else just changed this", description: "The roster has been refreshed. Try again.", type: "warning" });
      } else {
        toastManager.add({ title: cause instanceof Error ? cause.message : "The change could not be saved.", type: "error" });
      }
    } finally {
      setBusyId("");
    }
  }

  const seated = session?.roster.filter((entry) => entry.status !== "waitlisted") ?? [];
  const waiting = session?.roster.filter((entry) => entry.status === "waitlisted") ?? [];
  const cancelled = session?.status === "cancelled";
  const editable = canManage && !cancelled && Boolean(session);

  return (
    <>
      <ResponsiveDrawer open onOpenChange={(next) => { if (!next) onClose(); }}>
        <ResponsiveDrawerPopup variant={mobile ? "default" : "inset"}>
          <DrawerHeader>
            <DrawerTitle>{session?.serviceName ?? "Session"}</DrawerTitle>
            <DrawerDescription>
              {session ? `${dayHeading(dateKeyIn(session.startsAt, zone))} · ${timeRange(session, zone)}` : "Loading the roster"}
            </DrawerDescription>
          </DrawerHeader>
          <DrawerPanel className="flex flex-col gap-5">
            {query.isPending ? (
              <div aria-busy="true" role="status" className="flex flex-col gap-3">
                <span className="sr-only">Loading the roster</span>
                <Skeleton className="h-16 w-full rounded-xl" />
                <Skeleton className="h-12 w-full rounded-xl" />
                <Skeleton className="h-12 w-full rounded-xl" />
              </div>
            ) : error && !session ? (
              <Alert variant="error" role="alert">
                <TriangleAlert aria-hidden="true" />
                <AlertDescription className="flex flex-col items-start gap-2">
                  <span>{error}</span>
                  <Button size="sm" variant="outline" onClick={() => void query.refetch()}>Try again</Button>
                </AlertDescription>
              </Alert>
            ) : session ? (
              <>
                {error ? <Alert variant="error" role="alert"><TriangleAlert aria-hidden="true" /><AlertDescription>The roster may be out of date. {error}</AlertDescription></Alert> : null}
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div><dt className="text-xs text-muted-foreground">Teacher</dt><dd className="font-medium">{session.teacherName}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Place</dt><dd className="font-medium">{lookups.locationName(session.locationId)}</dd></div>
                  <div className="col-span-2"><SeatsMeter session={session} /></div>
                </dl>
                {cancelled ? <StatusBadge tone="danger">This session is cancelled</StatusBadge> : null}

                <div className="flex min-w-0 flex-nowrap items-center gap-2">
                  <Button size="sm" className="shrink-0 max-sm:min-h-11" disabled={!editable} onClick={() => setDialog("walk-in")}><UserPlus aria-hidden="true" /> Add walk-in</Button>
                  <Button size="sm" variant="outline" className="shrink-0 max-sm:min-h-11" disabled={!editable} onClick={() => setDialog("message")}><MessageSquare aria-hidden="true" /> Message everyone</Button>
                  <ActionMenuButton
                    label="More actions"
                    iconOnly
                    icon={<span aria-hidden="true">⋯</span>}
                    disabled={!editable}
                    className="max-sm:size-11"
                    items={[
                      { id: "seats", label: "Change seats", icon: <Pencil />, onSelect: () => setDialog("seats") },
                      { id: "cancel", label: "Cancel session", icon: <Ban />, destructive: true, onSelect: () => setDialog("cancel") },
                    ]}
                  />
                </div>
                {canManage ? null : <p className="text-xs text-muted-foreground">{disabledReason}</p>}

                <section aria-label={`Seats (${seated.length})`} className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium">{`With a seat (${seated.length})`}</h3>
                  {seated.length === 0 ? <p className="text-sm text-muted-foreground">{`Nobody has a seat yet. When a ${t.customer} books, they show here.`}</p> : (
                    <ul className="flex flex-col divide-y rounded-xl border">
                      {seated.map((entry) => <RosterRow key={entry.enrolmentId} entry={entry} busy={busyId === entry.enrolmentId} disabled={!editable} onMark={(outcome) => void mark(entry, outcome)} />)}
                    </ul>
                  )}
                </section>

                {waiting.length > 0 ? (
                  <section aria-label={`Waiting list (${waiting.length})`} className="flex flex-col gap-2">
                    <h3 className="text-sm font-medium">{`Waiting list (${waiting.length})`}</h3>
                    <ol className="flex flex-col divide-y rounded-xl border">
                      {waiting.map((entry) => (
                        <li key={entry.enrolmentId} className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                          <span className="flex min-w-0 items-center gap-2">
                            <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums text-muted-foreground">{entry.position}</span>
                            <span className="truncate font-medium">{entry.name}</span>
                            <span className="sr-only">{`Place ${entry.position} in line`}</span>
                          </span>
                          {entry.offerExpiresAt ? <Badge variant="warning" size="lg"><Hourglass aria-hidden="true" />{`Offer holds until ${clockText(entry.offerExpiresAt, zone)}`}</Badge> : <Badge variant="secondary" size="lg">Waiting</Badge>}
                        </li>
                      ))}
                    </ol>
                  </section>
                ) : null}
              </>
            ) : null}
          </DrawerPanel>
        </ResponsiveDrawerPopup>
      </ResponsiveDrawer>
      {session && dialog === "walk-in" ? <WalkInDialog session={session} onClose={() => setDialog(null)} onDone={accept} /> : null}
      {session && dialog === "message" ? <MessageDialog session={session} onClose={() => setDialog(null)} /> : null}
      {session && dialog === "seats" ? <SeatsDialog session={session} onClose={() => setDialog(null)} onDone={accept} onConflict={() => void query.refetch()} /> : null}
      {session && dialog === "cancel" ? <CancelSessionDialog session={session} onClose={() => setDialog(null)} onDone={() => { void queryClient.invalidateQueries({ queryKey: classKeys.all }); onClose(); }} onConflict={() => void query.refetch()} /> : null}
    </>
  );
}
