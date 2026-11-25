"use client";

import { useState } from "react";

import { toastManager } from "@/components/ui/toast";
import type { Appointment, BookingSource } from "@/lib/domain";
import { isEmptyFieldValue, type CustomFieldValues } from "@/lib/visit-fields";

import { usePreviewAppointments } from "./preview-appointments";
import { useStaffAccess } from "./staff-access";
import { staffMutation, useOptionalStaffSnapshot } from "./staff-snapshot-provider";

export interface VisitDetailsPatch {
  reasonForVisit?: string;
  notes?: string;
  /** Merged into the visit's values; an empty value removes the property's value. */
  customFields?: CustomFieldValues;
  /** How staff took the booking: by phone, at the desk or walked in. Online sources can't be changed. */
  bookingSource?: Extract<BookingSource, "phone" | "staff" | "walk_in">;
}

/** The booking sources staff can correct, because staff entered them. */
export const staffBookingSources: readonly BookingSource[] = ["phone", "staff", "walk_in"];

/** Merges new values into a visit's, dropping the ones that were cleared. */
export function mergeCustomFields(current: CustomFieldValues | undefined, patch: CustomFieldValues): CustomFieldValues | undefined {
  const next: CustomFieldValues = { ...current };
  for (const [id, value] of Object.entries(patch)) {
    if (isEmptyFieldValue(value)) delete next[id];
    else next[id] = value;
  }
  return Object.keys(next).length ? next : undefined;
}

/**
 * Saves changes made in place on a visit: the reason, staff notes, the business's own properties, and a
 * received form. On the server it checks the visit's version, so two people editing at once never overwrite.
 */
export function useVisitEdits() {
  const staff = useOptionalStaffSnapshot();
  const { updateAppointment, database } = usePreviewAppointments();
  const access = useStaffAccess();
  const canEditVisit = database ? access.can("appointments.status") : true;
  const [savingId, setSavingId] = useState<string | null>(null);

  async function send(appointment: Appointment, body: Record<string, unknown>, failure: string): Promise<boolean> {
    const expectedVersion = staff?.snapshot?.appointments.find((item) => item.id === appointment.id)?.version;
    if (!expectedVersion) {
      toastManager.add({ title: failure, description: "Refresh and try again.", type: "error" });
      return false;
    }
    setSavingId(appointment.id);
    try {
      await staffMutation(`/api/staff/appointments/${appointment.id}`, "PATCH", { ...body, expectedVersion });
      await staff?.refresh();
      return true;
    } catch (cause: unknown) {
      await staff?.refresh();
      toastManager.add({ title: failure, description: cause instanceof Error ? cause.message : "Refresh and try again.", type: "error" });
      return false;
    } finally {
      setSavingId(null);
    }
  }

  async function saveDetails(appointment: Appointment, patch: VisitDetailsPatch): Promise<boolean> {
    if (!canEditVisit) return false;
    if (database) return send(appointment, { action: "details", ...patch }, "Could not save the change");
    const saved = updateAppointment(appointment.id, (current) => ({
      ...current,
      ...(patch.reasonForVisit !== undefined ? { reasonForVisit: patch.reasonForVisit || undefined } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes || undefined } : {}),
      ...(patch.customFields ? { customFields: mergeCustomFields(current.customFields, patch.customFields) } : {}),
      ...(patch.bookingSource && staffBookingSources.includes(current.bookingSource) ? { bookingSource: patch.bookingSource } : {}),
    }));
    if (!saved) toastManager.add({ title: "Could not save the change", description: "This browser could not store it. Try again.", type: "error" });
    return saved;
  }

  async function markFormReceived(appointment: Appointment): Promise<boolean> {
    if (!canEditVisit) return false;
    if (database) return send(appointment, { action: "form_received" }, "Could not mark the form received");
    return updateAppointment(appointment.id, (current) => ({ ...current, formStatus: "submitted" }));
  }

  return { canEditVisit, saveDetails, markFormReceived, savingId };
}
