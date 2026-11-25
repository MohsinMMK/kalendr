import type { Appointment, Patient } from "@/lib/domain";
import type { TermWords } from "@/lib/terminology";

import { appointmentTime } from "./clinic-format";
import { clinicDateKey } from "./schedule-availability";
import { patientName } from "./patient-directory";

export type ActionKind = "wait" | "request" | "form";

export interface ActionItem {
  key: string;
  kind: ActionKind;
  appointment: Appointment;
  title: string;
  detail: string;
  linkLabel: string;
  href: string;
}

type VisitTimings = Record<string, { checkedInAt?: string; startedAt?: string } | undefined>;

const kindOrder: Record<ActionKind, number> = { wait: 0, request: 1, form: 2 };

/** Pass the business's words (`useTerms()`) so an unknown person reads as its own customer word; healthcare by default. */
export function appointmentPatientName(appointment: Appointment, patients: Patient[], t?: Pick<TermWords, "Customer">): string {
  const patient = patients.find((item) => item.id === appointment.patientId);
  return patient ? patientName(patient) : t?.Customer ?? "Patient";
}

/** How far past its start a visit is, as "Late 25 min" or "Late 2h 15m". Null until it is a full minute late. */
export function lateLabel(startsAt: string, clockIso: string): string | null {
  const minutes = Math.floor((Date.parse(clockIso) - Date.parse(startsAt)) / 60_000);
  if (minutes < 1) return null;
  if (minutes < 60) return `Late ${minutes} min`;
  const remainder = minutes % 60;
  return `Late ${Math.floor(minutes / 60)}h${remainder ? ` ${remainder}m` : ""}`;
}

/** The visits still on a clinic day, earliest first. Cancelled, no-show and voided visits are left out. */
export function dayVisits(appointments: Appointment[], dayKey: string): Appointment[] {
  return appointments
    .filter((appointment) => clinicDateKey(appointment.startsAt) === dayKey && !["cancelled", "entered_in_error", "no_show", "expired"].includes(appointment.status))
    .sort((first, second) => first.startsAt.localeCompare(second.startsAt));
}

export function waitingMinutes(checkedInAt: string, clockIso: string): number {
  return Math.max(0, Math.floor((Date.parse(clockIso) - Date.parse(checkedInAt)) / 60_000));
}

/** What the front desk has to act on for these visits, most urgent first. */
export function actionItems(visits: Appointment[], patients: Patient[], timings: VisitTimings, clockIso: string, t?: Pick<TermWords, "Customer">): ActionItem[] {
  return visits.flatMap((appointment) => {
    const name = appointmentPatientName(appointment, patients, t);
    const items: ActionItem[] = [];
    const timing = timings[appointment.id];
    const wait = timing?.checkedInAt && appointment.status === "checked_in" && !timing.startedAt ? waitingMinutes(timing.checkedInAt, clockIso) : 0;
    if (wait >= 15) items.push({ key: `wait_${appointment.id}`, kind: "wait", appointment, title: "Long wait", detail: `${name} · waiting ${wait} min`, linkLabel: "Review queue", href: `/appointments/${appointment.id}?from=dashboard&action=start` });
    if (appointment.status === "requested") items.push({ key: `request_${appointment.id}`, kind: "request", appointment, title: "Booking request", detail: `${name} · ${appointmentTime(appointment.startsAt)}`, linkLabel: "Review request", href: `/appointments/${appointment.id}?from=dashboard` });
    if (["booked", "requested", "checked_in"].includes(appointment.status) && appointment.formStatus !== "submitted") {
      const title = appointment.formStatus === "not_assigned" ? "Form not assigned" : appointment.formStatus === "not_started" ? "Form not started" : "Form incomplete";
      items.push({ key: `form_${appointment.id}`, kind: "form", appointment, title, detail: `${name} · ${appointmentTime(appointment.startsAt)}`, linkLabel: "Review readiness", href: `/appointments/${appointment.id}?from=dashboard&action=form_received` });
    }
    return items;
  }).sort((first, second) => kindOrder[first.kind] - kindOrder[second.kind]);
}
