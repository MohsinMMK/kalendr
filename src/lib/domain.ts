import type { ServiceColor, ServiceLength, ServiceLocationOption } from "@/lib/service-setup";
import type { BusinessTypeId, ResourceKind } from "@/lib/business-types";
import type { HeardFrom } from "@/lib/heard-from";
import type { CustomFieldValues } from "@/lib/visit-fields";
import type { FeatureOverrides, StoredTerminology } from "@/lib/terminology";

export type AppointmentStatus =
  | "requested"
  | "booked"
  | "checked_in"
  | "completed"
  | "cancelled"
  | "no_show"
  | "entered_in_error"
  | "declined"
  | "expired"
  | "reschedule_requested"
  | "pending_payment";

export type ConfirmationStatus =
  | "needs_action"
  | "confirmed"
  | "declined";

export type PatientType = "new" | "returning";
export type BookingMode = "instant" | "request";
export type ContactChannel = "sms" | "email" | "whatsapp" | "phone";
export type QueueKind = "arriving" | "approval" | "unconfirmed" | "waitlist";

export interface Clinic {
  id: string;
  slug: string;
  name: string;
  legalName: string;
  phone: string;
  email: string;
  timezone: string;
  locale: string;
  /** Absent means healthcare, which is what every business was before business types existed. */
  businessType?: BusinessTypeId;
  terminology?: StoredTerminology;
  features?: FeatureOverrides;
  /** Public picture address. Absent in preview mode, null when no logo is set. */
  logoUrl?: string | null;
  /** Public picture address. Absent in preview mode, null when no cover is set. */
  coverUrl?: string | null;
  /** A short public description for the business page. */
  about?: string | null;
  /** ISO 4217 code for every price and payment. Absent means INR. */
  currency?: string;
  /** How the booking page writes times. Absent means follow the visitor's locale. */
  defaultClock?: import("./booking-page").ClockMode;
  /** First day of the week on the booking page: 1 is Monday, 7 is Sunday. Absent means Monday. */
  weekStart?: 1 | 7;
  /** The business's look on public pages (feature 13). Absent means Kalendr's own look. `hideBadge` already reflects the plan. */
  brand?: import("./brand-theme").BrandSettings;
}

export interface Location {
  id: string;
  clinicId: string;
  name: string;
  address: string;
  city: string;
  timezone: string;
  accessibleEntrance: boolean;
  isActive?: boolean;
}

export interface Practitioner {
  id: string;
  clinicId: string;
  locationIds: string[];
  name: string;
  title: string;
  initials: string;
  specialty: string;
  isActive?: boolean;
  photoUrl?: string | null;
  bio?: string | null;
  qualifications?: string | null;
  experienceYears?: number | null;
  languages?: string | null;
  /** Staff only. Never included in the public catalog. */
  phone?: string | null;
  /** Staff only. Never included in the public catalog. */
  registrationNumber?: string | null;
}

export interface Resource {
  id: string;
  locationId: string;
  name: string;
  kind: ResourceKind;
  isActive?: boolean;
}

export interface Service {
  id: string;
  clinicId: string;
  name: string;
  description: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  bookingMode: BookingMode;
  patientTypes: PatientType[];
  practitionerIds: string[];
  locationIds: string[];
  resourceKind?: Resource["kind"];
  priceLabel?: string;
  /** What the service costs and how it is paid for (feature 23). `payment` is only set when it takes payment online right now. */
  priceMinor?: number | null;
  paymentMode?: "none" | "deposit" | "full";
  depositMinor?: number | null;
  /** Groups services into chips on the business page. Services without one show under "All". */
  category?: string;
  isActive?: boolean;
  /** Public picture address. Absent in preview mode, null when no photo is set. */
  imageUrl?: string | null;
  /** Link-safe name used in `/book/[business]/[slug]`. Absent in preview mode. */
  slug?: string;
  /** Hidden services are left out of listings but still book from their own link. */
  visibility?: "listed" | "hidden";
  /** Who gives the booking (feature 20). Anything but `customer_chooses` skips the "who would you like to see" screen. */
  assignment?: "customer_chooses" | "any_available" | "round_robin";
  /** The lengths customers can choose, each with its price. One is the default (equal to `durationMinutes`). */
  lengths?: ServiceLength[];
  /** Ways the visit can happen. With one option the customer is told, with several they choose. */
  locationOptions?: ServiceLocationOption[];
  /** Calendar palette names for light and dark mode. */
  colorLight?: ServiceColor | null;
  colorDark?: ServiceColor | null;
  /** Picture from the media library shown on the service's booking page. */
  bannerUrl?: string | null;
  /** Counts up on every edit. Used by the editor's "someone else changed this" check. */
  version?: number;
  /** Layouts, timezone lock and week start on the booking page. Absent means every layout, month first, own timezone. */
  bookingPage?: import("./booking-page").BookingPageSettings;
  /** Contact details, guests and the email check. Absent means email or phone, no guests, no check. */
  intake?: import("./booking-intake").IntakeSettings;
  /** What the customer sees after booking (feature 52). Absent means Kalendr's own confirmation. */
  afterBooking?: import("./after-booking").PublicAfterBooking;
  /** Which bookings wait for staff. Absent means every booking is confirmed at once. */
  approval?: import("./approval").ApprovalSettings;
  /** What customers may do from their manage link. Absent means cancel and move any time. */
  cancelPolicy?: import("./cancel-policy").CancelPolicy;
  /** Added to the public catalog (feature 23): what is paid online and the policy words. Null or absent: nothing is paid online. */
  payment?: import("./payments").PublicServicePayment | null;
}

export interface Patient {
  id: string;
  clinicId: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  dateOfBirth?: string;
  preferredChannel: ContactChannel;
  accessibilityNeed?: string;
  isDependent: boolean;
  /** When they accepted the privacy notice, if recorded. */
  privacyAcceptedAt?: string;
  /** When they agreed to reminders by text or WhatsApp. Absent means email only. */
  messagingConsentAt?: string;
  /** Set when staff blocked this customer from booking online (feature 27). Staff can still book them at the desk. */
  blockedAt?: string;
}

/** How an appointment was made. online is the clinic's own booking page. */
export type BookingSource = "online" | "widget" | "iframe" | "phone" | "staff" | "walk_in" | "recall" | "waitlist" | "assistant";

export interface Appointment {
  id: string;
  clinicId: string;
  locationId: string;
  patientId: string;
  practitionerId: string;
  serviceId: string;
  resourceIds: string[];
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  confirmationStatus: ConfirmationStatus;
  bookingSource: BookingSource;
  formStatus: "not_assigned" | "not_started" | "in_progress" | "submitted";
  reminderStatus: "not_scheduled" | "queued" | "delivered" | "failed";
  manageToken: string;
  /** How this visit happens. Absent means in person. Video visits show a "Join video visit" button to staff. */
  deliveryMode?: "in_person" | "video" | "phone";
  notes?: string;
  reasonForVisit?: string;
  /** For online bookings: the referring site's host name and campaign tags. */
  referrerHost?: string;
  utm?: { source?: string; medium?: string; campaign?: string };
  /** How the customer said they found the business, if they answered. */
  heardFrom?: HeardFrom;
  /** The time this visit had before the clinic moved it because a doctor's hours changed. */
  clinicMovedFrom?: string | null;
  /** When the customer arrived, the visit started and the visit finished. */
  checkedInAt?: string;
  startedAt?: string;
  completedAt?: string;
  /** Today's token for a customer who is here. Only set while they have one. */
  queue?: QueueTicket;
  /** What the visit costs, in paise. Absent when it has no set price. Staff screens only. */
  priceMinor?: number;
  /** Taken at the desk and given back, in paise. Staff screens only. */
  paidMinor?: number;
  refundedMinor?: number;
  /** Values of the business's own properties, keyed by property id. */
  customFields?: CustomFieldValues;
  /** The repeating series this visit belongs to and its place in it (feature 17). Absent for a single visit. */
  seriesId?: string;
  seriesIndex?: number;
  /** Set once staff reported this booking as spam (feature 44). */
  spamState?: "reported";
  /** For a request waiting for approval: the other times the customer said would work (ISO). Staff screens only. */
  proposedStarts?: string[];
  /** For a declined request: why staff turned it down. Staff screens only. */
  declineReason?: import("./approval").DeclineReason;
  /** Why a booking ended or moved, and who did it (feature 42). Notes are opened for staff screens only. */
  cancelReasonCode?: import("./cancel-policy").CancelReasonCode;
  cancelPresetLabel?: string;
  cancelledBy?: import("./cancel-policy").CancelledBy;
  cancelNote?: string;
  rescheduleNote?: string;
  /** When staff asked the customer to choose a new time. Present while the status is `reschedule_requested`. */
  rescheduleRequestedAt?: string;
  /** The earlier booking this one replaces. */
  rebookedFromId?: string;
}

export interface QueueTicket {
  ticketId: string;
  number: number;
  /** Set while the customer has been called and not yet answered. */
  calledAt?: string;
  callCount: number;
  urgent: boolean;
  /** When they missed a call. They wait behind everyone else until called again. */
  skippedAt?: string;
}

export interface QueueItem {
  id: string;
  kind: QueueKind;
  patientName: string;
  appointmentId?: string;
  primary: string;
  secondary: string;
  countLabel?: string;
}

export interface WaitlistEntry {
  id: string;
  patientId: string;
  serviceId: string;
  locationId: string;
  preferredPractitionerIds: string[];
  dateFrom: string;
  dateTo: string;
  timePreference: "morning" | "afternoon" | "evening" | "any";
  status: "active" | "offered" | "fulfilled" | "expired" | "declined";
  createdAt: string;
}

export interface Recall {
  id: string;
  patientId: string;
  serviceId: string;
  dueAt: string;
  status:
    | "upcoming"
    | "due"
    | "overdue"
    | "contacted"
    | "snoozed"
    | "booked"
    | "closed";
  lastContactedAt?: string;
}

export interface AuditEvent {
  id: string;
  clinicId: string;
  appointmentId?: string;
  actorLabel: string;
  action: string;
  outcome: "success" | "denied" | "failed";
  occurredAt: string;
}

export interface TimeSlot {
  id: string;
  startsAt: string;
  endsAt: string;
  practitionerId: string;
  resourceId?: string;
}

export interface BookingDraft {
  patientType: PatientType;
  bookingFor: "self" | "dependent";
  locationId: string;
  serviceId: string;
  practitionerId: string | "first_available";
  slot?: TimeSlot;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  preferredChannel: ContactChannel;
  accessibilityNeed?: string;
  acceptedPrivacyNotice: boolean;
}
