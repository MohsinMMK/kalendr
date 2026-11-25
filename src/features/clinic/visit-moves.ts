"use client";

import { useState } from "react";

import { toastManager } from "@/components/ui/toast";
import type { Appointment, TimeSlot } from "@/lib/domain";
import { isManageableAppointment } from "@/server/appointment-state";

import { clinicDayBounds, useCatalogLookups } from "./clinic-catalog";
import { appointmentEndForSlot, clinicDateKey, compatibleSlots, usePreviewAppointments } from "./preview-appointments";
import { useStaffAccess } from "./staff-access";
import { fetchAvailabilitySlots, staffMutation, useOptionalStaffSnapshot } from "./staff-snapshot-provider";

/** Where a visit is going: a time and person, and optionally another service or a chosen room. */
export interface VisitMoveTarget {
  startsAt: string;
  practitionerId: string;
  serviceId?: string;
  resourceId?: string;
}

/**
 * Moves a booked or requested visit in place: another time, another person, another service or another
 * room. The server checks the opening again, so a change that no longer fits is refused rather than
 * double-booked.
 */
export function useVisitMoves() {
  const staff = useOptionalStaffSnapshot();
  const catalog = useCatalogLookups();
  const { appointments, updateAppointment, operations, database } = usePreviewAppointments();
  const access = useStaffAccess();
  const [movingId, setMovingId] = useState<string | null>(null);

  /** Whether this visit can still be moved, and by whom. */
  function canMove(appointment: Appointment): boolean {
    return isManageableAppointment(appointment.status) && (!database || access.can("appointments.book"));
  }

  /** Free starts on a day for this visit, leaving its own time out of the way. */
  async function openings(appointment: Appointment, dateKey: string, serviceId = appointment.serviceId, signal?: AbortSignal): Promise<TimeSlot[]> {
    const service = catalog.getService(serviceId);
    if (!service) return [];
    if (!database) {
      return compatibleSlots({
        service, locationId: appointment.locationId, appointments, excludeAppointmentId: appointment.id,
        patientId: appointment.patientId, notBefore: operations.clockIso, dateKey, availability: operations.schedule,
      });
    }
    const bounds = clinicDayBounds(dateKey);
    return fetchAvailabilitySlots({
      clinicSlug: catalog.clinic.slug, locationId: appointment.locationId, serviceId, from: bounds.from, to: bounds.to,
      ...(serviceId === appointment.serviceId ? { keepDurationMinutes: Math.round((new Date(appointment.endsAt).getTime() - new Date(appointment.startsAt).getTime()) / 60_000) } : {}),
    }, signal);
  }

  async function move(appointment: Appointment, target: VisitMoveTarget, failure = "Could not move this visit"): Promise<boolean> {
    if (!canMove(appointment)) return false;
    const serviceId = target.serviceId ?? appointment.serviceId;
    const service = catalog.getService(serviceId);
    if (!service) return false;
    if (database) {
      const expectedVersion = staff?.snapshot?.appointments.find((item) => item.id === appointment.id)?.version;
      if (!expectedVersion) {
        toastManager.add({ title: failure, description: "Refresh and try again.", type: "error" });
        return false;
      }
      setMovingId(appointment.id);
      try {
        await staffMutation(`/api/staff/appointments/${appointment.id}`, "PATCH", {
          action: "reschedule",
          startsAt: target.startsAt,
          practitionerId: target.practitionerId,
          ...(serviceId !== appointment.serviceId ? { serviceId } : {}),
          ...(target.resourceId ? { resourceId: target.resourceId } : {}),
          expectedVersion,
        });
        await staff?.refresh();
        return true;
      } catch (cause: unknown) {
        await staff?.refresh();
        toastManager.add({ title: failure, description: cause instanceof Error ? cause.message : "Refresh and try again.", type: "error" });
        return false;
      } finally {
        setMovingId(null);
      }
    }
    // Preview: the same rules as the booking screen, without the visit's own time in the way. Keeping the
    // time, as when changing who sees them, is allowed even once it has passed, as on the server.
    const sameTime = Date.parse(target.startsAt) === Date.parse(appointment.startsAt);
    const fits: TimeSlot | undefined = compatibleSlots({
      service, locationId: appointment.locationId, appointments, excludeAppointmentId: appointment.id,
      patientId: appointment.patientId, notBefore: sameTime ? undefined : operations.clockIso, dateKey: clinicDateKey(target.startsAt), availability: operations.schedule,
    }).find((slot) => Date.parse(slot.startsAt) === Date.parse(target.startsAt)
      && slot.practitionerId === target.practitionerId
      && (!target.resourceId || slot.resourceId === target.resourceId));
    if (!fits) {
      toastManager.add({ title: failure, description: "That isn't open for this visit. Choose another opening.", type: "error" });
      return false;
    }
    const saved = updateAppointment(appointment.id, (current) => isManageableAppointment(current.status) ? {
      ...current,
      serviceId,
      startsAt: fits.startsAt,
      endsAt: appointmentEndForSlot(fits, service),
      practitionerId: fits.practitionerId,
      resourceIds: fits.resourceId ? [fits.resourceId] : [],
      status: current.status === "requested" ? "requested" : "booked",
      confirmationStatus: "needs_action",
      reminderStatus: "queued",
    } : current);
    if (!saved) toastManager.add({ title: failure, description: "This browser could not store it. Try again.", type: "error" });
    return saved;
  }

  return { canMove, openings, move, movingId };
}
