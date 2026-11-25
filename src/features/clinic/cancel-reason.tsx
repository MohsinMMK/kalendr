"use client";

import { Clock, History } from "lucide-react";

import { useTerms } from "@/features/terms/business-profile-context";
import { cancelReasonLabels } from "@/lib/cancel-policy";
import type { Appointment } from "@/lib/domain";

import { appointmentDateTime } from "./clinic-format";

const whoLine = { customer: "Cancelled by the customer", staff: "Cancelled by the business", system: "Cancelled automatically" } as const;

/** The reason line for a cancelled booking, or null when none is recorded. */
export function cancelReasonText(appointment: Appointment): string | null {
  if (appointment.cancelPresetLabel) return appointment.cancelPresetLabel;
  const code = appointment.cancelReasonCode;
  // "Cancelled by the business" alone says nothing a heading has not already said.
  if (!code || code === "staff_preset") return null;
  return cancelReasonLabels[code];
}

/**
 * Quiet notes about why a booking ended or moved: who cancelled and why, the customer's note about moving,
 * the "waiting for a new time" banner, and a link back to an earlier booking.
 */
export function CancelReasonNotes({ appointment }: { appointment: Appointment }) {
  const t = useTerms();
  const cancelled = appointment.status === "cancelled";
  const reason = cancelled ? cancelReasonText(appointment) : null;
  const who = cancelled ? whoLine[appointment.cancelledBy ?? "staff"] : null;
  const showReschedule = Boolean(appointment.rescheduleNote) && appointment.status === "booked";
  const waiting = appointment.status === "reschedule_requested";
  if (!who && !showReschedule && !waiting && !appointment.rebookedFromId) return null;
  return <div className="flex flex-col gap-2">
    {waiting ? (
      <p role="status" className="flex items-start gap-2 rounded-lg border bg-muted/48 px-3 py-2 text-sm text-muted-foreground">
        <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>Waiting for the {t.customer} to choose a new time{appointment.rescheduleRequestedAt ? <> (asked <span className="tabular-nums">{appointmentDateTime(appointment.rescheduleRequestedAt)}</span>)</> : null}</span>
      </p>
    ) : null}
    {who ? (
      <section aria-label="Why this was cancelled" className="flex flex-col gap-0.5 rounded-lg border bg-muted/48 px-3 py-2 text-sm">
        <p className="font-medium">{who}</p>
        {reason ? <p className="text-muted-foreground">{reason}</p> : null}
        {appointment.cancelNote ? <p className="text-muted-foreground">Their note: <span className="whitespace-pre-wrap text-foreground">{appointment.cancelNote}</span></p> : null}
      </section>
    ) : null}
    {showReschedule ? (
      <section aria-label="Note about moving" className="flex flex-col gap-0.5 rounded-lg border bg-muted/48 px-3 py-2 text-sm">
        <p className="font-medium">Their note about moving</p>
        <p className="whitespace-pre-wrap text-muted-foreground">{appointment.rescheduleNote}</p>
      </section>
    ) : null}
    {appointment.rebookedFromId ? (
      <p className="flex items-center gap-2 text-xs text-muted-foreground"><History aria-hidden="true" className="size-3.5 shrink-0" />Rebooked from an earlier {t.appointment}</p>
    ) : null}
  </div>;
}
