import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";

import type { LimitOverrideReason } from "@/lib/booking-limits";
import type { AppointmentStatus } from "@/lib/domain";
import type { StaffAppointment, StaffSnapshot } from "@/lib/staff-snapshot";

import { StaffApiError, staffMutation } from "./http";
import { staffKeys } from "./keys";

/** Moving a visit to another time or staff member, or changing its length by dragging its end. */
export type RescheduleRequest =
  | { kind: "move"; appointmentId: string; startsAt: string; practitionerId: string; expectedVersion: number; notifyCustomer: boolean; /** Staff chose to go past a full booking limit. */ limitOverrideReason?: LimitOverrideReason }
  | { kind: "resize"; appointmentId: string; endsAt: string; expectedVersion: number; notifyCustomer: boolean };

export interface MutationResult {
  appointmentId: string;
  status: AppointmentStatus;
  startsAt?: string;
  endsAt?: string;
  version: number;
}

/**
 * The snapshot as it will be once the server agrees. The version is bumped the way the server bumps it, so a
 * second drag on the same card, before the first answer comes back, carries a version the server will accept.
 */
export function applyRescheduleToSnapshot(snapshot: StaffSnapshot, request: RescheduleRequest): StaffSnapshot {
  return {
    ...snapshot,
    appointments: snapshot.appointments.map((appointment): StaffAppointment => {
      if (appointment.id !== request.appointmentId) return appointment;
      const length = Date.parse(appointment.endsAt) - Date.parse(appointment.startsAt);
      if (request.kind === "resize") return { ...appointment, endsAt: request.endsAt, version: appointment.version + 1 };
      return {
        ...appointment,
        practitionerId: request.practitionerId,
        startsAt: request.startsAt,
        endsAt: new Date(Date.parse(request.startsAt) + length).toISOString(),
        version: appointment.version + 1,
      };
    }),
  };
}

/** The snapshot with one appointment's status changed, as it will be once the server agrees. */
export function applyStatusToSnapshot(snapshot: StaffSnapshot, appointmentId: string, status: AppointmentStatus): StaffSnapshot {
  return {
    ...snapshot,
    appointments: snapshot.appointments.map((appointment) => appointment.id === appointmentId ? { ...appointment, status, version: appointment.version + 1 } : appointment),
  };
}

export interface FailureMessage {
  title: string;
  description: string;
  /** The time or the person was not free. The card goes back where it was. */
  clash: boolean;
}

/** A plain-spoken reason for a refused move, for the toast shown while the card snaps back. */
export function rescheduleFailure(error: unknown): FailureMessage {
  if (error instanceof StaffApiError) {
    if (error.code === "slot_unavailable") {
      return { title: "That time is taken", description: "Someone or something is already booked then, or it is outside working hours. The appointment is back where it was.", clash: true };
    }
    if (error.code === "version_conflict") {
      return { title: "This appointment just changed", description: "Someone else changed it a moment ago. It is back where it was, showing the latest details.", clash: true };
    }
    if (error.code === "appointment_not_manageable") {
      return { title: "This can no longer be moved", description: error.message, clash: false };
    }
    if (error.status === 403) return { title: "You cannot move appointments", description: "Ask the owner for permission to book and change appointments.", clash: false };
    return { title: "Could not move it", description: error.message, clash: false };
  }
  return { title: "Could not move it", description: "The connection failed. The appointment is back where it was.", clash: false };
}

export function rescheduleBody(request: RescheduleRequest): Record<string, unknown> {
  if (request.kind === "resize") {
    return { action: "resize", endsAt: request.endsAt, expectedVersion: request.expectedVersion, notifyCustomer: request.notifyCustomer };
  }
  return { action: "reschedule", startsAt: request.startsAt, practitionerId: request.practitionerId, expectedVersion: request.expectedVersion, notifyCustomer: request.notifyCustomer, ...(request.limitOverrideReason ? { limitOverrideReason: request.limitOverrideReason } : {}) };
}

/** Paints the new snapshot at once and returns the old one for a rollback. */
export async function applyOptimistic(client: QueryClient, change: (snapshot: StaffSnapshot) => StaffSnapshot): Promise<StaffSnapshot | undefined> {
  // A refetch that lands after the change would put the old time back on screen for a moment.
  await client.cancelQueries({ queryKey: staffKeys.snapshot() });
  const previous = client.getQueryData<StaffSnapshot>(staffKeys.snapshot());
  if (previous) client.setQueryData<StaffSnapshot>(staffKeys.snapshot(), change(previous));
  return previous;
}

export function rollback(client: QueryClient, previous: StaffSnapshot | undefined, appointmentId: string) {
  if (!previous) return;
  // Only this appointment goes back. Other cards may have changed since, from other drags or a refetch.
  const before = previous.appointments.find((item) => item.id === appointmentId);
  client.setQueryData<StaffSnapshot>(staffKeys.snapshot(), (current) => {
    if (!current || !before) return current ?? previous;
    return { ...current, appointments: current.appointments.map((item) => item.id === appointmentId ? before : item) };
  });
}

/**
 * Moves or resizes a visit. The card moves on the screen first; if the server refuses, it goes back and the
 * caller gets the reason. Either way the snapshot is refetched so the screen shows what is really saved.
 */
export function useRescheduleAppointment() {
  const client = useQueryClient();
  return useMutation<MutationResult, Error, RescheduleRequest, { previous: StaffSnapshot | undefined }>({
    mutationFn: (request) => staffMutation<MutationResult>(`/api/staff/appointments/${encodeURIComponent(request.appointmentId)}`, "PATCH", rescheduleBody(request)),
    onMutate: async (request) => ({ previous: await applyOptimistic(client, (snapshot) => applyRescheduleToSnapshot(snapshot, request)) }),
    onError: (_error, request, context) => rollback(client, context?.previous, request.appointmentId),
    onSettled: () => client.invalidateQueries({ queryKey: staffKeys.snapshot() }),
  });
}

export interface StatusRequest {
  appointmentId: string;
  status: AppointmentStatus;
  reason?: string;
  expectedVersion: number;
}

/** Cancels (or otherwise changes the status of) one visit, with the card updating at once and rolling back on a refusal. */
export function useChangeAppointmentStatus() {
  const client = useQueryClient();
  return useMutation<MutationResult, Error, StatusRequest, { previous: StaffSnapshot | undefined }>({
    mutationFn: ({ appointmentId, ...body }) => staffMutation<MutationResult>(`/api/appointments/${encodeURIComponent(appointmentId)}/status`, "PATCH", body),
    onMutate: async (request) => ({ previous: await applyOptimistic(client, (snapshot) => applyStatusToSnapshot(snapshot, request.appointmentId, request.status)) }),
    onError: (_error, request, context) => rollback(client, context?.previous, request.appointmentId),
    onSettled: () => client.invalidateQueries({ queryKey: staffKeys.snapshot() }),
  });
}
