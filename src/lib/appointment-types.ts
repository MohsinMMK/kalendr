import { getBusinessType, isClinicalBusinessType, type BusinessTypeId } from "@/lib/business-types";
import type { BookingMode, Resource } from "@/lib/domain";

export type PracticeKind = "dental" | "hospital" | "family" | "general";

export interface AppointmentTypePreset {
  name: string;
  description: string;
  durationMinutes: number;
  bookingMode: BookingMode;
  requiredResourceKind?: Resource["kind"];
  priceLabel?: string;
}

export function inferPracticeKind(clinicName: string): PracticeKind {
  if (/dental|dentist|tooth|oral/i.test(clinicName)) return "dental";
  if (/hospital/i.test(clinicName)) return "hospital";
  if (/family|gp\b|general practice/i.test(clinicName)) return "family";
  return "general";
}

const dentalPresets: AppointmentTypePreset[] = [
  { name: "Consultation", description: "A first visit or review of a dental concern.", durationMinutes: 30, bookingMode: "instant" },
  { name: "Dental cleaning", description: "A routine cleaning and oral health check.", durationMinutes: 45, bookingMode: "instant", requiredResourceKind: "chair" },
  { name: "Filling", description: "Treat a cavity or replace an old filling.", durationMinutes: 45, bookingMode: "instant", requiredResourceKind: "chair" },
  { name: "Root canal", description: "Treat an infected tooth. The clinic confirms a suitable time.", durationMinutes: 60, bookingMode: "request", requiredResourceKind: "chair" },
  { name: "Extraction", description: "Remove a tooth. The clinic confirms a suitable time.", durationMinutes: 30, bookingMode: "request", requiredResourceKind: "chair" },
  { name: "Braces review", description: "A scheduled orthodontic check.", durationMinutes: 20, bookingMode: "instant" },
  { name: "Whitening", description: "A planned whitening visit.", durationMinutes: 45, bookingMode: "instant", requiredResourceKind: "chair" },
];

const hospitalPresets: AppointmentTypePreset[] = [
  { name: "Consultation", description: "Meet a practitioner and plan next steps.", durationMinutes: 30, bookingMode: "instant" },
  { name: "Follow-up", description: "A scheduled review after a previous visit.", durationMinutes: 20, bookingMode: "instant" },
  { name: "Procedure", description: "A planned procedure. The clinic confirms a suitable time.", durationMinutes: 60, bookingMode: "request", requiredResourceKind: "room" },
  { name: "Diagnostic visit", description: "Tests or imaging arranged by the clinic.", durationMinutes: 30, bookingMode: "request" },
];

const familyPresets: AppointmentTypePreset[] = [
  { name: "Consultation", description: "A usual first visit or new concern.", durationMinutes: 30, bookingMode: "instant" },
  { name: "Follow-up", description: "A scheduled review.", durationMinutes: 20, bookingMode: "instant" },
  { name: "Vaccination", description: "A planned immunisation visit.", durationMinutes: 15, bookingMode: "instant" },
  { name: "Health check", description: "A longer preventive visit.", durationMinutes: 45, bookingMode: "instant" },
];

const generalPresets: AppointmentTypePreset[] = [
  { name: "Consultation", description: "A scheduled clinic visit.", durationMinutes: 30, bookingMode: "instant" },
  { name: "Follow-up", description: "A scheduled review.", durationMinutes: 20, bookingMode: "instant" },
  { name: "Procedure", description: "A planned procedure. The clinic confirms a suitable time.", durationMinutes: 45, bookingMode: "request" },
];

export function appointmentTypePresets(kind: PracticeKind): AppointmentTypePreset[] {
  if (kind === "dental") return dentalPresets;
  if (kind === "hospital") return hospitalPresets;
  if (kind === "family") return familyPresets;
  return generalPresets;
}

export function unusedAppointmentPresets(
  kind: PracticeKind,
  existingNames: string[],
): AppointmentTypePreset[] {
  const taken = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  return appointmentTypePresets(kind).filter((preset) => !taken.has(preset.name.toLowerCase()));
}

/**
 * Quick-add suggestions for one business. Healthcare and dental keep the clinic presets picked from the
 * clinic's name; every other type gets its own starter services, so no medical names appear.
 */
export function unusedPresetsForBusiness(
  businessType: BusinessTypeId,
  businessName: string,
  existingNames: string[],
): AppointmentTypePreset[] {
  if (isClinicalBusinessType(businessType)) return unusedAppointmentPresets(inferPracticeKind(businessName), existingNames);
  const taken = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  return getBusinessType(businessType).starterServices
    .filter((service) => !taken.has(service.name.toLowerCase()))
    .map((service) => ({
      name: service.name,
      description: service.description,
      durationMinutes: service.durationMinutes,
      bookingMode: service.bookingMode,
      ...(service.requiredResourceKind ? { requiredResourceKind: service.requiredResourceKind } : {}),
    }));
}
