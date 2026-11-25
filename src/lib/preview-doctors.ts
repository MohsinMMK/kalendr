import { demoPractitioners, demoServices } from "@/lib/demo-data";
import type { Practitioner, Service } from "@/lib/domain";

/** A doctor as the browser preview stores them. The database keeps service links in their own table. */
export interface PreviewDoctor extends Practitioner {
  serviceIds: string[];
}

export interface PreviewDoctorState {
  doctors: Practitioner[];
  services: Service[];
  serviceIdsByDoctor: Record<string, string[]>;
}

const storageKey = "kalendr-preview-doctors-v1";
const changeEvent = "kalendr-preview-doctors-change";

function buildState(records: PreviewDoctor[]): PreviewDoctorState {
  const byId = new Map(records.map((record) => [record.id, record]));
  const profile = (record: PreviewDoctor): Practitioner => {
    const doctor: Practitioner & { serviceIds?: string[] } = { ...record };
    delete doctor.serviceIds;
    return doctor;
  };
  const doctors = [
    ...demoPractitioners.map((doctor) => {
      const edited = byId.get(doctor.id);
      return edited ? profile(edited) : doctor;
    }),
    ...records.filter((record) => !demoPractitioners.some((doctor) => doctor.id === record.id)).map(profile),
  ];
  const serviceIdsByDoctor = Object.fromEntries(records.map((record) => [record.id, record.serviceIds]));
  const services = demoServices.map((service) => ({
    ...service,
    practitionerIds: doctors.filter((doctor) => (
      serviceIdsByDoctor[doctor.id]?.includes(service.id) ?? service.practitionerIds.includes(doctor.id)
    )).map((doctor) => doctor.id),
  }));
  return { doctors, services, serviceIdsByDoctor };
}

const emptyState = buildState([]);
let cachedRaw: string | null = null;
let cached = emptyState;

function isRecord(value: unknown): value is PreviewDoctor {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<PreviewDoctor>;
  return typeof record.id === "string" && typeof record.name === "string" && Array.isArray(record.locationIds) && Array.isArray(record.serviceIds);
}

function storedRecords(raw: string | null): PreviewDoctor[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
}

export function getPreviewDoctorState(): PreviewDoctorState {
  if (typeof window === "undefined") return emptyState;
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (raw === cachedRaw) return cached;
    cached = buildState(storedRecords(raw));
    cachedRaw = raw;
  } catch (error: unknown) {
    console.error("Could not load preview doctors", error);
  }
  return cached;
}

export function getServerPreviewDoctorState(): PreviewDoctorState {
  return emptyState;
}

export function subscribePreviewDoctors(notify: () => void) {
  window.addEventListener(changeEvent, notify);
  return () => window.removeEventListener(changeEvent, notify);
}

export function previewDoctors(): Practitioner[] {
  return getPreviewDoctorState().doctors;
}

export function practitionerOffersService(practitionerId: string, service: Service): boolean {
  return getPreviewDoctorState().serviceIdsByDoctor[practitionerId]?.includes(service.id) ?? service.practitionerIds.includes(practitionerId);
}

export function savePreviewDoctor(doctor: PreviewDoctor): boolean {
  try {
    const records = storedRecords(window.sessionStorage.getItem(storageKey)).filter((record) => record.id !== doctor.id);
    window.sessionStorage.setItem(storageKey, JSON.stringify([...records, doctor]));
  } catch (error: unknown) {
    console.error("Could not save preview doctor", error);
    return false;
  }
  window.dispatchEvent(new Event(changeEvent));
  return true;
}
