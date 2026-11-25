"use client";

import { useEffect, useMemo, useState } from "react";

import { demoAppointments, demoAuditEvents, demoPatients, demoResources, demoServices, demoSlots } from "@/lib/demo-data";
import type { Appointment, AuditEvent, Patient, QueueTicket, Service, TimeSlot, WaitlistEntry } from "@/lib/domain";
import { notificationChannel } from "@/lib/notification-routing";
import { practitionerOffersService, previewDoctors } from "@/lib/preview-doctors";
import { toWorkspaceAppointment, type StaffMessage } from "@/lib/staff-snapshot";
import { pickNearestSlot, type TimingResult } from "@/lib/timing-automation";

import { addClinicDays, clinicDateKey, defaultScheduleAvailability, overlaps, slotAvailabilityIssue, staffSlotsForDate, visitFitsRules, workingHoursToRules } from "./schedule-availability";
import type { RecurringSeries, ScheduleAvailability, ScheduleBlock, WorkingHours } from "./schedule-availability";
import { useOptionalStaffSnapshot } from "./staff-snapshot-provider";

export { clinicDateKey } from "./schedule-availability";

const storageKey = "kalendr-preview-appointments-v1";
const auditStorageKey = "kalendr-preview-audit-v1";
const patientsStorageKey = "kalendr-preview-patients-v1";
const operationsStorageKey = "kalendr-preview-operations-v1";

export const previewClockStart = "2026-08-31T10:45:00+05:30";

export interface VisitTiming {
  checkedInAt?: string;
  startedAt?: string;
}

export interface HandoverNote {
  id: string;
  text: string;
  author: string;
  at: string;
}

interface PreviewOperations {
  clockIso: string;
  visitTimings: Record<string, VisitTiming>;
  owners: Record<string, string>;
  handoverNotes: HandoverNote[];
  schedule: ScheduleAvailability;
  messages: StaffMessage[];
  /** Today's tokens in this browser, by visit, and the last number issued each day. */
  queueTickets: Record<string, PreviewQueueTicket>;
  queueCounters: Record<string, number>;
}

export interface PreviewQueueTicket extends QueueTicket {
  day: string;
}

export type QueueAction = "call_again" | "skip" | "urgent" | "not_urgent";

const timingSearchDays = 14;

const initialOperations: PreviewOperations = {
  clockIso: previewClockStart,
  visitTimings: {},
  owners: {},
  handoverNotes: [],
  schedule: defaultScheduleAvailability,
  messages: [],
  queueTickets: {},
  queueCounters: {},
};

/** Gives each visit that just arrived the next token number for its day. */
function withQueueTickets(current: PreviewOperations, appointmentIds: string[]): PreviewOperations {
  const day = clinicDateKey(current.clockIso);
  let last = current.queueCounters[day] ?? 0;
  const queueTickets = { ...current.queueTickets };
  for (const id of appointmentIds) {
    if (queueTickets[id]) continue;
    last += 1;
    queueTickets[id] = { ticketId: `ticket_${id}`, number: last, callCount: 0, urgent: false, day };
  }
  return { ...current, queueTickets, queueCounters: { ...current.queueCounters, [day]: last } };
}

/** Who Call next picks: urgent first, then booked customers whose time has come, then token order. */
export function nextInQueue(waiting: Appointment[], clockIso: string): Appointment | undefined {
  const due = (item: Appointment) => item.bookingSource !== "walk_in" && Date.parse(item.startsAt) <= Date.parse(clockIso);
  return waiting
    .filter((item) => item.status === "checked_in" && item.queue && !item.queue.calledAt)
    .sort((first, second) =>
      Number(second.queue!.urgent) - Number(first.queue!.urgent) ||
      Number(Boolean(first.queue!.skippedAt)) - Number(Boolean(second.queue!.skippedAt)) ||
      Number(due(second)) - Number(due(first)) ||
      first.queue!.number - second.queue!.number)[0];
}

// Staff-only preview openings. Public booking continues to use demoSlots unchanged.
const staffDaySlots: TimeSlot[] = [
  { id: "staff_2026_08_31_1130_asha", startsAt: "2026-08-31T11:30:00+05:30", endsAt: "2026-08-31T12:15:00+05:30", practitionerId: "practitioner_asha", resourceId: "resource_op1" },
  { id: "staff_2026_08_31_1130_rohan", startsAt: "2026-08-31T11:30:00+05:30", endsAt: "2026-08-31T12:15:00+05:30", practitionerId: "practitioner_rohan", resourceId: "resource_op2" },
  { id: "staff_2026_08_31_1200_mira", startsAt: "2026-08-31T12:00:00+05:30", endsAt: "2026-08-31T12:45:00+05:30", practitionerId: "practitioner_mira", resourceId: "resource_hygiene" },
  { id: "staff_2026_08_31_1430_asha", startsAt: "2026-08-31T14:30:00+05:30", endsAt: "2026-08-31T15:15:00+05:30", practitionerId: "practitioner_asha", resourceId: "resource_op1" },
];

const previewChangeEvent = "kalendr-preview-change";

/** Saves preview state and tells every other mounted hook, such as the sidebar counts, to reload it. */
function savePreviewItem(key: string, value: string) {
  window.sessionStorage.setItem(key, value);
  queueMicrotask(() => window.dispatchEvent(new Event(previewChangeEvent)));
}

export function usePreviewAppointments() {
  const staffSnapshot = useOptionalStaffSnapshot();
  const [appointments, setAppointments] = useState<Appointment[]>(demoAppointments);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>(demoAuditEvents);
  const [patients, setPatients] = useState<Patient[]>(demoPatients);
  const [operations, setOperations] = useState<PreviewOperations>(initialOperations);

  useEffect(() => {
    if (staffSnapshot) return;
    const load = () => {
    try {
      const saved = window.sessionStorage.getItem(storageKey);
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length >= demoAppointments.length && parsed.every((item) =>
          typeof item === "object" && item !== null &&
          typeof item.id === "string" && typeof item.patientId === "string" &&
          typeof item.startsAt === "string" && Number.isFinite(Date.parse(item.startsAt)) &&
          typeof item.endsAt === "string" && Number.isFinite(Date.parse(item.endsAt)) &&
          typeof item.status === "string" && typeof item.practitionerId === "string" &&
          Array.isArray(item.resourceIds)
        ) && demoAppointments.every((original) => parsed.some((item) => item.id === original.id)) && new Set(parsed.map((item) => item.id)).size === parsed.length) {
          setAppointments(parsed as Appointment[]);
        }
      }
      const savedPatients = window.sessionStorage.getItem(patientsStorageKey);
      if (savedPatients) {
        const parsedPatients: unknown = JSON.parse(savedPatients);
        if (Array.isArray(parsedPatients) && parsedPatients.every((item) => typeof item === "object" && item !== null && typeof item.id === "string" && typeof item.firstName === "string" && typeof item.lastName === "string" && typeof item.phone === "string" && typeof item.email === "string") && demoPatients.every((original) => parsedPatients.some((item) => item.id === original.id))) {
          setPatients(parsedPatients as Patient[]);
        }
      }
      const savedOperations = window.sessionStorage.getItem(operationsStorageKey);
      if (savedOperations) {
        const parsedOperations: unknown = JSON.parse(savedOperations);
        if (typeof parsedOperations === "object" && parsedOperations !== null && "clockIso" in parsedOperations && typeof parsedOperations.clockIso === "string" && Number.isFinite(Date.parse(parsedOperations.clockIso)) && "visitTimings" in parsedOperations && typeof parsedOperations.visitTimings === "object" && "owners" in parsedOperations && typeof parsedOperations.owners === "object" && "handoverNotes" in parsedOperations && Array.isArray(parsedOperations.handoverNotes)) {
          const stored = parsedOperations as Partial<PreviewOperations>;
          const storedSchedule = stored.schedule;
          setOperations({
            ...(stored as PreviewOperations),
            messages: Array.isArray(stored.messages) ? stored.messages : [],
            queueTickets: typeof stored.queueTickets === "object" && stored.queueTickets !== null ? stored.queueTickets : {},
            queueCounters: typeof stored.queueCounters === "object" && stored.queueCounters !== null ? stored.queueCounters : {},
            schedule: {
              workingHours: { ...defaultScheduleAvailability.workingHours, ...(storedSchedule?.workingHours ?? {}) },
              blocks: Array.isArray(storedSchedule?.blocks) ? storedSchedule.blocks : [],
              recurringSeries: Array.isArray(storedSchedule?.recurringSeries) ? storedSchedule.recurringSeries : [],
            },
          });
        }
      }
      const savedAudit = window.sessionStorage.getItem(auditStorageKey);
      if (savedAudit) {
        const parsedAudit: unknown = JSON.parse(savedAudit);
        if (Array.isArray(parsedAudit) && parsedAudit.every((event) => typeof event === "object" && event !== null && typeof event.id === "string" && typeof event.action === "string" && (event.appointmentId === undefined || typeof event.appointmentId === "string"))) {
          setAuditEvents(parsedAudit as AuditEvent[]);
        }
      }
    } catch (error: unknown) {
      console.error("Could not load preview appointments", error);
    }
    };
    queueMicrotask(load);
    window.addEventListener(previewChangeEvent, load);
    return () => window.removeEventListener(previewChangeEvent, load);
  }, [staffSnapshot]);

  const snapshotAppointments = staffSnapshot?.snapshot?.appointments;
  const databaseAppointments = useMemo(
    () => snapshotAppointments ? snapshotAppointments.map(toWorkspaceAppointment) : null,
    [snapshotAppointments],
  );
  const databasePatients = staffSnapshot?.snapshot?.patients ?? null;
  const previewAppointments = useMemo(() => {
    const day = clinicDateKey(operations.clockIso);
    return appointments.map((appointment) => {
      const ticket = operations.queueTickets[appointment.id];
      if (!ticket || ticket.day !== day) return appointment;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drop `day` from the copy
      const { day: _day, ...queue } = ticket;
      return { ...appointment, queue };
    });
  }, [appointments, operations.clockIso, operations.queueTickets]);
  const visibleAppointments = databaseAppointments ?? previewAppointments;
  const visiblePatients = databasePatients ?? patients;
  const visibleOperations = databaseAppointments
    ? { ...initialOperations, clockIso: new Date().toISOString(), visitTimings: storedVisitTimings(databaseAppointments) }
    : operations;

  function updateAppointment(id: string, change: (current: Appointment) => Appointment): boolean {
    if (staffSnapshot) return false;
    const before = appointments.find((appointment) => appointment.id === id);
    const updated = appointments.map((appointment) => appointment.id === id ? change(appointment) : appointment);
    const after = updated.find((appointment) => appointment.id === id);
    try {
      savePreviewItem(storageKey, JSON.stringify(updated));
    } catch (error: unknown) {
      console.error("Could not save preview appointments", error);
      return false;
    }
    setAppointments(updated);
    // Arriving puts the customer in today's queue with a token number.
    if (before?.status !== "checked_in" && after?.status === "checked_in") updateOperations((current) => withQueueTickets(current, [id]));
    return true;
  }

  function addAppointment(appointment: Appointment, patient?: Patient): boolean {
    if (staffSnapshot) return false;
    if (appointments.some((item) => item.id === appointment.id)) return false;
    if (patient ? patient.id !== appointment.patientId || patients.some((item) => item.id === patient.id) : !patients.some((item) => item.id === appointment.patientId)) return false;
    const service = demoServices.find((item) => item.id === appointment.serviceId);
    const patientType = patient || !appointments.some((item) => item.patientId === appointment.patientId) ? "new" : "returning";
    if (!service?.patientTypes.includes(patientType)) return false;
    if (!service || !compatibleSlots({ service, locationId: appointment.locationId, appointments, patientId: appointment.patientId, notBefore: operations.clockIso, dateKey: clinicDateKey(appointment.startsAt), availability: operations.schedule }).some((slot) => slot.startsAt === appointment.startsAt && slot.practitionerId === appointment.practitionerId && slot.resourceId === appointment.resourceIds[0])) return false;
    const nextAppointments = [...appointments, appointment];
    const nextPatients = patient ? [...patients, patient] : patients;
    let previousAppointments: string | null = null;
    try {
      previousAppointments = window.sessionStorage.getItem(storageKey);
      savePreviewItem(storageKey, JSON.stringify(nextAppointments));
      if (patient) savePreviewItem(patientsStorageKey, JSON.stringify(nextPatients));
    } catch (error: unknown) {
      console.error("Could not save new preview appointment", error);
      try {
        if (previousAppointments === null) window.sessionStorage.removeItem(storageKey);
        else savePreviewItem(storageKey, previousAppointments);
      } catch (rollbackError: unknown) {
        console.error("Could not restore preview appointments after patient save failure", rollbackError);
      }
      return false;
    }
    setAppointments(nextAppointments);
    if (patient) setPatients(nextPatients);
    if (appointment.status === "checked_in") updateOperations((current) => withQueueTickets(current, [appointment.id]));
    return true;
  }

  function updateOperations(change: (current: PreviewOperations) => PreviewOperations): boolean {
    if (staffSnapshot) return false;
    const updated = change(operations);
    try {
      savePreviewItem(operationsStorageKey, JSON.stringify(updated));
    } catch (error: unknown) {
      console.error("Could not save preview operations", error);
      return false;
    }
    setOperations(updated);
    return true;
  }

  function advancePreviewClock(minutes: number): boolean {
    return updateOperations((current) => ({ ...current, clockIso: new Date(Date.parse(current.clockIso) + minutes * 60_000).toISOString() }));
  }

  function recordVisitTiming(appointmentId: string, timing: VisitTiming): boolean {
    return updateOperations((current) => ({ ...current, visitTimings: { ...current.visitTimings, [appointmentId]: { ...current.visitTimings[appointmentId], ...timing } } }));
  }

  function assignOwner(key: string, owner: string): boolean {
    return updateOperations((current) => ({ ...current, owners: { ...current.owners, [key]: owner } }));
  }

  function addHandoverNote(note: HandoverNote): boolean {
    return updateOperations((current) => ({ ...current, handoverNotes: [note, ...current.handoverNotes] }));
  }

  function removeHandoverNote(id: string): boolean {
    return updateOperations((current) => ({ ...current, handoverNotes: current.handoverNotes.filter((note) => note.id !== id) }));
  }

  /**
   * Saves a doctor's hours and moves their upcoming visits that no longer fit to the nearest opening with the
   * same doctor, the same way the server does. Returns null when nothing could be saved. Checked-in visits stay.
   */
  function saveDoctorHours(practitionerId: string, hours: WorkingHours): TimingResult | null {
    if (staffSnapshot) return null;
    const validTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (!previewDoctors().some((item) => item.id === practitionerId) || !validTime(hours.start) || !validTime(hours.end) || hours.start >= hours.end || hours.days.length === 0 || hours.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return null;
    const schedule = { ...operations.schedule, workingHours: { ...operations.schedule.workingHours, [practitionerId]: hours } };
    const rules = workingHoursToRules(practitionerId, hours);
    const clock = Date.parse(operations.clockIso);
    const result: TimingResult = { moved: [], unresolved: [] };
    const messages: StaffMessage[] = [];
    let nextAppointments = appointments;
    const affected = appointments
      .filter((item) => item.practitionerId === practitionerId && (item.status === "requested" || item.status === "booked") && Date.parse(item.startsAt) > clock && !visitFitsRules(item, rules))
      .sort((first, second) => first.startsAt.localeCompare(second.startsAt));
    for (const appointment of affected) {
      const service = demoServices.find((item) => item.id === appointment.serviceId);
      const originalDay = clinicDateKey(appointment.startsAt);
      const openings = service ? Array.from({ length: timingSearchDays * 2 + 1 }, (_, index) => addClinicDays(originalDay, index - timingSearchDays)).flatMap((dateKey) => compatibleSlots({ service, locationId: appointment.locationId, appointments: nextAppointments, excludeAppointmentId: appointment.id, patientId: appointment.patientId, notBefore: operations.clockIso, dateKey, availability: schedule }).filter((slot) => slot.practitionerId === practitionerId)) : [];
      const slot = pickNearestSlot(appointment.startsAt, openings);
      if (!service || !slot) {
        result.unresolved.push(appointment.id);
        continue;
      }
      const moved: Appointment = { ...appointment, startsAt: slot.startsAt, endsAt: appointmentEndForSlot(slot, service), resourceIds: slot.resourceId ? [slot.resourceId] : appointment.resourceIds, confirmationStatus: "needs_action", reminderStatus: "queued", clinicMovedFrom: appointment.startsAt };
      nextAppointments = nextAppointments.map((item) => item.id === moved.id ? moved : item);
      result.moved.push({ appointmentId: moved.id, from: appointment.startsAt, to: slot.startsAt });
      const patient = patients.find((item) => item.id === appointment.patientId);
      messages.push({ id: `message_${moved.id}_${operations.messages.length + messages.length + 1}`, appointmentId: moved.id, patientId: appointment.patientId, channel: notificationChannel(appointment.bookingSource, patient?.preferredChannel ?? "email"), templateKey: appointment.status === "requested" ? "appointment.suggest" : "appointment.reschedule", status: "queued", createdAt: operations.clockIso });
    }
    const nextOperations: PreviewOperations = { ...operations, schedule, messages: [...messages, ...operations.messages] };
    let previousAppointments: string | null = null;
    try {
      previousAppointments = window.sessionStorage.getItem(storageKey);
      savePreviewItem(storageKey, JSON.stringify(nextAppointments));
      savePreviewItem(operationsStorageKey, JSON.stringify(nextOperations));
    } catch (error: unknown) {
      console.error("Could not save doctor hours", error);
      try {
        if (previousAppointments === null) window.sessionStorage.removeItem(storageKey);
        else savePreviewItem(storageKey, previousAppointments);
      } catch (rollbackError: unknown) {
        console.error("Could not restore preview appointments after hours save failure", rollbackError);
      }
      return null;
    }
    setAppointments(nextAppointments);
    setOperations(nextOperations);
    return result;
  }

  function addScheduleBlock(block: ScheduleBlock): boolean {
    if (!Number.isFinite(Date.parse(block.startsAt)) || !Number.isFinite(Date.parse(block.endsAt)) || Date.parse(block.endsAt) <= Date.parse(block.startsAt) || !block.reason.trim()) return false;
    if (block.targetType === "practitioner" && !previewDoctors().some((item) => item.id === block.targetId)) return false;
    if (block.targetType === "resource" && !demoResources.some((item) => item.id === block.targetId)) return false;
    return updateOperations((current) => ({ ...current, schedule: { ...current.schedule, blocks: [...current.schedule.blocks, block] } }));
  }

  function updateScheduleBlock(block: ScheduleBlock): boolean {
    if (!Number.isFinite(Date.parse(block.startsAt)) || !Number.isFinite(Date.parse(block.endsAt)) || Date.parse(block.endsAt) <= Date.parse(block.startsAt) || !block.reason.trim()) return false;
    if (block.targetType === "practitioner" && !previewDoctors().some((item) => item.id === block.targetId)) return false;
    if (block.targetType === "resource" && !demoResources.some((item) => item.id === block.targetId)) return false;
    return updateOperations((current) => current.schedule.blocks.some((item) => item.id === block.id)
      ? { ...current, schedule: { ...current.schedule, blocks: current.schedule.blocks.map((item) => item.id === block.id ? block : item) } }
      : current);
  }

  function removeScheduleBlock(id: string): boolean {
    return updateOperations((current) => ({ ...current, schedule: { ...current.schedule, blocks: current.schedule.blocks.filter((block) => block.id !== id) } }));
  }

  function addRecurringSeries(series: RecurringSeries, occurrences: Appointment[]): boolean {
    if (staffSnapshot) return false;
    if (occurrences.length < 2 || occurrences.length > 6 || series.appointmentIds.length !== occurrences.length || appointments.some((item) => occurrences.some((occurrence) => occurrence.id === item.id))) return false;
    const patient = patients.find((item) => item.id === series.patientId);
    const seriesService = demoServices.find((item) => item.id === series.serviceId);
    const patientType = appointments.some((item) => item.patientId === series.patientId) ? "returning" : "new";
    if (!patient || !seriesService?.patientTypes.includes(patientType) || occurrences.some((item) => item.patientId !== series.patientId || item.serviceId !== series.serviceId || item.status !== "booked" || item.confirmationStatus !== "needs_action" || item.reminderStatus !== "not_scheduled")) return false;
    const nextAppointments = [...appointments];
    for (const occurrence of occurrences) {
      const service = demoServices.find((item) => item.id === occurrence.serviceId);
      if (!service || !compatibleSlots({ service, locationId: occurrence.locationId, appointments: nextAppointments, patientId: occurrence.patientId, notBefore: operations.clockIso, dateKey: clinicDateKey(occurrence.startsAt), availability: operations.schedule }).some((slot) => slot.startsAt === occurrence.startsAt && slot.practitionerId === occurrence.practitionerId && slot.resourceId === occurrence.resourceIds[0])) return false;
      nextAppointments.push(occurrence);
    }
    const nextOperations = { ...operations, schedule: { ...operations.schedule, recurringSeries: [...operations.schedule.recurringSeries, series] } };
    let previousAppointments: string | null = null;
    try {
      previousAppointments = window.sessionStorage.getItem(storageKey);
      savePreviewItem(storageKey, JSON.stringify(nextAppointments));
      savePreviewItem(operationsStorageKey, JSON.stringify(nextOperations));
    } catch (error: unknown) {
      console.error("Could not save recurring preview appointments", error);
      try {
        if (previousAppointments === null) window.sessionStorage.removeItem(storageKey);
        else savePreviewItem(storageKey, previousAppointments);
      } catch (rollbackError: unknown) {
        console.error("Could not restore preview appointments after recurring save failure", rollbackError);
      }
      return false;
    }
    setAppointments(nextAppointments);
    setOperations(nextOperations);
    return true;
  }

  /** Calls the next waiting customer in this browser. Returns who was called, or null when no one is waiting. */
  function callNextInQueue(practitionerId?: string): Appointment | null {
    const next = nextInQueue(previewAppointments.filter((item) => !practitionerId || item.practitionerId === practitionerId), operations.clockIso);
    if (!next?.queue) return null;
    const saved = updateOperations((current) => {
      const ticket = current.queueTickets[next.id];
      return ticket ? { ...current, queueTickets: { ...current.queueTickets, [next.id]: { ...ticket, calledAt: current.clockIso, callCount: ticket.callCount + 1, skippedAt: undefined } } } : current;
    });
    return saved ? next : null;
  }

  /** Records quick messages to these visits' customers. Nothing leaves the browser in the preview. */
  function recordQuickMessages(appointmentIds: string[], kind: string): boolean {
    return updateOperations((current) => {
      const added: StaffMessage[] = appointmentIds.flatMap((appointmentId, index) => {
        const appointment = previewAppointments.find((item) => item.id === appointmentId);
        if (!appointment) return [];
        const patient = patients.find((item) => item.id === appointment.patientId);
        return [{
          id: `message_${appointmentId}_${current.messages.length + index + 1}`,
          appointmentId,
          patientId: appointment.patientId,
          channel: notificationChannel(appointment.bookingSource, patient?.preferredChannel ?? "email"),
          templateKey: `appointment.quick_message.${kind}`,
          status: "queued",
          createdAt: current.clockIso,
        }];
      });
      return { ...current, messages: [...added, ...current.messages] };
    });
  }

  function updateQueueTicket(appointmentId: string, action: QueueAction): boolean {
    const ticket = operations.queueTickets[appointmentId];
    if (!ticket) return false;
    const changes: Record<QueueAction, Partial<PreviewQueueTicket>> = {
      call_again: { calledAt: operations.clockIso, callCount: ticket.callCount + 1, skippedAt: undefined },
      skip: { calledAt: undefined, skippedAt: operations.clockIso },
      urgent: { urgent: true },
      not_urgent: { urgent: false },
    };
    return updateOperations((current) => ({ ...current, queueTickets: { ...current.queueTickets, [appointmentId]: { ...ticket, ...changes[action] } } }));
  }

  function recordAudit(event: AuditEvent): boolean {
    return recordAudits([event]);
  }

  function recordAudits(events: AuditEvent[]): boolean {
    if (staffSnapshot) return false;
    const updated = [...events, ...auditEvents];
    try {
      savePreviewItem(auditStorageKey, JSON.stringify(updated));
    } catch (error: unknown) {
      console.error("Could not save preview audit activity", error);
      return false;
    }
    setAuditEvents(updated);
    return true;
  }

  return {
    appointments: visibleAppointments,
    updateAppointment,
    addAppointment,
    addRecurringSeries,
    auditEvents,
    recordAudit,
    recordAudits,
    patients: visiblePatients,
    operations: visibleOperations,
    advancePreviewClock,
    recordVisitTiming,
    assignOwner,
    addHandoverNote,
    removeHandoverNote,
    saveDoctorHours,
    addScheduleBlock,
    updateScheduleBlock,
    removeScheduleBlock,
    callNextInQueue,
    updateQueueTicket,
    recordQuickMessages,
    database: Boolean(staffSnapshot),
  };
}

export function appointmentHasConflict(appointment: Appointment, appointments: Appointment[]): boolean {
  const service = demoServices.find((item) => item.id === appointment.serviceId);
  const start = Date.parse(appointment.startsAt) - (service?.bufferBeforeMinutes ?? 0) * 60_000;
  const end = Date.parse(appointment.endsAt) + (service?.bufferAfterMinutes ?? 0) * 60_000;
  return appointments.some((other) => {
    if (other.id === appointment.id || ["cancelled", "entered_in_error", "no_show"].includes(other.status)) return false;
    if (other.patientId !== appointment.patientId && other.practitionerId !== appointment.practitionerId && !other.resourceIds.some((id) => appointment.resourceIds.includes(id))) return false;
    const otherService = demoServices.find((item) => item.id === other.serviceId);
    const otherStart = Date.parse(other.startsAt) - (otherService?.bufferBeforeMinutes ?? 0) * 60_000;
    const otherEnd = Date.parse(other.endsAt) + (otherService?.bufferAfterMinutes ?? 0) * 60_000;
    return overlaps(start, end, otherStart, otherEnd);
  });
}

/** Arrival and start times saved on each visit. */
function storedVisitTimings(appointments: Appointment[]): Record<string, VisitTiming> {
  const timings: Record<string, VisitTiming> = {};
  for (const appointment of appointments) {
    if (!appointment.checkedInAt && !appointment.startedAt) continue;
    timings[appointment.id] = {
      ...(appointment.checkedInAt ? { checkedInAt: appointment.checkedInAt } : {}),
      ...(appointment.startedAt ? { startedAt: appointment.startedAt } : {}),
    };
  }
  return timings;
}

export function visitStartConflict(appointment: Appointment, appointments: Appointment[], visitTimings: Record<string, VisitTiming>, clockIso: string): Appointment | undefined {
  const service = demoServices.find((item) => item.id === appointment.serviceId);
  const start = Date.parse(clockIso);
  const end = start + (service?.durationMinutes ?? 0) * 60_000 + (service?.bufferAfterMinutes ?? 0) * 60_000;
  return appointments.find((other) => {
    if (other.id === appointment.id || !["requested", "booked", "checked_in"].includes(other.status)) return false;
    if (other.practitionerId !== appointment.practitionerId && !other.resourceIds.some((id) => appointment.resourceIds.includes(id))) return false;
    if (other.status === "checked_in" && visitTimings[other.id]?.startedAt) return true;
    const otherService = demoServices.find((item) => item.id === other.serviceId);
    return overlaps(start, end, Date.parse(other.startsAt) - (otherService?.bufferBeforeMinutes ?? 0) * 60_000, Date.parse(other.endsAt) + (otherService?.bufferAfterMinutes ?? 0) * 60_000);
  });
}

export function compatibleSlots({
  service,
  locationId,
  appointments,
  excludeAppointmentId,
  patientId,
  waitlist,
  notBefore,
  dateKey,
  availability = defaultScheduleAvailability,
}: {
  service: Service;
  locationId: string;
  appointments: Appointment[];
  excludeAppointmentId?: string;
  patientId?: string;
  waitlist?: WaitlistEntry;
  notBefore?: string;
  dateKey?: string;
  availability?: ScheduleAvailability;
}): TimeSlot[] {
  const before = service.bufferBeforeMinutes * 60_000;
  const after = service.bufferAfterMinutes * 60_000;
  const duration = service.durationMinutes * 60_000;
  const candidates = [...staffDaySlots, ...demoSlots, ...(dateKey ? staffSlotsForDate(dateKey, service, locationId, availability) : [])];
  const seen = new Set<string>();
  return candidates.filter((slot) => {
    const start = Date.parse(slot.startsAt);
    const end = Date.parse(slot.endsAt);
    const resource = demoResources.find((item) => item.id === slot.resourceId);
    const practitioner = previewDoctors().find((item) => item.id === slot.practitionerId);
    if (dateKey && clinicDateKey(slot.startsAt) !== dateKey) return false;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < duration) return false;
    if (notBefore && start <= Date.parse(notBefore)) return false;
    if (!service.locationIds.includes(locationId) || !practitionerOffersService(slot.practitionerId, service)) return false;
    if (practitioner?.isActive === false || !practitioner?.locationIds.includes(locationId) || !resource || resource.locationId !== locationId) return false;
    if (service.resourceKind && resource.kind !== service.resourceKind) return false;
    if (slotAvailabilityIssue(slot, service, availability)) return false;
    const identity = `${slot.startsAt}|${slot.practitionerId}|${slot.resourceId}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    if (waitlist) {
      const day = slot.startsAt.slice(0, 10);
      const hour = Number(slot.startsAt.slice(11, 13));
      if (day < waitlist.dateFrom || day > waitlist.dateTo) return false;
      if (waitlist.preferredPractitionerIds.length > 0 && !waitlist.preferredPractitionerIds.includes(slot.practitionerId)) return false;
      if (waitlist.timePreference === "morning" && hour >= 12) return false;
      if (waitlist.timePreference === "afternoon" && (hour < 12 || hour >= 17)) return false;
      if (waitlist.timePreference === "evening" && hour < 17) return false;
    }
    return !appointments.some((appointment) => {
      if (appointment.id === excludeAppointmentId || ["cancelled", "entered_in_error", "no_show"].includes(appointment.status)) return false;
      if (appointment.patientId !== patientId && appointment.practitionerId !== slot.practitionerId && !appointment.resourceIds.includes(resource.id)) return false;
      const bookedService = demoServices.find((item) => item.id === appointment.serviceId);
      const bookedStart = Date.parse(appointment.startsAt) - (bookedService?.bufferBeforeMinutes ?? 0) * 60_000;
      const bookedEnd = Date.parse(appointment.endsAt) + (bookedService?.bufferAfterMinutes ?? 0) * 60_000;
      return overlaps(start - before, start + duration + after, bookedStart, bookedEnd);
    });
  }).sort((first, second) => first.startsAt.localeCompare(second.startsAt) || first.practitionerId.localeCompare(second.practitionerId) || (first.resourceId ?? "").localeCompare(second.resourceId ?? ""));
}

export function appointmentEndForSlot(slot: TimeSlot, service: Service): string {
  return new Date(Date.parse(slot.startsAt) + service.durationMinutes * 60_000).toISOString();
}
