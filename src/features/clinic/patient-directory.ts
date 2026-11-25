import type { Appointment, Patient } from "@/lib/domain";

import { clinicDateKey } from "./schedule-availability";

export type PatientSearchField = "all" | "name" | "id" | "phone" | "email";

/** Walk-ins give only a first name, so an empty last name adds no trailing space. */
export function patientName(patient: Pick<Patient, "firstName" | "lastName">): string {
  return [patient.firstName, patient.lastName].map((part) => part.trim()).filter(Boolean).join(" ");
}

function normalizeText(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en-IN").trim();
}

export function phoneDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function comparablePhone(value: string): string {
  const digits = phoneDigits(value);
  return digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
}

export function searchPatients(patients: Patient[], query: string, field: PatientSearchField = "all"): Patient[] {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return patients;
  const numericQuery = phoneDigits(query);
  const phoneShapedQuery = /^[+\d\s()-]+$/.test(query.trim());
  return patients.filter((patient) => {
    const nameMatches = normalizeText(patientName(patient)).includes(normalizedQuery);
    const idMatches = normalizeText(patient.id).includes(normalizedQuery);
    const phoneMatches = numericQuery.length > 0 && phoneShapedQuery && phoneDigits(patient.phone).includes(numericQuery);
    const emailMatches = normalizeText(patient.email).includes(normalizedQuery);
    if (field === "name") return nameMatches;
    if (field === "id") return idMatches;
    if (field === "phone") return phoneMatches;
    if (field === "email") return emailMatches;
    return nameMatches || idMatches || phoneMatches || emailMatches;
  });
}

export function matchingPatientContacts(patients: Patient[], phone: string, email: string): Patient[] {
  const enteredPhone = comparablePhone(phone);
  const enteredEmail = normalizeText(email);
  return patients.filter((patient) =>
    (enteredPhone.length >= 8 && comparablePhone(patient.phone) === enteredPhone) ||
    (enteredEmail.length > 0 && normalizeText(patient.email) === enteredEmail),
  );
}

export function patientBookingContext(patientId: string, appointments: Appointment[], clockIso: string): { kind: "next" | "last"; appointment: Appointment } | null {
  // A visit earlier today that nobody has closed yet is still the patient's next visit: they may just be late.
  const today = clinicDateKey(clockIso);
  const future = appointments
    .filter((appointment) => appointment.patientId === patientId && (Date.parse(appointment.startsAt) >= Date.parse(clockIso) || clinicDateKey(appointment.startsAt) === today) && (appointment.status === "booked" || appointment.status === "requested"))
    .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
  if (future[0]) return { kind: "next", appointment: future[0] };
  const previous = appointments
    .filter((appointment) => appointment.patientId === patientId && Date.parse(appointment.startsAt) < Date.parse(clockIso) && appointment.status === "completed")
    .sort((left, right) => Date.parse(right.startsAt) - Date.parse(left.startsAt));
  return previous[0] ? { kind: "last", appointment: previous[0] } : null;
}
