"use client";

import type { Appointment } from "@/lib/domain";

import { usePreviewAppointments, type QueueAction } from "./preview-appointments";
import { staffMutation, useOptionalStaffSnapshot } from "./staff-snapshot-provider";

interface CalledTicket {
  appointmentId: string;
  number: number;
}

/**
 * Today's token queue: call the next customer, call again, skip, or mark urgent.
 * With a database the server picks who is next, so two rooms never call the same person;
 * in the preview the queue stays in this browser.
 */
export function useQueue() {
  const { database, callNextInQueue, updateQueueTicket } = usePreviewAppointments();
  const staff = useOptionalStaffSnapshot();

  /** Calls the next waiting customer. Returns null when no one is waiting. Throws when it could not save. */
  async function callNext(practitionerId?: string): Promise<CalledTicket | null> {
    if (database) {
      const called = await staffMutation<CalledTicket | null>("/api/staff/queue/call-next", "POST", practitionerId ? { practitionerId } : {});
      await staff?.refresh();
      return called;
    }
    const next = callNextInQueue(practitionerId);
    return next?.queue ? { appointmentId: next.id, number: next.queue.number } : null;
  }

  /** Call again, skip, or mark urgent. Throws when it could not save. */
  async function act(appointment: Appointment, action: QueueAction, reason?: string): Promise<void> {
    const ticket = appointment.queue;
    if (!ticket) throw new Error("This visit has no token yet.");
    if (database) {
      try {
        await staffMutation(`/api/staff/queue/tickets/${encodeURIComponent(ticket.ticketId)}`, "POST", action === "urgent" ? { action, reason: reason ?? "" } : { action });
      } finally {
        await staff?.refresh();
      }
      return;
    }
    if (!updateQueueTicket(appointment.id, action)) throw new Error("Could not save the queue in this browser.");
  }

  return { callNext, act };
}
