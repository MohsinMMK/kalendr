"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { OptionSelect } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { formatShortDate, formatTime } from "@/features/booking/booking-format";
import type { LeaveBookingView, LeaveBookingsView, LeaveReassignResult } from "@/lib/routing-contracts";

import { staffMutation, staffQuery } from "./staff-snapshot-provider";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; view: LeaveBookingsView };

export interface ReassignPerson { id: string; name: string }

function failure(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** Moves the bookings that fall in a time off to its cover person, then lets staff hand the leftovers to someone else. */
export function TimeOffReassignDialog({
  open,
  onOpenChange,
  timeOffId,
  people,
  locale,
  zone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  timeOffId: string;
  /** Team members who could take a booking. */
  people: ReassignPerson[];
  locale: string;
  zone: string;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<LeaveReassignResult | null>(null);
  const [movedCount, setMovedCount] = useState(0);
  const [leftovers, setLeftovers] = useState<Array<{ appointmentId: string; reason: string }>>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [giving, setGiving] = useState<string | null>(null);
  const [giveError, setGiveError] = useState("");
  // The parent mounts this fresh for each open, so one key per open.
  const key = useRef<string>(crypto.randomUUID());

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    staffQuery<LeaveBookingsView>(`/api/staff/routing/leave/${encodeURIComponent(timeOffId)}`, controller.signal)
      .then((view) => { if (!controller.signal.aborted) setLoad({ state: "ready", view }); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setLoad({ state: "error", message: failure(cause, "The bookings could not be loaded.") }); });
    return () => controller.abort();
  }, [open, timeOffId, reloadKey]);

  const view = load.state === "ready" ? load.view : null;
  const cover = view?.coverName ?? "the cover person";
  const bookings = view?.bookings ?? [];
  const byId = new Map(bookings.map((entry) => [entry.appointmentId, entry]));

  const when = (entry: LeaveBookingView) => `${formatShortDate(entry.startsAt, locale, zone)}, ${formatTime(entry.startsAt, locale, zone)}`;

  const moveAll = useCallback(async () => {
    if (moving) return;
    setMoving(true);
    setError("");
    try {
      const outcome = await staffMutation<LeaveReassignResult>("/api/staff/routing/leave-reassign", "POST", { timeOffId }, { idempotencyKey: key.current });
      key.current = crypto.randomUUID();
      setResult(outcome);
      setMovedCount(outcome.moved);
      setLeftovers(outcome.needsPerson);
      toastManager.add({ title: `Moved ${outcome.moved}.`, type: "success" });
    } catch (cause: unknown) {
      setError(failure(cause, "The bookings could not be moved. Try again."));
      key.current = crypto.randomUUID();
    } finally {
      setMoving(false);
    }
  }, [moving, timeOffId]);

  async function giveTo(appointmentId: string) {
    const toPractitionerId = choice[appointmentId];
    if (!toPractitionerId || giving) return;
    setGiving(appointmentId);
    setGiveError("");
    try {
      const outcome = await staffMutation<LeaveReassignResult>("/api/staff/routing/leave-reassign", "POST", { timeOffId, toPractitionerId, appointmentIds: [appointmentId] }, { idempotencyKey: crypto.randomUUID() });
      if (outcome.moved > 0) {
        setMovedCount((count) => count + outcome.moved);
        setLeftovers((current) => current.filter((entry) => entry.appointmentId !== appointmentId));
      } else {
        const reason = outcome.needsPerson.find((entry) => entry.appointmentId === appointmentId)?.reason;
        setGiveError(reason ?? "That person could not take it.");
        if (reason) setLeftovers((current) => current.map((entry) => (entry.appointmentId === appointmentId ? { ...entry, reason } : entry)));
      }
    } catch (cause: unknown) {
      setGiveError(failure(cause, "It could not be moved. Try again."));
    } finally {
      setGiving(null);
    }
  }

  const noCover = view !== null && !view.coverPractitionerId;
  const done = result !== null;
  const heading = done
    ? `Moved ${movedCount}. ${leftovers.length} need${leftovers.length === 1 ? "s" : ""} a person.`
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Move bookings{view?.coverName ? ` to ${view.coverName}` : ""}</DialogTitle>
          <DialogDescription>Same booking, same time and same manage link. The customer is told.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          {load.state === "loading" ? (
            <div className="flex flex-col gap-2" aria-label="Loading bookings">
              <Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" />
            </div>
          ) : null}
          {load.state === "error" ? (
            <Alert variant="error"><AlertDescription className="flex flex-wrap items-center justify-between gap-3">{load.message}<Button size="sm" variant="outline" onClick={() => { setLoad({ state: "loading" }); setReloadKey((current) => current + 1); }}>Retry</Button></AlertDescription></Alert>
          ) : null}
          {noCover ? <p className="text-sm text-muted-foreground">No one is set to cover. Choose someone on the time off first.</p> : null}
          {view && !noCover && bookings.length === 0 ? <p className="text-sm text-muted-foreground">No bookings to move.</p> : null}
          {error ? <Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert> : null}
          {heading ? <Alert variant={leftovers.length > 0 ? "warning" : "success"}><AlertDescription role="status">{heading}</AlertDescription></Alert> : null}
          {view && !done && bookings.length > 0 ? (
            <ul className="flex flex-col divide-y rounded-xl border" aria-label="Bookings to move">
              {bookings.map((entry) => (
                <li key={entry.appointmentId} className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{when(entry)}</p>
                    <p className="truncate text-xs text-muted-foreground">{entry.serviceName} · {entry.customerName}</p>
                  </div>
                  {entry.coverFree === null ? null : entry.coverFree
                    ? <Badge variant="success">Free for {cover}</Badge>
                    : <Badge variant="warning">Busy - will need a person</Badge>}
                </li>
              ))}
            </ul>
          ) : null}
          {done && leftovers.length > 0 ? (
            <section aria-labelledby="needs-a-person" className="flex flex-col gap-2">
              <h4 id="needs-a-person" className="text-sm font-semibold">Needs a person</h4>
              {giveError ? <Alert variant="error"><AlertDescription>{giveError}</AlertDescription></Alert> : null}
              <ul className="flex flex-col divide-y rounded-xl border">
                {leftovers.map((entry) => {
                  const booking = byId.get(entry.appointmentId);
                  const name = booking ? `${when(booking)} · ${booking.serviceName}` : "Booking";
                  return (
                    <li key={entry.appointmentId} className="flex flex-col gap-2 px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{name}</p>
                        <p className="text-xs text-muted-foreground">{entry.reason}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <OptionSelect
                          aria-label={`Give ${name} to`}
                          size="lg"
                          className="min-w-0 flex-1"
                          placeholder="Choose a person"
                          value={choice[entry.appointmentId] ?? ""}
                          onValueChange={(next) => setChoice((current) => ({ ...current, [entry.appointmentId]: next }))}
                          options={people.map((person) => ({ value: person.id, label: person.name }))}
                          disabled={giving !== null}
                        />
                        <Button size="lg" variant="outline" disabled={!choice[entry.appointmentId] || giving !== null} onClick={() => void giveTo(entry.appointmentId)}>
                          {giving === entry.appointmentId ? <Spinner aria-hidden="true" /> : null}Give to
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="lg" />}>{done ? "Done" : "Cancel"}</DialogClose>
          {!done && view && !noCover && bookings.length > 0 ? (
            <Button size="lg" disabled={moving} onClick={() => void moveAll()}>
              {moving ? <Spinner aria-hidden="true" /> : null}Move {bookings.length} booking{bookings.length === 1 ? "" : "s"} to {cover}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
