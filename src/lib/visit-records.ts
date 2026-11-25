import { isClinicalBusinessType } from "@/lib/business-types";
import { profileWords, type BusinessProfile } from "@/lib/terminology";

export type VisitRecordKind = "note" | "report" | "prescription";
export type VisitRecordStatus = "draft" | "shared";

export const recordKindLabels: Record<VisitRecordKind, string> = {
  note: "Visit note",
  report: "Report",
  prescription: "Prescription",
};

/** The record kind names for one business. Healthcare and dental read as `recordKindLabels`; others get no medical words. */
export function recordKindLabelsFor(profile: BusinessProfile): Record<VisitRecordKind, string> {
  if (isClinicalBusinessType(profile.businessType)) return recordKindLabels;
  const t = profileWords(profile);
  return { note: `${t.Visit} note`, report: "Report", prescription: "Document" };
}

/** Clinical records are a separate permission from the schedule: front-desk roles never open them. */
export function roleCanOpenRecords(role: string): boolean {
  return role === "owner" || role === "admin" || role === "practitioner";
}

/** pending: waiting for the virus scan. infected: removed. skipped: no scanner (development only). */
export type RecordFileScanStatus = "pending" | "clean" | "infected" | "skipped";

export interface RecordFileSummary {
  id: string;
  name: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
  scanStatus?: RecordFileScanStatus;
  /** Only the browser preview has this. Real files are served by an audited route. */
  previewDataUrl?: string;
}

export interface VisitRecordSummary {
  id: string;
  patientId: string;
  patientName: string;
  appointmentId: string | null;
  practitionerName: string | null;
  kind: VisitRecordKind;
  status: VisitRecordStatus;
  title: string;
  createdAt: string;
  sharedAt: string | null;
  fileCount: number;
}

export interface RecordAccessEntry {
  id: string;
  who: string;
  action: string;
  occurredAt: string;
}

export interface VisitRecordDetail extends VisitRecordSummary {
  body: string;
  files: RecordFileSummary[];
  everShared: boolean;
  /** Null unless the viewer is an owner or admin. */
  accessLog: RecordAccessEntry[] | null;
}

export interface RecordAccessRequest {
  accessId: string;
  patientId: string;
  patientName: string;
  contact: string;
  requestedAt: string;
}

export interface RecordsList {
  records: VisitRecordSummary[];
  accessRequests: RecordAccessRequest[];
}

export interface VisitRecordInput {
  patientId: string;
  appointmentId: string | null;
  kind: VisitRecordKind;
  title: string;
  body: string;
}

/**
 * Whether this person's documents are open, and if not, the one step that opens them.
 * "date_of_birth": they can prove it themselves. "ask_clinic": the clinic has no date of birth on file, or too many
 * wrong tries were made. "requested": they asked, and the clinic hasn't answered yet.
 */
export type PortalRecordAccess = "open" | "date_of_birth" | "ask_clinic" | "requested";

export interface PortalPerson {
  clinicSlug: string;
  clinicName: string;
  patientId: string;
  name: string;
  isDependent: boolean;
  access: PortalRecordAccess;
}

export interface PortalVisit {
  id: string;
  clinicSlug: string;
  clinicName: string;
  patientId: string;
  serviceName: string;
  practitionerName: string;
  /** Who and what the visit was with, so it can be booked again. Missing on visits kept from before these were sent. */
  practitionerId?: string;
  serviceId?: string;
  locationName: string;
  startsAt: string;
  timezone: string;
  status: string;
  /** Where the patient reviews or changes this visit. The browser preview has no page for some past visits. */
  href: string | null;
}

/** Someone the customer has booked with, for the list of people they can book again. */
export interface PortalProvider {
  clinicSlug: string;
  id: string;
  /** Their title and speciality, as the business wrote them. */
  role: string;
  photoUrl: string | null;
  /** False once they no longer take bookings. They stay in the list, without Book again or Share. */
  isActive: boolean;
}

/** One person the customer has seen or is booked with, counted across their visits. */
export interface SavedPerson {
  /** Unique across businesses: the business's link name and the person's id. */
  key: string;
  clinicSlug: string;
  clinicName: string;
  id: string;
  name: string;
  /** Visits that took place. Cancelled and missed ones are not counted. */
  visits: number;
  lastVisitAt: string | null;
  /** The soonest visit still to come, if any. */
  nextVisitAt: string | null;
  /** The service of the most recent visit, offered again by Book again. */
  lastServiceId: string | null;
  lastServiceName: string | null;
  timezone: string;
}

const upcomingStatuses = new Set(["booked", "requested", "checked_in"]);
const attendedStatuses = new Set(["booked", "checked_in", "completed"]);

/**
 * The people a customer has booked with, from their visits: most recently seen first, then those only booked ahead.
 * Someone whose every visit was cancelled or missed is left out.
 */
export function savedPeople(visits: readonly PortalVisit[], nowMs: number): SavedPerson[] {
  const people = new Map<string, SavedPerson>();
  const latestMs = new Map<string, number>();
  for (const visit of visits) {
    if (!visit.practitionerId) continue;
    const startsMs = Date.parse(visit.startsAt);
    if (Number.isNaN(startsMs)) continue;
    const upcoming = startsMs >= nowMs && upcomingStatuses.has(visit.status);
    const attended = startsMs < nowMs && attendedStatuses.has(visit.status);
    if (!upcoming && !attended) continue;
    const key = `${visit.clinicSlug}/${visit.practitionerId}`;
    const person = people.get(key) ?? {
      key, clinicSlug: visit.clinicSlug, clinicName: visit.clinicName, id: visit.practitionerId, name: visit.practitionerName,
      visits: 0, lastVisitAt: null, nextVisitAt: null, lastServiceId: null, lastServiceName: null, timezone: visit.timezone,
    };
    people.set(key, person);
    if (upcoming) {
      if (!person.nextVisitAt || startsMs < Date.parse(person.nextVisitAt)) person.nextVisitAt = visit.startsAt;
    } else {
      person.visits += 1;
      if (!person.lastVisitAt || startsMs > Date.parse(person.lastVisitAt)) person.lastVisitAt = visit.startsAt;
    }
    // The newest visit of either kind names the person and the service to offer again.
    if (startsMs >= (latestMs.get(key) ?? Number.NEGATIVE_INFINITY)) {
      latestMs.set(key, startsMs);
      person.name = visit.practitionerName;
      person.lastServiceId = visit.serviceId ?? null;
      person.lastServiceName = visit.serviceName;
      person.timezone = visit.timezone;
    }
  }
  const recency = (person: SavedPerson) => (person.lastVisitAt ? Date.parse(person.lastVisitAt) : Number.NEGATIVE_INFINITY);
  return [...people.values()].sort((left, right) => recency(right) - recency(left) || right.visits - left.visits || left.name.localeCompare(right.name));
}

export interface PortalRecord {
  id: string;
  clinicSlug: string;
  clinicName: string;
  patientId: string;
  kind: VisitRecordKind;
  title: string;
  practitionerName: string | null;
  sharedAt: string;
  fileCount: number;
}

export interface PortalRecordDetail extends PortalRecord {
  body: string;
  files: RecordFileSummary[];
}

export interface PortalSnapshot {
  contact: string;
  people: PortalPerson[];
  visits: PortalVisit[];
  /** Details of the people in `visits`, for the list of people to book again. */
  providers?: PortalProvider[];
  records: PortalRecord[];
  /** Each business's words and features, keyed by its booking slug. */
  profiles: Record<string, BusinessProfile>;
}
