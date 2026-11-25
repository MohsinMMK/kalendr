import type { PublicFormDefinition } from "@/lib/booking-forms";
import type { DeclineReason } from "@/lib/approval";
import type { BookingOriginInput } from "@/lib/contracts";
import type {
  Appointment,
  Clinic,
  Location,
  Practitioner,
  Resource,
  Service,
  TimeSlot,
} from "@/lib/domain";

export interface BookingFlowProps {
  clinic: Clinic;
  locations: Location[];
  services: Service[];
  practitioners: Practitioner[];
  resources: Resource[];
  initialSlots: TimeSlot[];
  allowDemoFallback?: boolean;
  /** How the patient reached this page: the booking page, the website button or an embedded iframe. */
  origin?: BookingOriginInput;
  /** A service to choose up front, from the `service` link parameter. Ignored unless it is an active service. */
  initialServiceId?: string;
  /** A team member to book with, from the `person` link parameter. Ignored unless they take online bookings for that service. */
  initialPersonId?: string;
  /** A day to open the calendar on ("YYYY-MM-DD"), from the `date` link parameter. Ignored when it has no free times. */
  initialDate?: string;
  /** A time to choose up front (an ISO start time), from the `time` link parameter. Ignored unless that time is still free. */
  initialTime?: string;
  /** The business's own booking questions; the one for the chosen service is asked with the contact details. */
  forms?: PublicFormDefinition[];
  /** How this page was reached when it is a special link (feature 45): a one-off token, or a combined link's address. */
  linkContext?: { kind: "special"; token: string } | { kind: "combined"; slug: string } | { kind: "routing"; token: string };
  /** Turnstile's public key when the bot check is on. The check shows only if the server asks for it. */
  turnstileSiteKey?: string | null;
  /**
   * The booking link's query as plain strings. Question link names and the built-ins `name`, `email`, `phone`,
   * `notes`, `guests` and `location` fill the form; each value is checked and a bad one is ignored.
   */
  prefill?: Record<string, string | undefined>;
}

export interface BookingSuccess {
  appointmentId: string;
  manageToken: string;
  status: Extract<Appointment["status"], "requested" | "booked">;
  startsAt: string;
  endsAt: string;
  /** Who the booking went to; an "anyone available" slot doesn't say until the server picks. */
  practitionerId?: string;
  previewMode: boolean;
}

export interface PublicApiError {
  code: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
}

export interface ManageAppointment extends Appointment {
  version: number;
}

export interface ManageBookingSnapshot {
  appointment: ManageAppointment;
  clinic: Clinic;
  service: Service;
  practitioner: Practitioner;
  location: Location;
  canCancel: boolean;
  canReschedule: boolean;
  /** What the service's cancel and reschedule policy lets this customer do (feature 42). Absent (preview) means everything. */
  manage?: ManagePolicyView;
  /** The guest emails now on the booking, so the guest card can start from them. */
  guests?: string[];
  /** True while a request waits on a service that hides its address: the address and call details are blank. */
  locationHidden?: boolean;
  /** Why staff declined the request (status `declined`). */
  declineReason?: DeclineReason;
  /** Other times the customer offered with their request (ISO), while it waits. */
  proposedStarts?: string[];
}

export interface ManagePolicyView {
  sameStaffOnly: boolean;
  cancelBlockedMessage?: string;
  rescheduleBlockedMessage?: string;
  rescheduleRequested?: boolean;
  /** ISO. After this the booking is cancelled. */
  rescheduleDeadline?: string;
  allowGuestEdit: boolean;
  /** When `sameStaffOnly` is false: everyone who offers the service here, for naming other people's times. */
  eligiblePractitioners?: { id: string; name: string }[];
}

export type ManageAction = "confirm" | "cancel" | "reschedule" | "edit_guests";

export interface ManageActionResult {
  appointmentId: string;
  status: Appointment["status"];
  startsAt: string;
  endsAt: string;
  version: number;
}
