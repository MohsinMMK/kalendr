"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import type { Appointment } from "@/lib/domain";

import { appointmentDay, appointmentTime } from "./clinic-format";
import { LimitOverridePrompt, useLimitOverride } from "./limit-override";
import { type MutationResult, type RescheduleRequest, rescheduleFailure, useRescheduleAppointment } from "./queries/appointment-mutations";

/** How long the Undo toast stays up. Long enough to notice a slip, short enough to be out of the way. */
export const undoWindowMs = 8_000;

export interface MoveChange {
  appointment: Appointment & { version: number };
  patientName: string;
  practitionerName: string;
  /** The new place. A resize keeps `startsAt` and `practitionerId`. */
  startsAt: string;
  endsAt: string;
  practitionerId: string;
}

/** What a drag turned out to change: the time, the staff member, the length, or nothing. */
export function describeChange(before: Pick<Appointment, "startsAt" | "endsAt" | "practitionerId">, after: Pick<MoveChange, "startsAt" | "endsAt" | "practitionerId">): "move" | "resize" | null {
  const sameStart = Date.parse(before.startsAt) === Date.parse(after.startsAt);
  const sameEnd = Date.parse(before.endsAt) === Date.parse(after.endsAt);
  if (sameStart && before.practitionerId === after.practitionerId) return sameEnd ? null : "resize";
  return "move";
}

export function requestFor(change: MoveChange, kind: "move" | "resize", notifyCustomer: boolean): RescheduleRequest {
  const base = { appointmentId: change.appointment.id, expectedVersion: change.appointment.version, notifyCustomer };
  return kind === "resize"
    ? { ...base, kind: "resize", endsAt: change.endsAt }
    : { ...base, kind: "move", startsAt: change.startsAt, practitionerId: change.practitionerId };
}

interface PendingMove { change: MoveChange; kind: "move" | "resize" }

/**
 * Drag to move and drag to resize. The card sits where it was dropped while staff choose whether to tell the
 * customer; confirming sends it to the server, which checks the version and the clash. A refusal puts the card back
 * with the reason. A success offers Undo for a few seconds.
 */
export function useScheduleMoves({ notifyByDefault }: { notifyByDefault: boolean }) {
  const t = useTerms();
  const reschedule = useRescheduleAppointment();
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [notify, setNotify] = useState(notifyByDefault);
  const busy = useRef(false);
  // A move a full limit refused, kept so staff can go ahead with a reason.
  const [blocked, setBlocked] = useState<PendingMove & { notify: boolean } | null>(null);
  const limitOverride = useLimitOverride("move");

  const request = useCallback((change: MoveChange, kind: "move" | "resize") => {
    setNotify(notifyByDefault);
    setPending({ change, kind });
  }, [notifyByDefault]);

  const cancel = useCallback(() => setPending(null), []);

  const attempt = useCallback(async (move: PendingMove, notifyTheCustomer: boolean, anyway: boolean) => {
    if (busy.current) return;
    busy.current = true;
    const { change, kind } = move;
    const before = { startsAt: change.appointment.startsAt, endsAt: change.appointment.endsAt, practitionerId: change.appointment.practitionerId };
    try {
      const result: MutationResult = await reschedule.mutateAsync({ ...requestFor(change, kind, notifyTheCustomer), ...(anyway ? limitOverride.takeBody() : {}) });
      limitOverride.clear();
      setBlocked(null);
      const toastId = toastManager.add({
        type: "success",
        timeout: undoWindowMs,
        title: kind === "resize" ? `${change.patientName}'s ${t.appointment} now ends at ${appointmentTime(change.endsAt)}` : `Moved ${change.patientName} to ${appointmentTime(change.startsAt)}`,
        description: kind === "resize" ? undefined : `${appointmentDay(change.startsAt)} · ${change.practitionerName}${notifyTheCustomer ? ` · ${t.customer} will be told` : ""}`,
        actionProps: {
          children: "Undo",
          onClick: () => {
            toastManager.close(toastId);
            const back: RescheduleRequest = kind === "resize"
              ? { kind: "resize", appointmentId: change.appointment.id, endsAt: before.endsAt, expectedVersion: result.version, notifyCustomer: notifyTheCustomer }
              : { kind: "move", appointmentId: change.appointment.id, startsAt: before.startsAt, practitionerId: before.practitionerId, expectedVersion: result.version, notifyCustomer: notifyTheCustomer };
            reschedule.mutateAsync(back).then(
              () => toastManager.add({ type: "info", title: "Put back where it was" }),
              (error: unknown) => { const failure = rescheduleFailure(error); toastManager.add({ type: "error", title: "Could not undo", description: failure.description }); },
            );
          },
        },
      });
    } catch (error: unknown) {
      // A full limit is not a dead end for staff: the card goes back and a question offers to go ahead.
      if (limitOverride.capture(error)) {
        setBlocked({ ...move, notify: notifyTheCustomer });
      } else {
        setBlocked(null);
        const failure = rescheduleFailure(error);
        toastManager.add({ type: "error", title: failure.title, description: failure.description });
      }
    } finally {
      busy.current = false;
    }
  }, [limitOverride, reschedule, t.customer, t.appointment]);

  const confirm = useCallback(async () => {
    if (!pending) return;
    const move = pending;
    setPending(null);
    await attempt(move, notify, false);
  }, [attempt, notify, pending]);

  /** Where each dragged card should sit while the question is open. */
  const override = useMemo(() => pending ? { id: pending.change.appointment.id, startsAt: pending.change.startsAt, endsAt: pending.change.endsAt, practitionerId: pending.change.practitionerId } : null, [pending]);

  const dialog = <>
  <Dialog open={blocked !== null} onOpenChange={(open) => { if (!open) { setBlocked(null); limitOverride.clear(); } }}>
    <DialogPopup>
      <DialogHeader>
        <DialogTitle>{blocked ? `${blocked.change.patientName} is over a limit` : "Over a limit"}</DialogTitle>
        <DialogDescription>The card is back where it was. You can still move it if you give a reason.</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <LimitOverridePrompt override={limitOverride} actionLabel="Move anyway" pending={reschedule.isPending}
          onConfirm={() => { if (blocked) void attempt(blocked, blocked.notify, true); }} />
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" type="button" />}>Leave it where it was</DialogClose>
      </DialogFooter>
    </DialogPopup>
  </Dialog>
  <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) cancel(); }}>
    <DialogPopup>
      {pending ? <form className="contents" onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
        <DialogHeader>
          <DialogTitle>{pending.kind === "resize" ? `Change how long ${pending.change.patientName} is booked?` : `Move ${pending.change.patientName}?`}</DialogTitle>
          <DialogDescription className="tabular-nums">
            {appointmentDay(pending.change.appointment.startsAt)}, {appointmentTime(pending.change.appointment.startsAt)} – {appointmentTime(pending.change.appointment.endsAt)}
            {" → "}
            {appointmentDay(pending.change.startsAt)}, {appointmentTime(pending.change.startsAt)} – {appointmentTime(pending.change.endsAt)} with {pending.change.practitionerName}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Label className="min-h-11 cursor-pointer items-center">
            <Checkbox checked={notify} onCheckedChange={(next) => setNotify(next === true)} />
            Tell {pending.change.patientName} about the new time
          </Label>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" type="button" />}>Leave it where it was</DialogClose>
          <Button type="submit" autoFocus>{pending.kind === "resize" ? "Change length" : `Move ${t.appointment}`}</Button>
        </DialogFooter>
      </form> : null}
    </DialogPopup>
  </Dialog></>;

  return { request, dialog, override, busy: reschedule.isPending };
}
