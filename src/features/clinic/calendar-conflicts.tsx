"use client";

import { useState } from "react";
import { CalendarClock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import type { CalendarConflictView, ConflictAction } from "@/lib/calendar-sync";

import { ConfirmDialog, touchTarget } from "./calendar-confirm";
import { appointmentDateTime, appointmentTime } from "./clinic-format";
import { useResolveConflict } from "./queries/calendars";
import { ScrollArea } from "@/components/ui/scroll-area";

const done: Record<ConflictAction["action"], string> = {
  move_appointment: "The appointment was moved to match your calendar.",
  restore_event: "The calendar event is being put back.",
  dismiss: "Dismissed. The appointment and your calendar stay as they are.",
};

function ConflictRow({ conflict }: { conflict: CalendarConflictView }) {
  const t = useTerms();
  const resolve = useResolveConflict();
  const [confirm, setConfirm] = useState<"move_appointment" | "restore_event" | null>(null);
  const moved = conflict.kind === "moved" && conflict.eventStartsAt !== null;

  function run(action: ConflictAction["action"]) {
    resolve.mutate({ id: conflict.id, action }, {
      onSuccess: () => { setConfirm(null); toastManager.add({ title: done[action], type: "success" }); },
      onError: (error) => { setConfirm(null); toastManager.add({ title: "That could not be done", description: error.message, type: "error" }); },
    });
  }

  return (
    <li className="flex flex-col gap-3 py-3">
      <div className="flex flex-col gap-1 text-sm">
        <p className="font-medium">{moved ? `A calendar event was moved (${conflict.ownerName})` : `A calendar event was deleted (${conflict.ownerName})`}</p>
        <p>{t.Appointment} time: <span className="tabular-nums">{appointmentDateTime(conflict.appointmentStartsAt)} to {appointmentTime(conflict.appointmentEndsAt)}</span></p>
        {moved && conflict.eventStartsAt && conflict.eventEndsAt ? (
          <p>Calendar event now: <span className="tabular-nums">{appointmentDateTime(conflict.eventStartsAt)} to {appointmentTime(conflict.eventEndsAt)}</span></p>
        ) : (
          <p className="text-muted-foreground">The event is no longer in the calendar.</p>
        )}
      </div>
      <ScrollArea className="h-auto!" clampContentMinWidth={false}>
      <div className="flex flex-nowrap items-center gap-2">
          {moved ? <Button size="sm" className={`${touchTarget} shrink-0`} onClick={() => setConfirm("move_appointment")}>Move the {t.appointment} to match</Button> : null}
          <Button size="sm" variant="outline" className={`${touchTarget} shrink-0`} onClick={() => setConfirm("restore_event")}>Put the calendar event back</Button>
          <Button size="sm" variant="ghost" className={`${touchTarget} shrink-0`} loading={resolve.isPending && resolve.variables?.action === "dismiss"} onClick={() => run("dismiss")}>Dismiss</Button>
      </div>
      </ScrollArea>
      <ConfirmDialog
        open={confirm === "move_appointment"}
        onOpenChange={(open) => { if (!open) setConfirm(null); }}
        title={`Move the ${t.appointment}?`}
        description={`The ${t.appointment} moves to the time shown in the calendar, and the ${t.customer} is told about the new time.`}
        confirmLabel={`Move the ${t.appointment}`}
        busy={resolve.isPending}
        onConfirm={() => run("move_appointment")}
      />
      <ConfirmDialog
        open={confirm === "restore_event"}
        onOpenChange={(open) => { if (!open) setConfirm(null); }}
        title="Put the calendar event back?"
        description={`The calendar event goes back to the ${t.appointment} time. Nobody is told anything.`}
        confirmLabel="Put it back"
        busy={resolve.isPending}
        onConfirm={() => run("restore_event")}
      />
    </li>
  );
}

/** Calendar changes Kalendr will not apply by itself, because they would change a booked time. */
export function CalendarConflicts({ conflicts }: { conflicts: CalendarConflictView[] }) {
  const t = useTerms();
  if (conflicts.length === 0) return null;
  return (
    <section aria-labelledby="calendar-conflicts-title" className="flex flex-col gap-1">
      <h3 id="calendar-conflicts-title" className="flex items-center gap-2 text-sm font-medium">
        <CalendarClock aria-hidden="true" className="size-4" />
        Needs a person ({conflicts.length})
      </h3>
      <p className="text-xs text-muted-foreground">Someone changed a calendar event for a booked {t.appointment}. Choose which time is right.</p>
      <ul className="divide-y">
        {conflicts.map((conflict) => <ConflictRow key={conflict.id} conflict={conflict} />)}
      </ul>
    </section>
  );
}
