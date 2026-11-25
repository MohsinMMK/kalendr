import type { BookingPaymentRequired } from "@/lib/payments";
import type { PublicBookingInput } from "@/lib/contracts";
import {
  demoAppointments,
  demoClinic,
  demoLocations,
  demoPractitioners,
  demoServices,
  demoSlots,
} from "@/lib/demo-data";
import type { Appointment, AppointmentStatus, TimeSlot } from "@/lib/domain";
import { ApiError } from "@/server/api-error";
import {
  canTransitionAppointment,
  isManageableAppointment,
} from "@/server/appointment-state";
import type {
  ManageAppointmentAction,
  StaffAppointmentStatusInput,
} from "@/server/contracts";
import { createOpaqueToken } from "@/server/crypto";
import { env } from "@/server/env";

export interface AppointmentMutationResult {
  appointmentId: string;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  version: number;
  /** Today's token number, when this change put the customer in the queue. */
  queueNumber?: number;
  /** A moved booking gets a new manage link (feature 8); the old one stops working. */
  manageToken?: string;
}

export interface BookingCreatedResult {
  appointmentId: string;
  manageToken: string;
  /** Who the booking went to, so an "anyone available" booking can name the person on its confirmation. */
  practitionerId?: string;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  /** Present when the booking is held until it is paid for (feature 23). */
  payment?: BookingPaymentRequired;
}

export interface ManageBookingSnapshot {
  appointment: Appointment & { version: number };
  clinic: typeof demoClinic;
  service: (typeof demoServices)[number];
  practitioner: (typeof demoPractitioners)[number];
  location: (typeof demoLocations)[number];
  canCancel: boolean;
  canReschedule: boolean;
  /** The guest list the customer gave, for editing. */
  guests?: string[];
  /** What the service's cancel and reschedule policy lets this customer do, and the words to show instead of a button (feature 42). */
  manage?: {
    /** On: the page offers only the same person's times when moving the booking. */
    sameStaffOnly: boolean;
    cancelBlockedMessage?: string;
    rescheduleBlockedMessage?: string;
    /** Staff asked the customer to choose a new time; the page opens on the picker. */
    rescheduleRequested?: boolean;
    /** After this the system cancels the booking. */
    rescheduleDeadline?: string;
    /** Everyone who offers this service here, when customers may move to any of them. */
    eligiblePractitioners?: Array<{ id: string; name: string }>;
    /** The guest list may still be changed from the manage link. */
    allowGuestEdit: boolean;
  };
  /** True while a request waits on a service that hides its address: the address and call details are left blank. */
  locationHidden?: boolean;
  /** Why staff declined a request, shown on the manage page with a link to rebook. */
  declineReason?: import("@/lib/approval").DeclineReason;
  /** Times the customer offered with their request (ISO), shown while it waits. */
  proposedStarts?: string[];
}

interface PreviewAppointmentRecord {
  appointment: Appointment;
  version: number;
}

interface PreviewIdempotencyRecord {
  requestHash: string;
  response: BookingCreatedResult;
}

interface PreviewStore {
  appointmentsById: Map<string, PreviewAppointmentRecord>;
  appointmentIdByToken: Map<string, string>;
  idempotency: Map<string, PreviewIdempotencyRecord>;
}

interface PreviewGlobals {
  kalendrPreviewStore?: PreviewStore;
}

const previewGlobals = globalThis as typeof globalThis & PreviewGlobals;

export function isPreviewMode(): boolean {
  // Preview is a development-only fallback when no database is configured.
  // A production process must never serve demo records, even if a stale flag
  // was accidentally left in its environment.
  const settings = env();
  return settings.NODE_ENV !== "production" && !settings.DATABASE_URL && settings.KALENDR_PREVIEW_MODE !== "false";
}

export function listPreviewAvailability(query: {
  locationId: string;
  serviceId: string;
  practitionerId: string;
  from?: string;
  to?: string;
}): TimeSlot[] {
  const service = demoServices.find((entry) => entry.id === query.serviceId);
  if (!service || !service.locationIds.includes(query.locationId)) return [];

  const fromMilliseconds = query.from
    ? new Date(query.from).getTime()
    : Number.NEGATIVE_INFINITY;
  const toMilliseconds = query.to
    ? new Date(query.to).getTime()
    : Number.POSITIVE_INFINITY;
  const store = getPreviewStore();

  return demoSlots.filter((slot) => {
    const slotStart = new Date(slot.startsAt).getTime();
    const practitionerMatches =
      query.practitionerId === "first_available" ||
      slot.practitionerId === query.practitionerId;
    const serviceMatches = service.practitionerIds.includes(slot.practitionerId);
    const isOccupied = [...store.appointmentsById.values()].some(
      ({ appointment }) =>
        appointment.status !== "cancelled" &&
        appointment.status !== "entered_in_error" &&
        appointment.practitionerId === slot.practitionerId &&
        rangesOverlap(
          appointment.startsAt,
          appointment.endsAt,
          slot.startsAt,
          slot.endsAt,
        ),
    );
    return (
      practitionerMatches &&
      serviceMatches &&
      slotStart >= fromMilliseconds &&
      slotStart < toMilliseconds &&
      !isOccupied
    );
  });
}

export function createPreviewAppointment(
  input: PublicBookingInput,
  idempotencyKey: string,
  requestHash: string,
  formStatus: Appointment["formStatus"] = "not_assigned",
): BookingCreatedResult {
  if (input.clinicSlug !== demoClinic.slug) {
    throw new ApiError(404, "clinic_not_found", "Business not found.");
  }

  const store = getPreviewStore();
  const idempotencyStoreKey = `${input.clinicSlug}:${idempotencyKey}`;
  const existing = store.idempotency.get(idempotencyStoreKey);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new ApiError(
        409,
        "idempotency_conflict",
        "That Idempotency-Key was already used for a different request.",
      );
    }
    return existing.response;
  }

  const slot = demoSlots.find(
    (entry) =>
      entry.id === input.slotId &&
      entry.startsAt === input.startsAt &&
      entry.endsAt === input.endsAt,
  );
  const service = demoServices.find((entry) => entry.id === input.serviceId);
  const location = demoLocations.find((entry) => entry.id === input.locationId);
  const practitionerId =
    input.practitionerId === "first_available"
      ? slot?.practitionerId
      : input.practitionerId;

  if (
    !slot ||
    !service ||
    !location ||
    !practitionerId ||
    slot.practitionerId !== practitionerId ||
    !service.locationIds.includes(location.id) ||
    !service.practitionerIds.includes(practitionerId)
  ) {
    throw slotUnavailable();
  }

  const isOccupied = [...store.appointmentsById.values()].some(
    ({ appointment }) =>
      appointment.status !== "cancelled" &&
      appointment.status !== "entered_in_error" &&
      appointment.practitionerId === practitionerId &&
      rangesOverlap(
        appointment.startsAt,
        appointment.endsAt,
        slot.startsAt,
        slot.endsAt,
      ),
  );
  if (isOccupied) throw slotUnavailable();

  const appointmentId = `preview_${createOpaqueToken().slice(0, 18)}`;
  const manageToken = `preview_${createOpaqueToken()}`;
  const status: AppointmentStatus =
    service.bookingMode === "instant" ? "booked" : "requested";
  const appointment: Appointment = {
    id: appointmentId,
    clinicId: demoClinic.id,
    locationId: location.id,
    patientId: `preview_patient_${createOpaqueToken().slice(0, 12)}`,
    practitionerId,
    serviceId: service.id,
    resourceIds: slot.resourceId ? [slot.resourceId] : [],
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    status,
    confirmationStatus: "needs_action",
    bookingSource: input.origin?.channel === "widget" || input.origin?.channel === "iframe" ? input.origin.channel : "online",
    ...(input.reasonForVisit ? { reasonForVisit: input.reasonForVisit } : {}),
    formStatus,
    reminderStatus: "queued",
    manageToken,
  };
  store.appointmentsById.set(appointmentId, { appointment, version: 1 });
  store.appointmentIdByToken.set(manageToken, appointmentId);

  const response = {
    appointmentId,
    manageToken,
    practitionerId,
    status,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
  };
  store.idempotency.set(idempotencyStoreKey, { requestHash, response });
  return response;
}

export function getPreviewManageSnapshot(token: string): ManageBookingSnapshot {
  const record = getPreviewAppointmentByToken(token);
  return buildPreviewSnapshot(record);
}

export function managePreviewAppointment(
  token: string,
  input: ManageAppointmentAction,
): AppointmentMutationResult {
  const store = getPreviewStore();
  const record = getPreviewAppointmentByToken(token);
  if (record.version !== input.expectedVersion) throw versionConflict();

  const appointment = record.appointment;
  if (!isManageableAppointment(appointment.status)) {
    throw new ApiError(
      409,
      "appointment_not_manageable",
      "This appointment can no longer be changed online.",
    );
  }

  if (input.action === "confirm") {
    appointment.confirmationStatus = "confirmed";
  } else if (input.action === "cancel") {
    appointment.status = "cancelled";
    appointment.confirmationStatus = "declined";
  } else {
    const replacementSlot = demoSlots.find(
      (slot) =>
        slot.startsAt === input.startsAt &&
        slot.practitionerId === appointment.practitionerId,
    );
    if (!replacementSlot) throw slotUnavailable();

    const occupied = [...store.appointmentsById.values()].some(
      (candidate) =>
        candidate !== record &&
        candidate.appointment.status !== "cancelled" &&
        candidate.appointment.status !== "entered_in_error" &&
        candidate.appointment.practitionerId === appointment.practitionerId &&
        rangesOverlap(
          candidate.appointment.startsAt,
          candidate.appointment.endsAt,
          replacementSlot.startsAt,
          replacementSlot.endsAt,
        ),
    );
    if (occupied) throw slotUnavailable();
    appointment.startsAt = replacementSlot.startsAt;
    appointment.endsAt = replacementSlot.endsAt;
    appointment.resourceIds = replacementSlot.resourceId
      ? [replacementSlot.resourceId]
      : [];
  }

  record.version += 1;
  return mutationResult(record);
}

export function updatePreviewAppointmentStatus(
  appointmentId: string,
  input: StaffAppointmentStatusInput,
): AppointmentMutationResult {
  const record = getPreviewStore().appointmentsById.get(appointmentId);
  if (!record) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
  if (record.version !== input.expectedVersion) throw versionConflict();
  if (!canTransitionAppointment(record.appointment.status, input.status)) {
    throw new ApiError(
      409,
      "invalid_status_transition",
      "That appointment status change is not allowed.",
    );
  }
  record.appointment.status = input.status;
  record.version += 1;
  return mutationResult(record);
}

export function resetPreviewStoreForTests(): void {
  previewGlobals.kalendrPreviewStore = createPreviewStore();
}

function getPreviewStore(): PreviewStore {
  previewGlobals.kalendrPreviewStore ??= createPreviewStore();
  return previewGlobals.kalendrPreviewStore;
}

function createPreviewStore(): PreviewStore {
  const appointmentsById = new Map<string, PreviewAppointmentRecord>();
  const appointmentIdByToken = new Map<string, string>();
  for (const appointment of demoAppointments) {
    const clonedAppointment = { ...appointment, resourceIds: [...appointment.resourceIds] };
    appointmentsById.set(appointment.id, {
      appointment: clonedAppointment,
      version: 1,
    });
    appointmentIdByToken.set(appointment.manageToken, appointment.id);
  }
  return { appointmentsById, appointmentIdByToken, idempotency: new Map() };
}

/** The preview appointment behind a manage link, for the review form. */
export function getPreviewAppointmentForReview(token: string): Appointment {
  return getPreviewAppointmentByToken(token).appointment;
}

function getPreviewAppointmentByToken(token: string): PreviewAppointmentRecord {
  const store = getPreviewStore();
  const appointmentId = store.appointmentIdByToken.get(token);
  const record = appointmentId
    ? store.appointmentsById.get(appointmentId)
    : undefined;
  if (!record) {
    throw new ApiError(404, "appointment_not_found", "Appointment not found.");
  }
  return record;
}

function buildPreviewSnapshot(
  record: PreviewAppointmentRecord,
): ManageBookingSnapshot {
  const { appointment } = record;
  const service = demoServices.find((entry) => entry.id === appointment.serviceId);
  const practitioner = demoPractitioners.find(
    (entry) => entry.id === appointment.practitionerId,
  );
  const location = demoLocations.find((entry) => entry.id === appointment.locationId);
  if (!service || !practitioner || !location) {
    throw new ApiError(404, "appointment_not_found", "Appointment not found.");
  }
  const manageable = isManageableAppointment(appointment.status);
  return {
    appointment: {
      ...appointment,
      resourceIds: [...appointment.resourceIds],
      version: record.version,
    },
    clinic: demoClinic,
    service,
    practitioner,
    location,
    canCancel: manageable,
    canReschedule: manageable,
  };
}

function mutationResult(record: PreviewAppointmentRecord): AppointmentMutationResult {
  return {
    appointmentId: record.appointment.id,
    status: record.appointment.status,
    startsAt: record.appointment.startsAt,
    endsAt: record.appointment.endsAt,
    version: record.version,
  };
}

function rangesOverlap(
  firstStart: string,
  firstEnd: string,
  secondStart: string,
  secondEnd: string,
): boolean {
  return (
    new Date(firstStart).getTime() < new Date(secondEnd).getTime() &&
    new Date(secondStart).getTime() < new Date(firstEnd).getTime()
  );
}

function slotUnavailable(): ApiError {
  return new ApiError(
    409,
    "slot_unavailable",
    "That time is no longer available. Please choose another slot.",
  );
}

function versionConflict(): ApiError {
  return new ApiError(
    409,
    "version_conflict",
    "This appointment changed since you opened it. Refresh and try again.",
  );
}
