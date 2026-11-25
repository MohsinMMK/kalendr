"use client";

import type { Appointment } from "@/lib/domain";
import type { QuickMessageKind } from "@/lib/quick-messages";

import { dayVisits } from "./clinic-today";
import { clinicDateKey, usePreviewAppointments } from "./preview-appointments";
import { staffMutation, useOptionalStaffSnapshot } from "./staff-snapshot-provider";

/**
 * Quick messages from Today. With a database they go to the outbox and the worker sends them;
 * in the preview they are only listed on the Messages page.
 */
export function useQuickMessages() {
  const { database, appointments, operations, recordQuickMessages } = usePreviewAppointments();
  const staff = useOptionalStaffSnapshot();

  /** Sends one customer a quick message. Throws when it could not be queued. */
  async function send(appointment: Appointment, kind: QuickMessageKind, delayMinutes?: number): Promise<void> {
    if (database) {
      try {
        await staffMutation(
          `/api/staff/appointments/${encodeURIComponent(appointment.id)}/messages`,
          "POST",
          kind === "running_late" ? { kind, delayMinutes } : { kind },
          { idempotencyKey: crypto.randomUUID() },
        );
      } finally {
        await staff?.refresh();
      }
      return;
    }
    if (!recordQuickMessages([appointment.id], kind)) throw new Error("Could not save the message in this browser.");
  }

  /** Tells everyone still to be seen today that the business is running late. Returns how many were told. */
  async function tellEveryoneLate(delayMinutes: number, practitionerId?: string): Promise<number> {
    if (database) {
      try {
        const result = await staffMutation<{ count: number }>(
          "/api/staff/messages/delay",
          "POST",
          practitionerId ? { delayMinutes, practitionerId } : { delayMinutes },
          { idempotencyKey: crypto.randomUUID() },
        );
        return result.count;
      } finally {
        await staff?.refresh();
      }
    }
    const targets = stillToBeSeen(appointments, operations.clockIso, operations.visitTimings, practitionerId);
    if (targets.length && !recordQuickMessages(targets.map((item) => item.id), "running_late")) {
      throw new Error("Could not save the messages in this browser.");
    }
    return targets.length;
  }

  return { send, tellEveryoneLate };
}

/** Booked or waiting today, and not yet with the practitioner. */
export function stillToBeSeen(
  appointments: Appointment[],
  clockIso: string,
  timings: Record<string, { startedAt?: string } | undefined>,
  practitionerId?: string,
): Appointment[] {
  return dayVisits(appointments, clinicDateKey(clockIso)).filter((item) =>
    (item.status === "booked" || item.status === "checked_in") &&
    !timings[item.id]?.startedAt &&
    (!practitionerId || item.practitionerId === practitionerId));
}
