"use client";

import { useMemo } from "react";

import { useTerms } from "@/features/terms/business-profile-context";
import type { Appointment } from "@/lib/domain";
import type { AvailabilityRuleSlice } from "@/lib/working-hours";

import { useCatalogLookups } from "./clinic-catalog";
import { usePreviewAppointments } from "./preview-appointments";
import { type ScheduleAvailability, visitFitsRules, workingHoursFromRules, workingHoursToRules } from "./schedule-availability";

export interface VisitNeedingPerson {
  appointment: Appointment;
  reason: string;
}

/** Every doctor's saved hours as shared rules, from the database or from the browser preview. */
export function useDoctorRules(): AvailabilityRuleSlice[] {
  const catalog = useCatalogLookups();
  const { operations } = usePreviewAppointments();
  if (catalog.snapshot) return catalog.snapshot.availability;
  return Object.entries(operations.schedule.workingHours).flatMap(([id, hours]) => workingHoursToRules(id, hours));
}

/** The schedule to draw: the database's doctor hours when signed in, otherwise the browser preview's. */
export function useScheduleAvailability(): ScheduleAvailability {
  const catalog = useCatalogLookups();
  const { operations } = usePreviewAppointments();
  const databaseRules = catalog.snapshot?.availability;
  return useMemo(
    () => databaseRules ? { ...operations.schedule, workingHours: workingHoursFromRules(databaseRules) } : operations.schedule,
    [databaseRules, operations.schedule],
  );
}

/** Upcoming visits automation couldn't place, so someone at the desk has to decide what happens to them. */
export function useVisitsNeedingPerson(): VisitNeedingPerson[] {
  const catalog = useCatalogLookups();
  const t = useTerms();
  const rules = useDoctorRules();
  const { appointments, operations } = usePreviewAppointments();
  const clock = Date.parse(operations.clockIso);
  return appointments.flatMap((appointment) => {
    if ((appointment.status !== "requested" && appointment.status !== "booked") || Date.parse(appointment.startsAt) <= clock) return [];
    if (catalog.getPractitioner(appointment.practitionerId)?.isActive === false) return [{ appointment, reason: `${t.Practitioner} is no longer active` }];
    return visitFitsRules(appointment, rules) ? [] : [{ appointment, reason: `Outside the ${t.practitioner}'s hours` }];
  }).sort((first, second) => first.appointment.startsAt.localeCompare(second.appointment.startsAt));
}
