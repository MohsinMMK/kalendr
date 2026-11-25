import type { RatingSummaries } from "@/lib/reviews";
import type { PublicFormDefinition } from "@/lib/booking-forms";
import type { BookingGuide } from "@/lib/booking-guide";
import type { ClinicSetupState } from "@/lib/clinic-setup";
import type { BusinessProfile } from "@/lib/terminology";
import type { Permission, PermissionOverrides, StaffRole } from "@/lib/permissions";
import type {
  Appointment,
  Clinic,
  ContactChannel,
  Location,
  Patient,
  Practitioner,
  Recall,
  Resource,
  Service,
  TimeSlot,
  WaitlistEntry,
} from "@/lib/domain";

export interface ClinicCatalog {
  clinic: Clinic;
  /** The business's resolved words and features. Derived from `clinic`; never trusted from the browser. */
  profile: BusinessProfile;
  locations: Location[];
  services: Service[];
  practitioners: Practitioner[];
  resources: Resource[];
  initialSlots: TimeSlot[];
  preview: boolean;
  /** The switched-on booking forms, newest first. Only the public booking page loads them. */
  forms?: PublicFormDefinition[];
  /** Published review ratings. Only the public pages load them. */
  ratings?: RatingSummaries;
  /** The switched-on "help me choose" questions, limited to services that can be booked. Only the public pages load them. */
  guide?: BookingGuide | null;
}

export interface StaffAppointment extends Omit<Appointment, "manageToken"> {
  version: number;
}

export interface StaffSnapshotLimits {
  appointmentsTruncated: boolean;
  patientsTruncated: boolean;
  waitlistTruncated: boolean;
  recallsTruncated: boolean;
  appointmentWindow: string;
}

export interface StaffTeamMember {
  membershipId: string;
  userId: string;
  email: string;
  name: string;
  role: StaffRole;
  isActive: boolean;
  practitionerId: string | null;
  /** Only the switches that differ from the role's preset. */
  permissionOverrides: PermissionOverrides;
  permissions: Permission[];
  /** The custom role this person has, if any (feature 53). Their permissions come from it instead of the role's preset. */
  customRoleId?: string | null;
  customRoleName?: string | null;
  /** What this person is called in the business ("Senior stylist"). Optional; it never changes their access. */
  jobTitle?: string | null;
  /** They were invited and have neither set a password nor signed in some other way yet. */
  invitePending: boolean;
  invitedAt: string | null;
  /** When they last signed in, by any route. Null means never. Absent in preview data. */
  lastSignInAt?: string | null;
  /** Whether they use an authenticator app or a passkey. Absent in preview data. */
  secondFactor?: boolean;
  /** When the invite link they were sent stops working; null when no link is on record. Only set while the invite is pending. */
  inviteExpiresAt?: string | null;
  /** The locations this person is limited to; empty or absent means every location. */
  locationIds?: string[];
  /** They also work in another business with this same login. Only that: the other business is never named. Then their sign-in (email, password link) is theirs to change. */
  worksElsewhere?: boolean;
}

export interface StaffAvailabilityRule {
  practitionerId: string;
  dayOfWeek: number;
  startsAtLocal: string;
  endsAtLocal: string;
}

export interface StaffScheduleBlock {
  id: string;
  practitionerId: string | null;
  locationId: string | null;
  startsAt: string;
  endsAt: string;
  reason: string;
}

export interface StaffMessage {
  id: string;
  appointmentId: string | null;
  patientId: string | null;
  channel: ContactChannel;
  templateKey: string;
  /** "recorded": local capture only, nobody was contacted. "sent": handed to the provider, no delivery report yet. */
  status: "queued" | "recorded" | "sent" | "delivered" | "failed" | "cancelled";
  /** Why it failed or was not sent, as a short code. */
  failureCode?: string | null;
  createdAt: string;
}

export interface StaffSnapshot {
  catalog: ClinicCatalog;
  patients: Patient[];
  appointments: StaffAppointment[];
  waitlist: WaitlistEntry[];
  recalls: Recall[];
  team: StaffTeamMember[];
  availability: StaffAvailabilityRule[];
  scheduleBlocks: StaffScheduleBlock[];
  messages: StaffMessage[];
  setup: ClinicSetupState;
  fetchedAt: string;
  historicalNames: {
    services: Record<string, string>;
    practitioners: Record<string, string>;
    locations: Record<string, string>;
  };
  limits: StaffSnapshotLimits;
}

export function toWorkspaceAppointment(appointment: StaffAppointment): Appointment {
  return { ...appointment, manageToken: "" };
}
