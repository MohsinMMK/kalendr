import { createHash, randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { getDatabase, withTenant, type KalendrTransaction } from "@/db/client";
import {
  appointments,
  auditEvents,
  idempotencyKeys,
  outboxEvents,
  patients,
  resourceReservations,
} from "@/db/schema";
import { joinFullName } from "@/features/booking/full-name";
import type { PublicBookingInput } from "@/lib/contracts";
import type {
  Appointment,
  AppointmentStatus,
  Clinic,
  Location,
  Practitioner,
  Service,
  TimeSlot,
} from "@/lib/domain";
import { resolveCombinedLink, spendSpecialLink } from "@/server/special-links-core";
import { assertNotBlocked } from "@/server/customers/block";
import { findBlockMatch, recordSilentRefusal, SilentRefusal } from "@/server/spam-check";
import { ApiError, getPostgresErrorCode, mapDatabaseError } from "@/server/api-error";
import { loadBusinessProfileIn, loadStaffBusinessProfile, previewBusinessClinic, profileFromRow, publicProfileFields } from "@/server/business-profile";
import { inPreviewWords } from "@/lib/preview-sample";
import { profileWords } from "@/lib/terminology";
import type { ResourceKind } from "@/lib/business-types";
import type { HeardFrom } from "@/lib/heard-from";
import { REVIEW_REQUEST_DELAY_MS } from "@/lib/reviews";
import {
  canTransitionAppointment,
  isManageableAppointment,
} from "@/server/appointment-state";
import type {
  AvailabilityQuery,
  ManageAppointmentAction,
  CoreStaffAppointmentMutation,
  StaffAppointmentStatusInput,
  StaffBookingInput,
} from "@/server/contracts";
import { resizeMinutes, staffBookingSources } from "@/server/contracts";
import { isEmptyFieldValue, parseCustomFieldValues, type CustomFieldValues } from "@/lib/visit-fields";
import { rotateManageToken } from "./manage-token";
import { approveRequestIn } from "@/server/approval";
import { customerCancelDecision, customerRescheduleDecision, policyMessage } from "@/lib/cancel-policy";
import { assertCustomerMay, loadCancelPolicy, prepareGuestEdit, sealNote } from "@/server/booking-policy";
import { isDeclineReason } from "@/lib/approval";
import { approvalRules, decideApproval, MAX_PROPOSED_TIMES } from "@/lib/approval";
import { createOpaqueToken, sha256 } from "@/server/crypto";
import { openPrivate, sealManageToken } from "@/server/messaging/sealed-link";
import { loadMediaUrlsIn } from "@/server/media";
import { checkPreviewBookingForm, prepareBookingFormIn, storeFormResponseIn, storePreviewFormResponse } from "@/server/booking-forms";
import { assertLocationAllowed, assertLocationVisible } from "@/server/location-scope";
import { requirePermission, type StaffContext } from "@/server/staff-context";
import { resolveLocationChoice } from "@/server/booking-location";
import { prepareBookingIntake, sealGuests } from "@/server/booking-intake";
import { assertCustomerCap, CustomerCapError } from "@/server/customer-cap";
import { assertBookingAllowed } from "@/server/billing/enforcement";
import { assertSlotOfferable } from "@/server/slot-engine/commit";
import { assertOfferableOrOverride } from "@/server/soft-rule-override";
import { findOwnHold, hashHoldToken } from "@/server/slot-holds";
import { ANYONE, chooseAssignee } from "@/server/routing";
import { assertPersonAllowed, linkRoutingBooking, markSlotsShown, resolveRoutingToken } from "@/server/routing-forms/trace";
import { loadSlotInput } from "@/server/slot-engine/load";
import { analyseSlots } from "@/server/slot-engine/offerable-slots";
import { issueQueueTicket } from "@/server/queue";
import { notifyStaff } from "@/server/staff-notifications";
import { currentTraceParent } from "@/server/tracing";
import { assertTenantNotPaused } from "@/server/tenant-pause";
import {
  createPreviewAppointment,
  getPreviewManageSnapshot,
  isPreviewMode,
  listPreviewAvailability,
  managePreviewAppointment,
  updatePreviewAppointmentStatus,
  type AppointmentMutationResult,
  type BookingCreatedResult,
  type ManageBookingSnapshot,
} from "@/server/preview-repository";
import { planAppointment } from "./workflows/engine";
import { deliveryModeForKind } from "./video/rules";
import { drizzleRunner } from "./workflows/runner";
import { offerFreedSlot } from "./waitlist-hook";
import { prepareBookingOffers, releaseBookingOffers } from "./offers/booking-offers";
import { quoteService, storedPayment } from "./payments/quote";
import { applyPaymentPolicy, policyEventFor } from "./payments/cancellation";
import { PAYMENT_HOLD_MINUTES } from "@/lib/payments";
import { applyFormMessagingConsentIn } from "./privacy/consent";

interface ResolvedTenantRow extends Record<string, unknown> {
  tenant_id: string;
  slug: string;
  name: string;
  legal_name: string;
  phone: string;
  email: string;
  timezone: string;
  locale: string;
}

interface ResolvedAppointmentRow extends Record<string, unknown> {
  tenant_id: string;
  appointment_id: string;
}

export interface BookingConfigurationRow extends Record<string, unknown> {
  service_id: string;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  minimum_lead_minutes: number;
  maximum_advance_days: number;
  booking_mode: "instant" | "request";
  approval_rule: string;
  approval_notice_hours: number;
  requests_hold_slot: boolean;
  hide_location_until_confirmed: boolean;
  required_resource_kind: ResourceKind | null;
  practitioner_id: string;
  location_timezone: string;
}

interface AppointmentDetailsRow extends Record<string, unknown> {
  id: string;
  payment_terms?: Record<string, unknown> | null;
  payment_terms_text?: string | null;
  tenant_id: string;
  location_id: string;
  patient_id: string;
  practitioner_id: string;
  service_id: string;
  starts_at: Date | string;
  ends_at: Date | string;
  status: AppointmentStatus;
  confirmation_status: Appointment["confirmationStatus"];
  booking_source: Appointment["bookingSource"];
  form_status: Appointment["formStatus"];
  reminder_status: Appointment["reminderStatus"];
  version: number;
  clinic_slug: string;
  clinic_name: string;
  clinic_legal_name: string;
  clinic_phone: string;
  clinic_email: string;
  clinic_timezone: string;
  clinic_locale: string;
  clinic_business_type: string;
  clinic_terminology: unknown;
  clinic_features: unknown;
  location_name: string;
  location_address: string;
  location_city: string;
  location_timezone: string;
  location_accessible_entrance: boolean;
  service_name: string;
  service_description: string;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  service_booking_mode: Service["bookingMode"];
  hide_location_until_confirmed: boolean;
  allow_guests: boolean;
  max_guests: number;
  decline_reason_code: string | null;
  guest_emails_ciphertext: string | null;
  reschedule_requested_at: Date | string | null;
  /** The offered times as JSON, because the driver returns a raw timestamptz[] as text. */
  proposed_json: string[] | null;
  patient_types: Service["patientTypes"];
  required_resource_kind: Service["resourceKind"] | null;
  price_label: string | null;
  practitioner_name: string;
  practitioner_title: string;
  practitioner_initials: string;
  practitioner_specialty: string;
}

const BOOKING_ROUTE = "/api/public/appointments";
const STAFF_BOOKING_ROUTE = "/api/staff/appointments";

export interface StaffBookingCreatedResult extends AppointmentMutationResult {
  patientId: string;
  /** Lets the patient change or cancel online. Only returned once, so staff can share it. */
  manageToken: string;
}

/** The openings, and who is away in the range with the note and cover to show on the booking page. */
export interface AvailabilityListing {
  slots: TimeSlot[];
  outOfOffice: Array<{ practitionerId: string; startsAt: string; endsAt: string; note: string | null; coverPractitionerId: string | null }>;
  /** Days (`YYYY-MM-DD` in the business's timezone) a booking limit filled, so the page can say "full" instead of "closed". */
  fullDays: string[];
  /** For an "anyone" listing: each person's next free time in the range, so the page can say when each could see them (feature 20). */
  nextByPerson?: Record<string, string>;
}

export async function listAvailability(
  query: AvailabilityQuery,
  options: { walkIn?: boolean } = {},
): Promise<TimeSlot[]> {
  return (await listAvailabilityDetailed(query, options)).slots;
}

export async function listAvailabilityDetailed(
  query: AvailabilityQuery,
  options: { walkIn?: boolean } = {},
): Promise<AvailabilityListing> {
  const pooled = query.practitionerId === ANYONE;
  if (isPreviewMode()) return { slots: await listPreviewAvailability(pooled ? { ...query, practitionerId: "first_available" } : query), outOfOffice: [], fullDays: [] };
  const database = getDatabase();
  if (!database) throw databaseUnavailable();

  const tenant = await resolveTenant(query.clinicSlug);
  if (!tenant) throw new ApiError(404, "clinic_not_found", "Business not found.");

  const from = query.from ? new Date(query.from) : new Date();
  const to = query.to
    ? new Date(query.to)
    : new Date(from.getTime() + 14 * 24 * 60 * 60 * 1_000);

  return database.transaction(async (transaction) => {
    await setTenant(transaction, tenant.tenant_id);
    // The visitor's own hold does not hide its time from them.
    const own = query.holdToken
      ? (await transaction.execute<{ id: string }>(sql`select id from slot_holds where tenant_id = ${tenant.tenant_id} and token_hash = ${hashHoldToken(query.holdToken)} and expires_at > now()`))[0]
      : undefined;
    const loaded = await loadSlotInput(transaction, {
      tenantId: tenant.tenant_id,
      locationId: query.locationId,
      serviceId: query.serviceId,
      ...(own ? { ignoreHoldId: own.id } : {}),
      ...(query.durationMinutes ? { durationMinutes: query.durationMinutes } : {}),
      // "Anyone" is everyone who offers the service here; the person is chosen when the booking is made.
      practitionerId: pooled ? "first_available" : query.practitionerId,
      from,
      to,
      mode: options.walkIn === true ? "walk_in" : "standard",
    });
    if (!loaded) return { slots: [], outOfOffice: [], fullDays: [] };
    if (query.durationMinutes && !query.keepLength && !loaded.lengths.some((length) => length.minutes === query.durationMinutes)) {
      throw new ApiError(400, "validation_error", "This service is not offered for that length of time.", {
        durationMinutes: ["Choose one of the lengths this service offers."],
      });
    }
    const analysis = analyseSlots(loaded.input);
    // Feature 46: a customer sent here by a routing form is only shown times for the people the form picked.
    if (query.routingToken) {
      const grant = await resolveRoutingToken(transaction, tenant.tenant_id, query.routingToken, query.serviceId);
      const allowed = new Set(grant.candidateIds);
      if (!pooled) assertPersonAllowed(grant, query.practitionerId);
      analysis.slots = analysis.slots.filter((slot) => allowed.has(slot.practitionerId));
      if (analysis.slots.length > 0) await markSlotsShown(transaction, tenant.tenant_id, grant);
    }
    if (pooled) return pooledListing(analysis);
    const slots = analysis.slots.slice(0, 500).map((slot) => ({
      id: slotId(slot.practitionerId, slot.startsAt, slot.resourceId),
      startsAt: slot.startsAt.toISOString(),
      endsAt: slot.endsAt.toISOString(),
      practitionerId: slot.practitionerId,
      ...(slot.resourceId ? { resourceId: slot.resourceId } : {}),
    }));
    return { slots, outOfOffice: loaded.outOfOffice, fullDays: analysis.fullDays };
  });
}

/** A time is offered once when at least one person is free for it, and each person's next free time is kept (feature 20). */
function pooledListing(analysis: ReturnType<typeof analyseSlots>): AvailabilityListing {
  const seen = new Set<number>();
  const slots: TimeSlot[] = [];
  const nextByPerson: Record<string, string> = {};
  for (const slot of analysis.slots) {
    const start = slot.startsAt.getTime();
    if (!(slot.practitionerId in nextByPerson)) nextByPerson[slot.practitionerId] = slot.startsAt.toISOString();
    if (seen.has(start) || slots.length >= 500) continue;
    seen.add(start);
    slots.push({ id: slotId(ANYONE, slot.startsAt, null), startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(), practitionerId: ANYONE });
  }
  return { slots, outOfOffice: [], fullDays: analysis.fullDays, nextByPerson };
}

function slotId(practitionerId: string, startsAt: Date, resourceId: string | null): string {
  return `slot_${createHash("md5").update(`${practitionerId}:${startsAt.toISOString()}:${resourceId ?? ""}`).digest("hex")}`;
}

/** How a booking reached the public form beyond the usual: a special link's token (feature 45) or a combined link's slug. */
export interface BookingLinkContext {
  specialLinkToken?: string;
  combinedSlug?: string;
  /** Set by server code, never from a request body: the booking assistant (feature 30) books with source `assistant`. */
  source?: "assistant";
  /** From a routing form (feature 46). The people who may be offered are read from the server's own row, never the request. */
  routingToken?: string;
}

export async function createAppointment(
  input: PublicBookingInput,
  idempotencyKey: string,
  requestHash: string,
  link: BookingLinkContext = {},
): Promise<BookingCreatedResult> {
  if (isPreviewMode()) {
    const prepared = checkPreviewBookingForm(input.serviceId, input.formAnswers);
    const created = createPreviewAppointment(input, idempotencyKey, requestHash, prepared ? "submitted" : "not_assigned");
    if (prepared) storePreviewFormResponse(created.appointmentId, prepared);
    return created;
  }
  const database = getDatabase();
  if (!database) throw databaseUnavailable();
  const tenant = await resolveTenant(input.clinicSlug);
  if (!tenant) throw new ApiError(404, "clinic_not_found", "Business not found.");
  // The public booking path only (staff book through createStaffAppointment): a paused business (feature 15) takes none.
  await assertTenantNotPaused(tenant.tenant_id);

  // Two customers taking the same "anyone" time queue on the people's rows; the one who waited re-reads and gets the next person.
  const anyone = input.practitionerId === ANYONE;
  const attempts = anyone ? 8 : 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await database.transaction(
        async (transaction) => {
          await setTenant(transaction, tenant.tenant_id);
          return link.combinedSlug
            ? createCombinedTransaction(transaction, tenant.tenant_id, input, idempotencyKey, requestHash, link.combinedSlug)
            : createAppointmentTransaction(transaction, tenant.tenant_id, input, idempotencyKey, requestHash, { ...(link.specialLinkToken ? { specialLinkToken: link.specialLinkToken } : {}), ...(link.source ? { source: link.source } : {}), ...(link.routingToken ? { routingToken: link.routingToken } : {}) });
        },
        { isolationLevel: "serializable" },
      );
    } catch (error) {
      const code = getPostgresErrorCode(error);
      if ((code === "40001" || code === "40P01" || (anyone && code === "23P01")) && attempt < attempts - 1) {
        continue;
      }
      if (error instanceof SilentRefusal) {
        // Feature 44: the booking was rolled back; the customer still gets the confirmation a real booking would.
        await recordSilentRefusal(tenant.tenant_id, error, { route: BOOKING_ROUTE, key: idempotencyKey, requestHash });
        return error.response as unknown as BookingCreatedResult;
      }
      if (error instanceof CustomerCapError && error.resendAppointmentId) {
        // The refusal rolled the booking back, so the message is queued on its own, to the contact already on file.
        await queueRescheduleLink(tenant.tenant_id, error.resendAppointmentId);
      }
      const mapped = mapDatabaseError(error);
      throw mapped ?? error;
    }
  }
  throw databaseUnavailable();
}

/** Sends the customer their existing booking's link again, so they can move it. At most once an hour per booking. */
async function queueRescheduleLink(tenantId: string, appointmentId: string): Promise<void> {
  await withTenant(tenantId, async (transaction) => {
    const [row] = await transaction.select({ version: appointments.version }).from(appointments)
      .where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, appointmentId))).limit(1);
    if (!row) return;
    await transaction.insert(outboxEvents).values({
      tenantId,
      aggregateType: "appointment",
      aggregateId: appointmentId,
      eventType: "appointment.created",
      payload: { appointmentId, version: row.version },
      dedupeKey: `appointment.reschedule_offer:${appointmentId}:${row.version}:${Math.floor(Date.now() / 3_600_000)}`,
      traceParent: currentTraceParent(),
    }).onConflictDoNothing();
  });
}

export async function createStaffAppointment(
  context: StaffContext,
  input: StaffBookingInput,
  idempotencyKey: string,
  requestHash: string,
): Promise<StaffBookingCreatedResult> {
  if (context.clinicSlug !== input.clinicSlug || (!context.userId && !context.apiKeyId)) {
    const t = profileWords(await loadStaffBusinessProfile(context));
    throw new ApiError(403, "forbidden", `This ${t.business} role cannot create ${t.appointments}.`);
  }
  requirePermission(context, "appointments.book");
  assertLocationAllowed(context, input.locationId);
  if (context.preview) throw databaseUnavailable();
  const database = getDatabase();
  if (!database) throw databaseUnavailable();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await database.transaction(async (transaction) => {
        await setTenant(transaction, context.tenantId);
        return createStaffAppointmentTransaction(
          transaction,
          context,
          input,
          idempotencyKey,
          requestHash,
        );
      }, { isolationLevel: "serializable" });
    } catch (error) {
      const code = getPostgresErrorCode(error);
      if ((code === "40001" || code === "40P01") && attempt < 2) continue;
      throw mapDatabaseError(error) ?? error;
    }
  }
  throw databaseUnavailable();
}

export async function getManageSnapshot(
  token: string,
): Promise<ManageBookingSnapshot> {
  if (isPreviewMode()) return inPreviewWords(getPreviewManageSnapshot(token), await previewBusinessClinic());
  const resolved = await resolveManageToken(token);
  if (!resolved) {
    throw new ApiError(404, "appointment_not_found", "Appointment not found.");
  }
  return getDatabaseManageSnapshot(token, resolved);
}

export async function manageAppointment(
  token: string,
  input: ManageAppointmentAction,
): Promise<AppointmentMutationResult> {
  if (isPreviewMode()) return managePreviewAppointment(token, input);
  const resolved = await resolveManageToken(token);
  if (!resolved) {
    throw new ApiError(404, "appointment_not_found", "Appointment not found.");
  }
  return applyPatientAction(resolved, input);
}

/**
 * Saves how the customer found the business. Only the first answer counts, so a shared link
 * can't keep changing it; a later answer is accepted quietly and ignored.
 */
export async function recordHeardFrom(token: string, heardFrom: HeardFrom): Promise<{ saved: boolean }> {
  if (isPreviewMode()) return { saved: false };
  const resolved = await resolveManageToken(token);
  if (!resolved) {
    throw new ApiError(404, "appointment_not_found", "Appointment not found.");
  }
  const database = getDatabase();
  if (!database) throw databaseUnavailable();
  return database.transaction(async (transaction) => {
    await setTenant(transaction, resolved.tenant_id);
    const rows = await transaction.execute<{ id: string }>(sql`
      update appointments set heard_from = ${heardFrom}
      where tenant_id = ${resolved.tenant_id}
        and id = ${resolved.appointment_id}
        and heard_from is null
      returning id
    `);
    return { saved: rows.length > 0 };
  });
}

/** The signed-in portal's view of one visit. The caller has already proved the visit belongs to this account. */
export async function getPortalManageSnapshot(tenantId: string, appointmentId: string): Promise<ManageBookingSnapshot> {
  return getDatabaseManageSnapshot("", { tenant_id: tenantId, appointment_id: appointmentId });
}

export async function managePortalAppointment(
  tenantId: string,
  appointmentId: string,
  input: ManageAppointmentAction,
  accountId: string,
): Promise<AppointmentMutationResult> {
  return applyPatientAction({ tenant_id: tenantId, appointment_id: appointmentId }, input, accountId);
}

/**
 * The booking assistant's change (feature 30), after the customer proved their phone with a code and confirmed the exact change.
 * It runs the same cancel and move rules as the manage link (the business's windows, the waitlist, the messages), with no portal account.
 */
export async function manageAssistantAppointment(
  tenantId: string,
  appointmentId: string,
  input: ManageAppointmentAction,
): Promise<AppointmentMutationResult> {
  return applyPatientAction({ tenant_id: tenantId, appointment_id: appointmentId }, input);
}

/**
 * A patient's change runs serializable. Two people changing bookings in one business at the same moment can make the
 * database ask one of them to start again (the waitlist offer made inside a cancel reads the same waiting list), so the
 * change is tried up to three times, like a staff move.
 */
async function applyPatientAction(
  resolved: ResolvedAppointmentRow,
  input: ManageAppointmentAction,
  accountId?: string,
): Promise<AppointmentMutationResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await applyPatientActionOnce(resolved, input, accountId);
    } catch (error) {
      const code = getPostgresErrorCode(error) ?? (error instanceof ApiError && error.code === "temporarily_unavailable" ? "40001" : undefined);
      if ((code === "40001" || code === "40P01") && attempt < 2) continue;
      throw error;
    }
  }
}

async function applyPatientActionOnce(
  resolved: ResolvedAppointmentRow,
  input: ManageAppointmentAction,
  accountId?: string,
): Promise<AppointmentMutationResult> {
  const database = getDatabase();
  if (!database) throw databaseUnavailable();

  try {
    return await database.transaction(
      async (transaction) => {
        await setTenant(transaction, resolved.tenant_id);
        const currentRows = await transaction.execute<{
          id: string;
          status: AppointmentStatus;
          confirmation_status: Appointment["confirmationStatus"];
          starts_at: Date | string;
          ends_at: Date | string;
          version: number;
          location_id: string;
          practitioner_id: string;
          service_id: string;
        }>(sql`
          select
            appointment.id,
            appointment.status,
            appointment.confirmation_status,
            appointment.starts_at,
            appointment.ends_at,
            appointment.version,
            appointment.location_id,
            appointment.practitioner_id,
            appointment.service_id
          from appointments as appointment
          where appointment.tenant_id = ${resolved.tenant_id}
            and appointment.id = ${resolved.appointment_id}
          for update of appointment
        `);
        const current = currentRows[0];
        if (!current) {
          throw new ApiError(404, "appointment_not_found", "Appointment not found.");
        }
        if (current.version !== input.expectedVersion) throw versionConflict();
        if (!isManageableAppointment(current.status)) {
          throw new ApiError(
            409,
            "appointment_not_manageable",
            "This appointment can no longer be changed online.",
          );
        }

        let startsAt = new Date(current.starts_at);
        let endsAt = new Date(current.ends_at);
        let nextStatus: AppointmentStatus = current.status;
        // The business's cancel and reschedule rules (feature 42). A booking staff asked to move is held to none of them.
        const staffAskedToMove = current.status === "reschedule_requested";
        const policy = await loadCancelPolicy(transaction, resolved.tenant_id, current.service_id);
        let practitionerId = current.practitioner_id;
        let cancelFields: Partial<typeof appointments.$inferInsert> = {};
        let guestsCiphertext: string | null | undefined;
        if (input.action === "confirm" && staffAskedToMove) {
          throw new ApiError(409, "reschedule_requested", "Choose a new time for this booking first.");
        }
        if (input.action === "edit_guests") {
          if (!staffAskedToMove) await assertCustomerMay(transaction, { tenantId: resolved.tenant_id, action: "reschedule", policy, startsAt });
          guestsCiphertext = await prepareGuestEdit(transaction, resolved.tenant_id, current.service_id, current.id, input.guests ?? []);
        }
        if (input.action === "cancel") {
          if (!staffAskedToMove) await assertCustomerMay(transaction, { tenantId: resolved.tenant_id, action: "cancel", policy, startsAt });
          cancelFields = {
            cancelReasonCode: input.reasonCode ?? "other",
            cancelledBy: "customer",
            cancelReasonText: sealNote("cancel", resolved.tenant_id, current.id, input.note ?? input.reason),
            rescheduleRequestedAt: null,
          };
          nextStatus = "cancelled";
          await transaction
            .update(resourceReservations)
            .set({ state: "released", updatedAt: new Date() })
            .where(
              and(
                eq(resourceReservations.tenantId, resolved.tenant_id),
                eq(resourceReservations.appointmentId, current.id),
              ),
            );
        } else if (input.action === "reschedule") {
          if (!staffAskedToMove) await assertCustomerMay(transaction, { tenantId: resolved.tenant_id, action: "reschedule", policy, startsAt });
          if (input.practitionerId && input.practitionerId !== current.practitioner_id) {
            // Another person's time, only where the service lets customers move to anyone (feature 42).
            if (policy.rescheduleSamePerson) {
              throw new ApiError(403, "reschedule_same_person", "This booking can only move to another time with the same person.");
            }
            practitionerId = input.practitionerId;
          }
          const configuration = await loadBookingConfiguration(
            transaction,
            resolved.tenant_id,
            current.location_id,
            current.service_id,
            practitionerId,
          );
          if (!configuration) throw slotUnavailable();
          if (staffAskedToMove) nextStatus = "booked";
          startsAt = new Date(input.startsAt!);
          // The visit keeps the length it was booked for, even if the service has other lengths now.
          endsAt = new Date(startsAt.getTime() + (new Date(current.ends_at).getTime() - new Date(current.starts_at).getTime()));
          const slot = await assertSlotOfferable(transaction, {
            tenantId: resolved.tenant_id,
            locationId: current.location_id,
            serviceId: current.service_id,
            practitionerId,
            startsAt,
            endsAt,
            mode: "standard",
            excludeAppointmentId: current.id,
            keepExistingLength: true,
          });
          const selectedResourceId = slot.resourceId;
          await replaceReservations(
            transaction,
            resolved.tenant_id,
            current.id,
            practitionerId,
            startsAt,
            endsAt,
            configuration,
            selectedResourceId,
          );
        }

        const updatedRows = await transaction
          .update(appointments)
          .set({
            status: nextStatus,
            confirmationStatus:
              input.action === "confirm"
                ? "confirmed"
                : input.action === "cancel"
                  ? "declined"
                  : current.confirmation_status,
            startsAt,
            endsAt,
            practitionerId,
            cancelledAt: input.action === "cancel" ? new Date() : null,
            // Once the patient has acted, the "we moved your visit" notice no longer applies.
            clinicMovedFrom: null,
            clinicMovedAt: null,
            ...cancelFields,
            ...(input.action === "reschedule" ? {
              rescheduleReasonText: sealNote("reschedule", resolved.tenant_id, current.id, input.note ?? input.reason),
              rescheduleRequestedAt: null,
            } : {}),
            ...(guestsCiphertext !== undefined ? { guestEmailsCiphertext: guestsCiphertext } : {}),
            version: current.version + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(appointments.tenantId, resolved.tenant_id),
              eq(appointments.id, current.id),
            ),
          )
          .returning();
        const updated = updatedRows[0];
        if (!updated) throw new Error("Appointment update did not return a row");
        // Feature 8: a moved booking gets a new link before its message is queued; the old link stops working.
        const rotatedToken = input.action === "reschedule" ? await rotateManageToken(transaction, resolved.tenant_id, updated.id) : undefined;
        await recordMutation(
          transaction,
          resolved.tenant_id,
          updated.id,
          "patient",
          `appointment.${input.action}`,
          updated.version,
          accountId,
          // Only fixed codes go to the audit trail; the note is sealed on the booking.
          input.action === "cancel" ? { reasonCode: input.reasonCode ?? "other", cancelledBy: "customer", ...(input.note ?? input.reason ? { hasNote: true } : {}) }
            : input.action === "reschedule" ? { fromStartsAt: new Date(current.starts_at).toISOString(), toStartsAt: startsAt.toISOString(), ...(staffAskedToMove ? { answeredRequest: true } : {}), ...(input.practitionerId && input.practitionerId !== current.practitioner_id ? { personChanged: true } : {}) }
            : undefined,
        );
        if (input.action === "cancel") {
          await notifyStaff(transaction, resolved.tenant_id, {
            kind: "cancellation", appointmentId: updated.id, startsAt: updated.startsAt, dedupeKey: `appointment.cancel:${updated.id}`,
          });
        }
        if (input.action === "reschedule") {
          await notifyStaff(transaction, resolved.tenant_id, {
            kind: "rescheduled", appointmentId: updated.id, startsAt: updated.startsAt, dedupeKey: `appointment.reschedule:${updated.id}:${updated.version}`,
          });
        }
        // Feature 21: the time this booking left goes to the first person waiting for it, inside this same transaction.
        if (input.action === "cancel" || input.action === "reschedule") await offerFreedSlot(transaction, resolved.tenant_id, { locationId: current.location_id, serviceId: current.service_id, practitionerId: current.practitioner_id, startsAt: new Date(current.starts_at), endsAt: new Date(current.ends_at), excludePatientId: updated.patientId });
        return { ...mutationResultFromRow(updated), ...(rotatedToken ? { manageToken: rotatedToken } : {}) };
      },
      { isolationLevel: "serializable" },
    );
  } catch (error) {
    const mapped = mapDatabaseError(error);
    throw mapped ?? error;
  }
}

export async function updateAppointmentStatus(
  staffUserId: string,
  appointmentId: string,
  input: StaffAppointmentStatusInput,
  /** Set when an API key (feature 34) makes the change: the business was resolved with the key, and the audit row names the key. */
  apiKey?: { tenantId: string; keyId: string; keyPrefix: string },
  /** quiet: the customer is not messaged about this change (an import being undone, feature 12). */
  options?: { quiet?: boolean; /** The locations a limited staff member may use; a visit anywhere else reads as not found. */ locationIds?: readonly string[] | null },
): Promise<AppointmentMutationResult> {
  if (isPreviewMode()) return updatePreviewAppointmentStatus(appointmentId, input);
  const resolved = apiKey
    ? await resolveTenantAppointment(apiKey.tenantId, appointmentId)
    : await resolveStaffAppointment(staffUserId, appointmentId);
  if (!resolved) {
    throw new ApiError(404, "appointment_not_found", "Appointment not found.");
  }
  const database = getDatabase();
  if (!database) throw databaseUnavailable();

  return database.transaction(async (transaction) => {
    await setTenant(transaction, resolved.tenant_id);
    const currentRows = await transaction
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.tenantId, resolved.tenant_id),
          eq(appointments.id, appointmentId),
        ),
      )
      .for("update");
    const current = currentRows[0];
    if (!current || (options?.locationIds?.length && !options.locationIds.includes(current.locationId))) {
      throw new ApiError(404, "appointment_not_found", "Appointment not found.");
    }
    if (current.version !== input.expectedVersion) throw versionConflict();
    if (input.status === "declined" || input.status === "expired") {
      throw new ApiError(400, "validation_error", "Decline a request with a reason instead; requests expire on their own.");
    }
    if (!canTransitionAppointment(current.status, input.status)) {
      throw new ApiError(
        409,
        "invalid_status_transition",
        "That appointment status change is not allowed.",
      );
    }
    // Confirming a request is approving it: the slot is checked again when the request did not hold it.
    if (current.status === "requested" && input.status === "booked") {
      return approveRequestIn(transaction, current, { type: "staff", userId: staffUserId });
    }

    if (
      input.status === "cancelled" ||
      input.status === "no_show" ||
      input.status === "entered_in_error"
    ) {
      await transaction
        .update(resourceReservations)
        .set({ state: "released", updatedAt: new Date() })
        .where(
          and(
            eq(resourceReservations.tenantId, resolved.tenant_id),
            eq(resourceReservations.appointmentId, appointmentId),
          ),
        );
    }

    const updatedRows = await transaction
      .update(appointments)
      .set({
        status: input.status,
        confirmationStatus: input.status === "booked" && current.status === "requested"
          ? "confirmed"
          : input.status === "cancelled" && current.status === "requested"
            ? "declined"
            : current.confirmationStatus,
        cancelledAt: input.status === "cancelled" ? new Date() : current.cancelledAt,
        ...(input.status === "cancelled" ? { cancelledBy: "staff", cancelReasonCode: current.cancelReasonCode ?? "other", rescheduleRequestedAt: null } : {}),
        checkedInAt: input.status === "checked_in" ? new Date() : current.checkedInAt,
        completedAt: input.status === "completed" ? new Date() : current.completedAt,
        version: current.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(appointments.tenantId, resolved.tenant_id),
          eq(appointments.id, appointmentId),
        ),
      )
      .returning();
    const updated = updatedRows[0];
    if (!updated) throw new Error("Appointment update did not return a row");
    await recordMutation(
      transaction,
      resolved.tenant_id,
      appointmentId,
      "staff",
      `appointment.status.${input.status}`,
      updated.version,
      apiKey ? undefined : staffUserId,
      apiKey || options?.quiet ? { ...(apiKey ? { apiKeyId: apiKey.keyId, apiKeyPrefix: apiKey.keyPrefix } : {}), ...(options?.quiet ? { notifyCustomer: false } : {}) } : undefined,
    );
    if (input.status === "completed") await queueReviewRequest(transaction, resolved.tenant_id, appointmentId, updated.version);
    // Feature 21: a cancelled time goes to the first person waiting for it, inside this same transaction.
    if (input.status === "cancelled") await offerFreedSlot(transaction, resolved.tenant_id, { locationId: current.locationId, serviceId: current.serviceId, practitionerId: current.practitionerId, startsAt: current.startsAt, endsAt: current.endsAt, excludePatientId: current.patientId });
    // Arriving puts the customer in today's queue with a token number.
    if (input.status === "checked_in") {
      return { ...mutationResultFromRow(updated), queueNumber: await issueQueueTicket(transaction, resolved.tenant_id, appointmentId) };
    }
    return mutationResultFromRow(updated);
  });
}

export async function mutateStaffAppointment(
  context: StaffContext,
  appointmentId: string,
  input: CoreStaffAppointmentMutation,
  options?: { movedByClinic?: boolean },
): Promise<AppointmentMutationResult> {
  if ((!context.userId && !context.apiKeyId) || context.preview) throw databaseUnavailable();
  const resolved = context.apiKeyId
    ? await resolveTenantAppointment(context.tenantId, appointmentId)
    : await resolveStaffAppointment(context.userId ?? "", appointmentId);
  if (!resolved || resolved.tenant_id !== context.tenantId) {
    throw new ApiError(404, "appointment_not_found", "Appointment not found.");
  }
  const database = getDatabase();
  if (!database) throw databaseUnavailable();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await database.transaction(async (transaction) => {
        await setTenant(transaction, context.tenantId);
        const currentRows = await transaction.select().from(appointments).where(and(
          eq(appointments.tenantId, context.tenantId),
          eq(appointments.id, appointmentId),
        )).for("update");
        const current = currentRows[0];
        if (!current) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
        assertLocationVisible(context, current.locationId, () => new ApiError(404, "appointment_not_found", "Appointment not found."));
        if (current.version !== input.expectedVersion) throw versionConflict();

        if (input.action === "start") {
          // The visit starts: the status stays checked in, and the start time is stored.
          if (current.status !== "checked_in" || current.visitStartedAt) {
            throw new ApiError(409, "invalid_status_transition", "Only a checked-in appointment that has not started can be started.");
          }
          const updatedRows = await transaction.update(appointments).set({
            visitStartedAt: new Date(),
            version: current.version + 1,
            updatedAt: new Date(),
          }).where(and(eq(appointments.tenantId, context.tenantId), eq(appointments.id, appointmentId))).returning();
          const updated = updatedRows[0];
          if (!updated) throw new Error("Appointment update did not return a row");
          await recordMutation(transaction, context.tenantId, appointmentId, "staff", "appointment.started", updated.version, context.userId ?? undefined);
          return mutationResultFromRow(updated);
        }

        if (input.action === "details") {
          // Edit the visit in place. Only the names of what changed go in the audit trail, never the values.
          const changes: Partial<{ reasonForVisit: string | null; notes: string | null; customFields: CustomFieldValues; bookingSource: (typeof staffBookingSources)[number] }> = {};
          const changed: string[] = [];
          if (input.bookingSource !== undefined && input.bookingSource !== current.bookingSource) {
            // Online sources are what the customer did; only a source staff entered can be corrected.
            if (!(staffBookingSources as readonly string[]).includes(current.bookingSource)) {
              throw new ApiError(409, "booking_source_fixed", "This visit was booked online, so where it came from can't be changed.");
            }
            changes.bookingSource = input.bookingSource;
            changed.push("bookingSource");
          }
          if (input.reasonForVisit !== undefined) {
            changes.reasonForVisit = input.reasonForVisit || null;
            changed.push("reasonForVisit");
          }
          if (input.notes !== undefined) {
            changes.notes = input.notes || null;
            changed.push("notes");
          }
          let customFieldIds: string[] = [];
          if (input.customFields !== undefined) {
            const merged = mergeCustomFields(parseCustomFieldValues(current.customFields), input.customFields);
            if (Object.keys(merged).length > 24) {
              throw new ApiError(400, "validation_error", "A visit can hold up to 24 of your own properties.");
            }
            changes.customFields = merged;
            customFieldIds = Object.keys(input.customFields);
            changed.push("customFields");
          }
          const updatedRows = await transaction.update(appointments).set({
            ...changes,
            version: current.version + 1,
            updatedAt: new Date(),
          }).where(and(eq(appointments.tenantId, context.tenantId), eq(appointments.id, appointmentId))).returning();
          const updated = updatedRows[0];
          if (!updated) throw new Error("Appointment update did not return a row");
          await recordMutation(
            transaction, context.tenantId, appointmentId, "staff", "appointment.details_updated", updated.version,
            context.userId ?? undefined, { changed, customFieldIds },
          );
          return mutationResultFromRow(updated);
        }

        if (input.action === "form_received") {
          if (!["requested", "booked", "checked_in"].includes(current.status) || current.formStatus === "submitted") {
            throw new ApiError(409, "invalid_status_transition", "The scheduling form cannot be marked received for this appointment.");
          }
          const updatedRows = await transaction.update(appointments).set({
            formStatus: "submitted",
            version: current.version + 1,
            updatedAt: new Date(),
          }).where(and(eq(appointments.tenantId, context.tenantId), eq(appointments.id, appointmentId))).returning();
          const updated = updatedRows[0];
          if (!updated) throw new Error("Appointment update did not return a row");
          await recordMutation(transaction, context.tenantId, appointmentId, "staff", "appointment.form_received", updated.version, context.userId ?? undefined);
          return mutationResultFromRow(updated);
        }

        if (!isManageableAppointment(current.status)) {
          throw new ApiError(409, "appointment_not_manageable", "This appointment can no longer be rescheduled.");
        }
        const resizing = input.action === "resize";
        // A resize keeps the start and the staff member; a move picks both and keeps the service's length.
        const practitionerId = resizing ? current.practitionerId : input.practitionerId;
        const serviceId = resizing ? current.serviceId : input.serviceId ?? current.serviceId;
        const serviceChanged = serviceId !== current.serviceId;
        if (serviceChanged && input.action === "suggest") {
          throw new ApiError(400, "validation_error", "Suggest a new time first; change the service once it is booked.");
        }
        let nextPriceMinor: number | null | undefined;
        if (serviceChanged) {
          // Money already taken was for the old service; changing what it paid for would make the books wrong.
          const [paid] = await transaction.execute<{ paid: boolean }>(sql`
            select exists (select 1 from payments where tenant_id = ${context.tenantId} and appointment_id = ${current.id}) as paid
          `);
          if (paid?.paid) {
            throw new ApiError(409, "visit_has_payments", "This visit already has a payment, so its service can't change. Book the other service as a new visit.");
          }
          const [service] = await transaction.execute<{ price_minor: number | null }>(sql`
            select price_minor from services where tenant_id = ${context.tenantId} and id = ${serviceId} and is_active
          `);
          if (!service) throw slotUnavailable();
          nextPriceMinor = service.price_minor === null ? null : Number(service.price_minor);
        }
        const configuration = await loadBookingConfiguration(
          transaction,
          context.tenantId,
          current.locationId,
          serviceId,
          practitionerId,
          undefined,
        );
        if (!configuration) throw slotUnavailable();
        // A package credit or a code was taken for this service at this price (feature 25). Another service would reset the price
        // and leave the credit, the redemption and the discount behind, so the desk books the new service afresh instead.
        if (serviceChanged) {
          const [discounted] = await transaction.execute<{ n: number }>(sql`select count(*)::int as n from appointment_discounts where tenant_id = ${context.tenantId} and appointment_id = ${current.id}`);
          if (Number(discounted?.n ?? 0) > 0) {
            throw new ApiError(409, "discount_applied", "This visit has a package credit, a code or a member price taken for its service. Cancel it and book the other service instead.");
          }
        }
        const startsAt = resizing ? current.startsAt : new Date(input.startsAt);
        // A visit keeps its length unless the service changes (then it takes the new service's usual length) or it is resized.
        const lengthMinutes = serviceChanged
          ? configuration.duration_minutes
          : Math.round((new Date(current.endsAt).getTime() - new Date(current.startsAt).getTime()) / 60_000);
        const endsAt = resizing ? new Date(input.endsAt) : new Date(startsAt.getTime() + lengthMinutes * 60_000);
        if (resizing) assertResizeLength(startsAt, endsAt);
        // Notice applies to a new time. Keeping the time while changing the person, service or room was
        // already allowed when it was booked, and the desk needs to do that for someone who is up next.
        // The start of a resized visit is already booked, so only a moved start has to be in the bookable window.
        const slot = await assertSlotOfferable(transaction, {
          tenantId: context.tenantId,
          locationId: current.locationId,
          serviceId,
          practitionerId,
          startsAt,
          endsAt,
          mode: !resizing && startsAt.getTime() !== new Date(current.startsAt).getTime() ? "standard" : "existing",
          ...(!resizing && input.limitOverrideReason ? { overrideLimits: true } : {}),
          excludeAppointmentId: current.id,
          ...(!resizing && input.resourceId ? { preferredResourceId: input.resourceId } : {}),
          keepExistingLength: !serviceChanged || resizing,
        });
        const selectedResourceId = slot.resourceId;
        await replaceReservations(
          transaction,
          context.tenantId,
          current.id,
          practitionerId,
          startsAt,
          endsAt,
          configuration,
          selectedResourceId,
        );
        const nextStatus = input.action === "suggest" ? "requested" : current.status === "requested" ? "requested" : "booked";
        const updatedRows = await transaction.update(appointments).set({
          ...(serviceChanged ? { serviceId, priceMinor: nextPriceMinor ?? null } : {}),
          practitionerId,
          startsAt,
          endsAt,
          status: nextStatus,
          confirmationStatus: "needs_action",
          reminderStatus: "queued",
          clinicMovedFrom: options?.movedByClinic ? current.startsAt : null,
          clinicMovedAt: options?.movedByClinic ? new Date() : null,
          version: current.version + 1,
          updatedAt: new Date(),
        }).where(and(eq(appointments.tenantId, context.tenantId), eq(appointments.id, appointmentId))).returning();
        const updated = updatedRows[0];
        if (!updated) throw new Error("Appointment update did not return a row");
        await recordMutation(
          transaction,
          context.tenantId,
          appointmentId,
          "staff",
          `appointment.${input.action}`,
          updated.version,
          context.userId ?? undefined,
          {
            // Times and ids only: the history tab shows "moved from, to" from these.
            fromStartsAt: current.startsAt.toISOString(),
            toStartsAt: startsAt.toISOString(),
            ...(practitionerId !== current.practitionerId ? { fromPractitionerId: current.practitionerId, toPractitionerId: practitionerId } : {}),
            ...(serviceChanged ? { serviceChanged: true } : {}),
            ...(!resizing && input.resourceId ? { resourceChosen: true } : {}),
            ...(!resizing && input.limitOverrideReason ? { limitOverride: input.limitOverrideReason } : {}),
            // The worker reads this before it tells the customer about the new time.
            ...(input.notifyCustomer === false ? { notifyCustomer: false } : {}),
            ...apiKeyActor(context),
          },
        );
        // Feature 21: the time this booking left goes to the first person waiting for it, inside this same transaction.
        if (!resizing && (practitionerId !== current.practitionerId || startsAt.getTime() !== current.startsAt.getTime())) await offerFreedSlot(transaction, context.tenantId, { locationId: current.locationId, serviceId: current.serviceId, practitionerId: current.practitionerId, startsAt: current.startsAt, endsAt: current.endsAt, excludePatientId: current.patientId });
        return mutationResultFromRow(updated);
      }, { isolationLevel: "serializable" });
    } catch (error) {
      const code = getPostgresErrorCode(error);
      if ((code === "40001" || code === "40P01") && attempt < 2) continue;
      throw mapDatabaseError(error) ?? error;
    }
  }
  throw databaseUnavailable();
}

interface TransactionExtras {
  /** A special link's token: its use is counted here, in this transaction (feature 45). */
  specialLinkToken?: string;
  /** Set on every booking a combined link makes in one request, so they move and cancel as a group. */
  groupRef?: string;
  /** A later booking of the same group: the customer already proved their email on the first. */
  groupFollower?: boolean;
  /** Set by the server only (the booking assistant, feature 30), never read from a request: it is the booking's source. */
  source?: "assistant";
  /** A routing form's token (feature 46): limits who may be given the booking and links it to the form's response. */
  routingToken?: string;
}

/** A combined link books two to four people for the same time in one transaction: all of them, or none. */
async function createCombinedTransaction(
  transaction: KalendrTransaction,
  tenantId: string,
  input: PublicBookingInput,
  idempotencyKey: string,
  requestHash: string,
  slug: string,
): Promise<BookingCreatedResult> {
  const link = await resolveCombinedLink(transaction, tenantId, slug);
  if (!link || link.serviceId !== input.serviceId || !link.practitionerIds.includes(input.practitionerId)) {
    throw new ApiError(404, "combined_link_not_found", "This booking link is no longer available.");
  }
  const [priced] = await transaction.execute<{ payment_mode: string }>(sql`select payment_mode from services where tenant_id = ${tenantId} and id = ${input.serviceId}`);
  if (priced && priced.payment_mode !== "none") throw new ApiError(409, "combined_payment_unsupported", "This booking link can't be used for a service that takes online payment.");
  const groupRef = randomUUID();
  const order = [input.practitionerId, ...link.practitionerIds.filter((id) => id !== input.practitionerId)];
  let first: BookingCreatedResult | null = null;
  for (const [index, practitionerId] of order.entries()) {
    const result = await createAppointmentTransaction(
      transaction,
      tenantId,
      index === 0 ? input : { ...input, practitionerId, holdToken: undefined },
      index === 0 ? idempotencyKey : `${idempotencyKey}:g${index}`.slice(0, 160),
      requestHash,
      { groupRef, ...(index > 0 ? { groupFollower: true } : {}) },
    );
    first ??= result;
  }
  if (!first) throw new Error("Combined booking made nothing");
  return first;
}

async function createAppointmentTransaction(
  transaction: KalendrTransaction,
  tenantId: string,
  requested: PublicBookingInput,
  idempotencyKey: string,
  requestHash: string,
  extras: TransactionExtras = {},
): Promise<BookingCreatedResult> {
  let input = requested;
  const insertedKey = await transaction
    .insert(idempotencyKeys)
    .values({
      tenantId,
      route: BOOKING_ROUTE,
      key: idempotencyKey,
      requestHash,
    })
    .onConflictDoNothing()
    .returning({ id: idempotencyKeys.id });

  if (insertedKey.length === 0) {
    const existingRows = await transaction
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.tenantId, tenantId),
          eq(idempotencyKeys.route, BOOKING_ROUTE),
          eq(idempotencyKeys.key, idempotencyKey),
        ),
      )
      .for("update");
    const existing = existingRows[0];
    if (!existing || existing.requestHash !== requestHash) {
      throw new ApiError(
        409,
        "idempotency_conflict",
        "That Idempotency-Key was already used for a different request.",
      );
    }
    const replay = parseStoredBookingResult(existing.responseBody);
    if (!replay) {
      throw new ApiError(
        409,
        "request_in_progress",
        "A matching request is still being processed. Please retry shortly.",
      );
    }
    return replay;
  }

  // Feature 45: counted after the replay check above, so a retry never spends a second use, and rolled back with any later refusal.
  const specialLinkId = extras.specialLinkToken ? await spendSpecialLink(transaction, tenantId, extras.specialLinkToken, input.serviceId) : null;

  await transaction.execute(sql`
    update resource_reservations
    set state = 'released', updated_at = now()
    where tenant_id = ${tenantId}
      and state = 'held'
      and hold_expires_at <= now()
  `);

  // Team routing (feature 20): "anyone" becomes a real person here, inside the transaction, so the person is free right now.
  // Feature 46: a booking that came through a routing form may only be given to the people the form picked.
  const routing = extras.routingToken ? await resolveRoutingToken(transaction, tenantId, extras.routingToken, input.serviceId) : null;
  let assignmentWhy = "";
  if (input.practitionerId === ANYONE) {
    const assignee = await chooseAssignee(transaction, {
      tenantId, locationId: input.locationId, serviceId: input.serviceId,
      startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt), holdToken: input.holdToken, email: input.email,
      ...(routing ? { candidateIds: routing.candidateIds, weightMultipliers: routing.multipliers } : {}),
    });
    input = { ...input, practitionerId: assignee.practitionerId };
    assignmentWhy = assignee.why;
  } else if (routing) {
    assertPersonAllowed(routing, input.practitionerId);
    assignmentWhy = routing.candidateIds.length === 1 ? "was the only person this route offers" : "was the person the customer chose";
  }
  const config = await loadBookingConfiguration(
    transaction,
    tenantId,
    input.locationId,
    input.serviceId,
    input.practitionerId,
    input.patientType,
  );
  if (!config) throw slotUnavailable();
  const preparedForm = await prepareBookingFormIn(transaction, tenantId, input.serviceId, input.formAnswers);

  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  // The customer's own hold for this time must not block the booking it was taken for.
  const ownHold = await findOwnHold(transaction, tenantId, input.holdToken, { serviceId: input.serviceId, practitionerId: input.practitionerId, startsAt });
  const slot = await assertSlotOfferable(transaction, {
    tenantId,
    locationId: input.locationId,
    serviceId: input.serviceId,
    practitionerId: input.practitionerId,
    startsAt,
    endsAt,
    mode: "standard",
    ...(ownHold ? { ignoreHoldId: ownHold.id } : {}),
  });
  const intake = await prepareBookingIntake(transaction, tenantId, input.serviceId, input, extras.groupFollower ? { skipEmailCheck: true } : {});
  await assertCustomerCap(transaction, { tenantId, serviceId: input.serviceId, email: input.email, phone: input.phone, ...(extras.groupRef ? { excludeGroupRef: extras.groupRef } : {}) });
  await assertBookingAllowed(transaction, tenantId, input.practitionerId, "public"); // plan limits (feature 14)
  const selectedResourceId = slot.resourceId;
  const meeting = await resolveLocationChoice(transaction, tenantId, input.serviceId, input.locationId, input.locationChoice);
  const consentedAt = new Date();
  // Feature 27: a customer staff blocked cannot book online. The same email or phone is enough, so a new name does not get round it.
  await assertNotBlocked(transaction, tenantId, { email: input.email, phone: input.phone });
  // A returning patient is the same person only when name, email and phone all match a record
  // the clinic already holds. Their saved contact details are never overwritten from a public form;
  // only gaps are filled and the latest consent is recorded.
  const [matchedPatient] = await transaction.execute<{ id: string }>(sql`
    select id from patients
    where tenant_id = ${tenantId}
      and lower(email) = ${input.email.toLowerCase()}
      and kalendr_normalize_phone(phone) = kalendr_normalize_phone(${input.phone})
      and lower(regexp_replace(trim(first_name || ' ' || last_name), '\\s+', ' ', 'g')) = ${joinFullName(input.firstName, input.lastName).toLowerCase()}
      and is_dependent = ${input.bookingFor === "dependent"}
      and erased_at is null
    order by created_at
    limit 1
    for update
  `);
  let patient: { id: string };
  if (matchedPatient) {
    await transaction.execute(sql`
      update patients set
        date_of_birth = coalesce(date_of_birth, ${input.dateOfBirth ?? null}::date),
        accessibility_need = coalesce(accessibility_need, ${input.accessibilityNeed ?? null}),
        privacy_accepted_at = ${consentedAt.toISOString()}::timestamptz,
        updated_at = now()
      where tenant_id = ${tenantId} and id = ${matchedPatient.id}
    `);
    patient = matchedPatient;
  } else {
    const patientRows = await transaction
      .insert(patients)
      .values({
        tenantId,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        email: input.email.toLowerCase(),
        dateOfBirth: input.dateOfBirth,
        preferredChannel: input.preferredChannel,
        accessibilityNeed: input.accessibilityNeed,
        isDependent: input.bookingFor === "dependent",
        privacyAcceptedAt: consentedAt,
      })
      .returning({ id: patients.id });
    if (!patientRows[0]) throw new Error("Patient insert did not return a row");
    patient = patientRows[0];
  }
  // The messages box goes through the consent ledger (feature 7), which also keeps messaging_consent_at in step.
  await applyFormMessagingConsentIn(transaction, tenantId, patient.id, { agreed: input.messagingConsent, match: matchedPatient ? "full" : "new" });

  // A code or member price changes what the booking costs (feature 25), so the price is settled before the payment is asked for.
  const offers = await prepareBookingOffers(drizzleRunner(transaction), {
    tenantId, serviceId: input.serviceId, patientId: patient.id, listPriceMinor: slot.priceMinor, request: { couponCode: input.couponCode ?? null }, mode: "customer",
  });
  // Online payment (feature 23): a service that takes payment holds the time while the customer pays.
  const paymentQuote = await quoteService(transaction, tenantId, input.serviceId, offers.priceMinor);
  if (paymentQuote && input.acceptedPaymentPolicy !== true) {
    throw new ApiError(400, "payment_terms_required", "Please read and agree to the payment policy before you continue.");
  }
  const paymentHoldUntil = paymentQuote ? new Date(Date.now() + PAYMENT_HOLD_MINUTES * 60_000) : null;

  const manageToken = createOpaqueToken();
  // The id is chosen here so the sealed copy of the token can be bound to it (emails carry the link).
  const newAppointmentId = randomUUID();
  // Payment (feature 23) holds the time while the customer pays; otherwise the service's approval rule decides.
  const status: AppointmentStatus = paymentQuote
    ? "pending_payment"
    : decideApproval({
      settings: {
        rule: approvalRules.find((rule) => rule === config.approval_rule) ?? "never",
        noticeHours: config.approval_notice_hours,
      },
      startsAt,
      now: new Date(),
      email: input.email,
    });
  // Times the customer also offered. Only kept when the booking waits for staff, and never earlier than now.
  const proposedStarts = status === "requested"
    ? [...new Set((input.proposedStarts ?? []).map((value) => new Date(value).getTime()))]
        .filter((time) => time > Date.now() && time !== startsAt.getTime())
        .slice(0, MAX_PROPOSED_TIMES)
        .map((time) => new Date(time))
    : [];
  const appointmentRows = await transaction
    .insert(appointments)
    .values({
      id: newAppointmentId,
      tenantId,
      locationId: input.locationId,
      patientId: patient.id,
      practitionerId: input.practitionerId,
      serviceId: input.serviceId,
      startsAt,
      endsAt,
      status,
      ...(paymentQuote ? { paymentTerms: { ...paymentQuote.terms }, paymentTermsText: paymentQuote.payment.policyText } : {}),
      // The price of the length that was booked, less any member price or code. Left empty it falls back to the service's usual price.
      ...(offers.priceMinor !== null ? { priceMinor: offers.priceMinor } : {}),
      locationKind: meeting.kind,
      locationDetail: meeting.detail,
      confirmationStatus: "needs_action",
      bookingSource: extras.source ?? websiteBookingSource(input.origin?.channel),
      ...(specialLinkId ? { specialLinkId } : {}),
      ...(extras.groupRef ? { groupRef: extras.groupRef } : {}),
      reasonForVisit: input.reasonForVisit || null,
      referrerHost: input.origin?.referrerHost || null,
      utmSource: input.origin?.utmSource || null,
      utmMedium: input.origin?.utmMedium || null,
      utmCampaign: input.origin?.utmCampaign || null,
      formStatus: "not_assigned",
      reminderStatus: "queued",
      deliveryMode: deliveryModeForKind(meeting.kind),
      manageTokenHash: sha256(manageToken),
      manageTokenCiphertext: sealManageToken(tenantId, newAppointmentId, manageToken),
      guestEmailsCiphertext: sealGuests(tenantId, newAppointmentId, intake.guests),
      ...(proposedStarts.length > 0 ? { proposedStarts } : {}),
    })
    .returning();
  const appointment = appointmentRows[0];
  if (!appointment) throw new Error("Appointment insert did not return a row");
  await offers.record(appointment.id);
  if (routing) {
    const [person] = await transaction.execute<{ name: string }>(sql`select name from practitioners where tenant_id = ${tenantId} and id = ${input.practitionerId}`);
    await linkRoutingBooking(transaction, tenantId, routing, {
      appointmentId: appointment.id, patientId: patient.id, assignment: { personId: input.practitionerId, name: person?.name ?? "A team member", why: assignmentWhy },
    });
  }

  // A request on a service that does not hold the slot leaves it open; approving checks it is still free.
  if (status === "booked" || status === "pending_payment" || config.requests_hold_slot) {
    await insertReservations(
      transaction,
      tenantId,
      appointment.id,
      input.practitionerId,
      startsAt,
      endsAt,
      config,
      selectedResourceId,
      paymentHoldUntil,
    );
  }
  // The hold did its job: the booking itself now keeps the time.
  if (ownHold) await transaction.execute(sql`delete from slot_holds where tenant_id = ${tenantId} and id = ${ownHold.id}`);
  // The answers are sealed and never copied into the audit trail, outbox or notifications.
  if (preparedForm) await storeFormResponseIn(transaction, tenantId, appointment.id, patient.id, preparedForm);

  const response: BookingCreatedResult = {
    appointmentId: appointment.id,
    manageToken,
    practitionerId: appointment.practitionerId,
    status,
    startsAt: appointment.startsAt.toISOString(),
    endsAt: appointment.endsAt.toISOString(),
    ...(paymentQuote && paymentHoldUntil
      ? { payment: { dueNowMinor: paymentQuote.payment.dueNowMinor, currency: paymentQuote.payment.currency, expiresAt: paymentHoldUntil.toISOString(), policyText: paymentQuote.payment.policyText } }
      : {}),
  };
  // Feature 44: a blocked contact has done all the work above and gets the same answer, but nothing is kept.
  const blockedBy = await findBlockMatch(transaction, tenantId, { email: input.email, phone: input.phone });
  if (blockedBy) throw new SilentRefusal({ ...response }, blockedBy, ownHold?.id ?? null);
  await transaction.insert(auditEvents).values({
    tenantId,
    appointmentId: appointment.id,
    actorType: "patient",
    action: "appointment.created",
    outcome: "success",
    metadata: {
      source: "public_booking",
      channel: input.origin?.channel ?? "hosted",
      patientMatch: matchedPatient ? "returning" : "new",
      ...(preparedForm ? { formKey: preparedForm.definition.key, formVersion: preparedForm.definition.version } : {}),
    },
  });
  // A booking waiting for payment tells nobody yet: the worker does all of this when the provider confirms the payment.
  if (!paymentQuote) {
    await transaction.insert(outboxEvents).values({
      tenantId,
      aggregateType: "appointment",
      aggregateId: appointment.id,
      eventType: "appointment.created",
      payload: { appointmentId: appointment.id, version: appointment.version },
      dedupeKey: `appointment.created:${appointment.id}:${appointment.version}`,
      traceParent: currentTraceParent(),
    });
    await notifyStaff(transaction, tenantId, {
      kind: status === "requested" ? "booking_request" : "new_booking",
      appointmentId: appointment.id,
      startsAt: appointment.startsAt,
      dedupeKey: `appointment.created:${appointment.id}`,
    });
    await planAppointment(drizzleRunner(transaction), tenantId, appointment.id, { action: "appointment.created", version: appointment.version }); // workflows (feature 5)
  }
  await transaction
    .update(idempotencyKeys)
    .set({ responseStatus: 201, responseBody: { ...response } })
    .where(eq(idempotencyKeys.id, insertedKey[0]!.id));
  return response;
}

async function createStaffAppointmentTransaction(
  transaction: KalendrTransaction,
  context: StaffContext,
  input: StaffBookingInput,
  idempotencyKey: string,
  requestHash: string,
): Promise<StaffBookingCreatedResult> {
  const tenantId = context.tenantId;
  // An API key (feature 34) has no membership; its tenant and scopes were checked when the key was resolved.
  const membership = context.apiKeyId ? [{ authorized: true }] : await transaction.execute<{ authorized: boolean }>(sql`
    select exists (
      select 1 from memberships
      where tenant_id = ${tenantId}
        and user_id = ${context.userId}
        and is_active
    ) as authorized
  `);
  if (!membership[0]?.authorized) {
    const t = profileWords(await loadBusinessProfileIn(transaction, tenantId));
    throw new ApiError(403, "forbidden", `This ${t.business} role cannot create ${t.appointments}.`);
  }

  const insertedKey = await transaction.insert(idempotencyKeys).values({
    tenantId,
    route: STAFF_BOOKING_ROUTE,
    key: idempotencyKey,
    requestHash,
  }).onConflictDoNothing().returning({ id: idempotencyKeys.id });
  if (insertedKey.length === 0) {
    const existingRows = await transaction.select().from(idempotencyKeys).where(and(
      eq(idempotencyKeys.tenantId, tenantId),
      eq(idempotencyKeys.route, STAFF_BOOKING_ROUTE),
      eq(idempotencyKeys.key, idempotencyKey),
    )).for("update");
    const existing = existingRows[0];
    if (!existing || existing.requestHash !== requestHash) {
      throw new ApiError(409, "idempotency_conflict", "That Idempotency-Key was already used for a different request.");
    }
    const replay = parseStoredStaffBookingResult(existing.responseBody);
    if (!replay) {
      throw new ApiError(409, "request_in_progress", "A matching request is still being processed. Please retry shortly.");
    }
    return replay;
  }

  const response = await insertStaffAppointment(transaction, context, input);
  await transaction.update(idempotencyKeys).set({
    responseStatus: 201,
    responseBody: { ...response },
  }).where(eq(idempotencyKeys.id, insertedKey[0]!.id));
  return response;
}

/** Where a visit sits in a repeating series (feature 17). */
export interface SeriesPlacement {
  seriesId: string;
  seriesIndex: number;
}

/**
 * Books one visit for staff inside the caller's transaction: the engine check, the person, the cap, the rows, the audit
 * and the outbox event. Everything a single desk booking does, with no idempotency or membership step of its own, so a
 * series (feature 17) can book each of its visits through exactly the same path.
 */
export async function insertStaffAppointment(
  transaction: KalendrTransaction,
  context: StaffContext,
  input: StaffBookingInput,
  series?: SeriesPlacement,
): Promise<StaffBookingCreatedResult> {
  assertLocationAllowed(context, input.locationId);
  const tenantId = context.tenantId;
  const configuration = await loadBookingConfiguration(
    transaction,
    tenantId,
    input.locationId,
    input.serviceId,
    input.practitionerId,
    input.newPatient ? "new" : "returning",
  );
  if (!configuration) throw slotUnavailable();
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(startsAt.getTime() + (input.durationMinutes ?? configuration.duration_minutes) * 60_000);
  const source = input.source ?? "desk";
  const walkIn = source === "walk_in";
  const slot = await assertOfferableOrOverride(transaction, {
    tenantId,
    locationId: input.locationId,
    serviceId: input.serviceId,
    practitionerId: input.practitionerId,
    startsAt,
    endsAt,
    mode: walkIn ? "walk_in" : "standard",
    ...(input.limitOverrideReason ? { overrideLimits: true } : {}),
  }, Boolean(input.limitOverrideReason));
  const selectedResourceId = slot.resourceId;
  const meeting = await resolveLocationChoice(transaction, tenantId, input.serviceId, input.locationId, input.locationChoice, { defaultWhenUnasked: true });

  let patientId = input.patientId;
  if (patientId) {
    const existingPatient = await transaction.execute<{ id: string }>(sql`
      select id from patients where tenant_id = ${tenantId} and id = ${patientId}
      for key share
    `);
    if (!existingPatient[0]) {
      const t = profileWords(await loadBusinessProfileIn(transaction, tenantId));
      throw new ApiError(404, "patient_not_found", `${t.Customer} not found in this ${t.business}.`);
    }
  } else if (input.newPatient) {
    const [createdPatient] = await transaction.insert(patients).values({
      tenantId,
      firstName: input.newPatient.firstName,
      lastName: input.newPatient.lastName,
      phone: input.newPatient.phone,
      email: input.newPatient.email.toLowerCase(),
      dateOfBirth: input.newPatient.dateOfBirth,
      preferredChannel: input.newPatient.preferredChannel,
      accessibilityNeed: input.newPatient.accessibilityNeed,
      isDependent: input.newPatient.isDependent,
      messagingConsentAt: input.newPatient.messagingConsent ? new Date() : null,
    }).returning({ id: patients.id });
    if (!createdPatient) throw new Error("Patient insert did not return a row");
    patientId = createdPatient.id;
  } else {
    const t = profileWords(await loadBusinessProfileIn(transaction, tenantId));
    throw new ApiError(400, "validation_error", `Choose an existing ${t.customer} or enter a new ${t.customer}.`);
  }

  const capContact = input.newPatient
    ? { email: input.newPatient.email || null, phone: input.newPatient.phone }
    : (await transaction.execute<{ email: string; phone: string }>(sql`select email, phone from patients where tenant_id = ${tenantId} and id = ${patientId}`))[0];
  await assertBookingAllowed(transaction, tenantId, input.practitionerId, "staff"); // plan limits (feature 14)
  await assertCustomerCap(transaction, {
    tenantId, serviceId: input.serviceId, email: capContact?.email ?? null, phone: capContact?.phone ?? null,
    override: Boolean(input.limitOverrideReason),
  });

  // A member price, a code or a package credit changes what the visit costs (feature 25).
  const offers = await prepareBookingOffers(drizzleRunner(transaction), {
    tenantId, serviceId: input.serviceId, patientId: patientId ?? null, listPriceMinor: slot.priceMinor,
    request: { couponCode: input.couponCode ?? null, customerPackageId: input.customerPackageId ?? null }, mode: "staff",
  });
  // Staff are booking it, so it is confirmed. A walk-in is already in the building.
  const status: AppointmentStatus = walkIn ? "checked_in" : "booked";
  const manageToken = createOpaqueToken();
  const newAppointmentId = randomUUID();
  const [appointment] = await transaction.insert(appointments).values({
    id: newAppointmentId,
    tenantId,
    locationId: input.locationId,
    patientId,
    practitionerId: input.practitionerId,
    serviceId: input.serviceId,
    startsAt,
    endsAt,
    status,
    ...(offers.priceMinor !== null ? { priceMinor: offers.priceMinor } : {}),
    locationKind: meeting.kind,
    locationDetail: meeting.detail,
    confirmationStatus: "confirmed",
    bookingSource: source === "desk" ? "staff" : source,
    reasonForVisit: input.reasonForVisit || null,
    notes: input.notes || null,
    customFields: mergeCustomFields({}, parseCustomFieldValues(input.customFields)),
    ...(input.rebookedFromId ? { rebookedFromId: input.rebookedFromId } : {}),
    formStatus: "not_assigned",
    reminderStatus: walkIn || input.notifyCustomer === false ? "not_scheduled" : "queued",
    deliveryMode: deliveryModeForKind(meeting.kind),
    manageTokenHash: sha256(manageToken),
    manageTokenCiphertext: sealManageToken(tenantId, newAppointmentId, manageToken),
    ...(series ? { seriesId: series.seriesId, seriesIndex: series.seriesIndex } : {}),
  }).returning();
  if (!appointment) throw new Error("Appointment insert did not return a row");
  await offers.record(appointment.id);
  await insertReservations(
    transaction, tenantId, appointment.id, input.practitionerId,
    startsAt, endsAt, configuration, selectedResourceId,
  );
  await recordMutation(
    transaction, tenantId, appointment.id, "staff", "appointment.created",
    appointment.version, context.userId ?? undefined,
    // Only the fixed reason is kept, never any free text.
    { ...(input.limitOverrideReason ? { limitOverride: input.limitOverrideReason } : {}), ...(input.notifyCustomer === false ? { notifyCustomer: false } : {}), ...apiKeyActor(context) },
  );
  // A walk-in is already here, so they join today's queue straight away.
  const queueNumber = walkIn ? await issueQueueTicket(transaction, tenantId, appointment.id) : undefined;
  const response: StaffBookingCreatedResult = {
    appointmentId: appointment.id,
    patientId,
    manageToken,
    ...(queueNumber ? { queueNumber } : {}),
    status,
    startsAt: appointment.startsAt.toISOString(),
    endsAt: appointment.endsAt.toISOString(),
    version: appointment.version,
  };
  return response;
}

export async function loadBookingConfiguration(
  transaction: KalendrTransaction,
  tenantId: string,
  locationId: string,
  serviceId: string,
  practitionerId: string,
  patientType?: PublicBookingInput["patientType"],
): Promise<BookingConfigurationRow | null> {
  const configRows = await transaction.execute<BookingConfigurationRow>(sql`
    select
      service.id as service_id,
      service.duration_minutes,
      service.buffer_before_minutes,
      service.buffer_after_minutes,
      service.minimum_lead_minutes,
      service.maximum_advance_days,
      service.booking_mode,
      service.approval_rule,
      service.approval_notice_hours,
      service.requests_hold_slot,
      service.hide_location_until_confirmed,
      service.required_resource_kind,
      practitioner.id as practitioner_id,
      location.timezone as location_timezone
    from services as service
    join service_locations as service_location
      on service_location.tenant_id = service.tenant_id
     and service_location.service_id = service.id
     and service_location.location_id = ${locationId}
    join practitioner_services as practitioner_service
      on practitioner_service.tenant_id = service.tenant_id
     and practitioner_service.service_id = service.id
     and practitioner_service.practitioner_id = ${practitionerId}
    join practitioner_locations as practitioner_location
      on practitioner_location.tenant_id = service.tenant_id
     and practitioner_location.practitioner_id = ${practitionerId}
     and practitioner_location.location_id = ${locationId}
    join practitioners as practitioner
      on practitioner.tenant_id = service.tenant_id
     and practitioner.id = ${practitionerId}
     and practitioner.is_active
    join locations as location
      on location.tenant_id = service.tenant_id
     and location.id = ${locationId}
     and location.is_active
    where service.tenant_id = ${tenantId}
      and service.id = ${serviceId}
      and service.is_active
      and service.kind = 'appointment'
      and (${patientType ?? null}::text is null or ${patientType ?? null} = any(service.patient_types))
    for update of practitioner
  `);
  return configRows[0] ?? null;
}

/** A dragged end must leave a visit between the shortest and longest the schedule allows. */
function assertResizeLength(startsAt: Date, endsAt: Date): void {
  const minutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
  if (!Number.isFinite(minutes) || minutes < resizeMinutes.min || minutes > resizeMinutes.max) {
    throw new ApiError(400, "validation_error", `A visit can last between ${resizeMinutes.min} minutes and ${resizeMinutes.max / 60} hours.`);
  }
}

export async function insertReservations(
  transaction: KalendrTransaction,
  tenantId: string,
  appointmentId: string,
  practitionerId: string,
  startsAt: Date,
  endsAt: Date,
  configuration: BookingConfigurationRow,
  resourceId: string | null,
  /** Online payment (feature 23): when set, the time is only held until then and turns confirmed once paid. */
  holdUntil: Date | null = null,
): Promise<void> {
  const reservedStartsAt = new Date(
    startsAt.getTime() - configuration.buffer_before_minutes * 60_000,
  );
  const reservedEndsAt = new Date(
    endsAt.getTime() + configuration.buffer_after_minutes * 60_000,
  );
  const state = holdUntil ? "held" as const : "confirmed" as const;
  const holdExpiresAt = holdUntil ?? null;
  await transaction.insert(resourceReservations).values([
    {
      tenantId,
      appointmentId,
      practitionerId,
      startsAt: reservedStartsAt,
      endsAt: reservedEndsAt,
      state,
      holdExpiresAt,
    },
    ...(resourceId
      ? [{
          tenantId,
          appointmentId,
          resourceId,
          startsAt: reservedStartsAt,
          endsAt: reservedEndsAt,
          state,
          holdExpiresAt,
        }]
      : []),
  ]);
}

export async function replaceReservations(
  transaction: KalendrTransaction,
  tenantId: string,
  appointmentId: string,
  practitionerId: string,
  startsAt: Date,
  endsAt: Date,
  configuration: BookingConfigurationRow,
  resourceId: string | null,
  /** Approving a request must reserve the time even though the request itself held none. */
  options: { force?: boolean } = {},
): Promise<void> {
  await transaction.execute(sql`
    update resource_reservations
    set state = 'released', updated_at = now()
    where tenant_id = ${tenantId}
      and appointment_id = ${appointmentId}
      and state in ('held', 'confirmed')
  `);
  // A waiting request on a service that does not hold its slot keeps no reservation, wherever it moves (feature 41).
  if (!options.force) {
    const [waiting] = await transaction.execute<{ skip: boolean }>(sql`
      select (appointment.status = 'requested' and not service.requests_hold_slot) as skip
      from appointments as appointment
      join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
      where appointment.tenant_id = ${tenantId} and appointment.id = ${appointmentId}
    `);
    if (waiting?.skip) return;
  }
  await insertReservations(
    transaction,
    tenantId,
    appointmentId,
    practitionerId,
    startsAt,
    endsAt,
    configuration,
    resourceId,
  );
}

async function getDatabaseManageSnapshot(
  token: string,
  resolved: ResolvedAppointmentRow,
): Promise<ManageBookingSnapshot> {
  const database = getDatabase();
  if (!database) throw databaseUnavailable();
  return database.transaction(async (transaction) => {
    await setTenant(transaction, resolved.tenant_id);
    const rows = await transaction.execute<AppointmentDetailsRow>(sql`
      select
        appointment.*,
        to_json(appointment.proposed_starts) as proposed_json,
        tenant.slug as clinic_slug,
        tenant.name as clinic_name,
        tenant.legal_name as clinic_legal_name,
        tenant.phone as clinic_phone,
        tenant.email as clinic_email,
        tenant.timezone as clinic_timezone,
        tenant.locale as clinic_locale,
        tenant.business_type as clinic_business_type,
        tenant.terminology as clinic_terminology,
        tenant.features as clinic_features,
        location.name as location_name,
        location.address as location_address,
        location.city as location_city,
        location.timezone as location_timezone,
        location.accessible_entrance as location_accessible_entrance,
        service.name as service_name,
        service.description as service_description,
        service.duration_minutes,
        service.buffer_before_minutes,
        service.buffer_after_minutes,
        service.booking_mode as service_booking_mode,
        service.hide_location_until_confirmed,
        service.allow_guests,
        service.max_guests,
        service.patient_types,
        service.required_resource_kind,
        service.price_label,
        practitioner.name as practitioner_name,
        practitioner.title as practitioner_title,
        practitioner.initials as practitioner_initials,
        practitioner.specialty as practitioner_specialty
      from appointments as appointment
      join tenants as tenant on tenant.id = appointment.tenant_id
      join locations as location
        on location.tenant_id = appointment.tenant_id
       and location.id = appointment.location_id
      join services as service
        on service.tenant_id = appointment.tenant_id
       and service.id = appointment.service_id
      join practitioners as practitioner
        on practitioner.tenant_id = appointment.tenant_id
       and practitioner.id = appointment.practitioner_id
      where appointment.tenant_id = ${resolved.tenant_id}
        and appointment.id = ${resolved.appointment_id}
      limit 1
    `);
    const row = rows[0];
    if (!row) {
      throw new ApiError(404, "appointment_not_found", "Appointment not found.");
    }
    const [resourceRows, serviceLocationRows, servicePractitionerRows, practitionerLocationRows, movedRows] =
      await Promise.all([
        transaction.execute<{ id: string }>(sql`
          select resource_id as id
          from resource_reservations
          where tenant_id = ${resolved.tenant_id}
            and appointment_id = ${row.id}
            and resource_id is not null
            and state in ('held', 'confirmed')
        `),
        transaction.execute<{ id: string }>(sql`
          select location_id as id from service_locations
          where tenant_id = ${resolved.tenant_id} and service_id = ${row.service_id}
        `),
        transaction.execute<{ id: string }>(sql`
          select practitioner_id as id from practitioner_services
          where tenant_id = ${resolved.tenant_id} and service_id = ${row.service_id}
        `),
        transaction.execute<{ id: string }>(sql`
          select location_id as id from practitioner_locations
          where tenant_id = ${resolved.tenant_id} and practitioner_id = ${row.practitioner_id}
        `),
        transaction.execute<{ clinic_moved_from: Date | string | null }>(sql`
          select clinic_moved_from from appointments
          where tenant_id = ${resolved.tenant_id} and id = ${row.id}
        `),
      ]);
    const clinicMovedFrom = movedRows[0]?.clinic_moved_from;
    // The business's logo and the service's picture, so the manage page looks like the booking page.
    const media = await loadMediaUrlsIn(transaction, row.tenant_id, row.clinic_slug);

    const appointment: Appointment & { version: number } = {
      id: row.id,
      clinicId: row.tenant_id,
      locationId: row.location_id,
      patientId: row.patient_id,
      practitionerId: row.practitioner_id,
      serviceId: row.service_id,
      resourceIds: resourceRows.map((entry) => entry.id),
      startsAt: toIsoString(row.starts_at),
      endsAt: toIsoString(row.ends_at),
      status: row.status,
      confirmationStatus: row.confirmation_status,
      bookingSource: row.booking_source,
      formStatus: row.form_status,
      reminderStatus: row.reminder_status,
      manageToken: token,
      version: row.version,
      ...(clinicMovedFrom ? { clinicMovedFrom: toIsoString(clinicMovedFrom) } : {}),
    };
    const clinic: Clinic = {
      id: row.tenant_id,
      slug: row.clinic_slug,
      name: row.clinic_name,
      legalName: row.clinic_legal_name,
      phone: row.clinic_phone,
      email: row.clinic_email,
      timezone: row.clinic_timezone,
      locale: row.clinic_locale,
      ...publicProfileFields(profileFromRow({ business_type: row.clinic_business_type, terminology: row.clinic_terminology, features: row.clinic_features })),
      logoUrl: media.logoUrl,
      coverUrl: media.coverUrl,
    };
    // A request on a service that hides its address shows only where it is in general terms until it is approved.
    const locationHidden = row.hide_location_until_confirmed && row.status === "requested";
    const location: Location = {
      id: row.location_id,
      clinicId: row.tenant_id,
      name: locationHidden ? "" : row.location_name,
      address: locationHidden ? "" : row.location_address,
      city: locationHidden ? "" : row.location_city,
      timezone: row.location_timezone,
      accessibleEntrance: row.location_accessible_entrance,
    };
    const practitioner: Practitioner = {
      id: row.practitioner_id,
      clinicId: row.tenant_id,
      locationIds: practitionerLocationRows.map((entry) => entry.id),
      name: row.practitioner_name,
      title: row.practitioner_title,
      initials: row.practitioner_initials,
      specialty: row.practitioner_specialty,
    };
    const service: Service = {
      id: row.service_id,
      clinicId: row.tenant_id,
      name: row.service_name,
      description: row.service_description,
      durationMinutes: row.duration_minutes,
      bufferBeforeMinutes: row.buffer_before_minutes,
      bufferAfterMinutes: row.buffer_after_minutes,
      bookingMode: row.service_booking_mode,
      patientTypes: row.patient_types,
      practitionerIds: servicePractitionerRows.map((entry) => entry.id),
      locationIds: serviceLocationRows.map((entry) => entry.id),
      ...(row.required_resource_kind
        ? { resourceKind: row.required_resource_kind }
        : {}),
      ...(row.price_label ? { priceLabel: row.price_label } : {}),
      imageUrl: media.serviceImages.get(row.service_id) ?? null,
      // Only the guest rules: the manage page needs them to offer "edit guests".
      intake: { contactMode: "email_or_phone", allowGuests: row.allow_guests, maxGuests: Math.min(Math.max(row.max_guests, 1), 10), verifyEmail: false },
      // What this booking was made to pay (feature 23), from the terms stored when it was booked.
      ...(row.status === "pending_payment" ? { payment: storedPayment(row.payment_terms, row.payment_terms_text) } : {}),
    };
    const manageable = isManageableAppointment(row.status);
    const eligiblePractitioners = await transaction.execute<{ id: string; name: string }>(sql`
      select practitioner.id, practitioner.name
      from practitioners as practitioner
      join practitioner_services as ps on ps.tenant_id = practitioner.tenant_id and ps.practitioner_id = practitioner.id and ps.service_id = ${row.service_id}
      join practitioner_locations as pl on pl.tenant_id = practitioner.tenant_id and pl.practitioner_id = practitioner.id and pl.location_id = ${row.location_id}
      where practitioner.tenant_id = ${row.tenant_id} and practitioner.is_active
      order by practitioner.name
    `).then((rows) => rows.map((person) => ({ id: person.id, name: person.name })));
    // What this customer may do, from the service's policy. A booking staff asked to move is held to none of it.
    const policy = await loadCancelPolicy(transaction, row.tenant_id, row.service_id);
    const staffAsked = row.status === "reschedule_requested";
    const startsAtDate = new Date(row.starts_at);
    const cancelDecision = customerCancelDecision(policy, startsAtDate, new Date());
    const rescheduleDecision = customerRescheduleDecision(policy, startsAtDate, new Date());
    const canCancel = manageable && (staffAsked || cancelDecision.allowed);
    const canReschedule = manageable && (staffAsked || rescheduleDecision.allowed);
    return {
      appointment,
      clinic,
      service,
      practitioner,
      location,
      canCancel,
      canReschedule,
      // The customer's own guest list, so editing starts from what is there. Opened here only for the holder of the link.
      guests: openGuests(row.tenant_id, row.id, row.guest_emails_ciphertext),
      manage: {
        sameStaffOnly: policy.rescheduleSamePerson,
        ...(!policy.rescheduleSamePerson ? { eligiblePractitioners } : {}),
        ...(manageable && !canCancel ? { cancelBlockedMessage: policyMessage("cancel", cancelDecision, policy, row.clinic_phone) } : {}),
        ...(manageable && !canReschedule ? { rescheduleBlockedMessage: policyMessage("reschedule", rescheduleDecision, policy, row.clinic_phone) } : {}),
        ...(staffAsked ? { rescheduleRequested: true, rescheduleDeadline: new Date(new Date(row.reschedule_requested_at ?? Date.now()).getTime() + policy.rescheduleRequestDays * 86_400_000).toISOString() } : {}),
        allowGuestEdit: manageable && (staffAsked || rescheduleDecision.allowed),
      },
      ...(locationHidden ? { locationHidden: true } : {}),
      ...(row.status === "declined" && isDeclineReason(row.decline_reason_code) ? { declineReason: row.decline_reason_code } : {}),
      ...(row.status === "requested" && row.proposed_json && row.proposed_json.length > 0
        ? { proposedStarts: row.proposed_json.map(toIsoString) }
        : {}),
    };
  });
}

async function resolveTenant(slug: string): Promise<ResolvedTenantRow | null> {
  const database = getDatabase();
  if (!database) return null;
  const rows = await database.execute<ResolvedTenantRow>(
    sql`select * from kalendr_resolve_tenant(${slug}, null)`,
  );
  return rows[0] ?? null;
}

export async function resolveManageToken(
  token: string,
): Promise<ResolvedAppointmentRow | null> {
  const database = getDatabase();
  if (!database) return null;
  const rows = await database.execute<ResolvedAppointmentRow>(
    sql`select * from kalendr_resolve_manage_token(${sha256(token)})`,
  );
  return rows[0] ?? null;
}

export async function resolveStaffAppointment(
  userId: string,
  appointmentId: string,
): Promise<ResolvedAppointmentRow | null> {
  const database = getDatabase();
  if (!database) return null;
  const rows = await database.execute<ResolvedAppointmentRow>(
    sql`select * from kalendr_resolve_staff_appointment(${userId}, ${appointmentId})`,
  );
  return rows[0] ?? null;
}

/** The appointment's business, looked up inside that business's scope. For API keys, which have no staff membership to resolve through. */
async function resolveTenantAppointment(tenantId: string, appointmentId: string): Promise<ResolvedAppointmentRow | null> {
  const found = await withTenant(tenantId, (transaction) => transaction.execute<ResolvedAppointmentRow>(sql`
    select tenant_id, id as appointment_id from appointments where tenant_id = ${tenantId} and id = ${appointmentId} limit 1
  `));
  return found[0] ?? null;
}

/** Audit metadata that names the API key behind a change. Empty for staff. */
function apiKeyActor(context: StaffContext): Record<string, unknown> {
  return context.apiKeyId ? { apiKeyId: context.apiKeyId, apiKeyPrefix: context.apiKeyPrefix ?? "" } : {};
}

export async function setTenant(
  transaction: KalendrTransaction,
  tenantId: string,
): Promise<void> {
  await transaction.execute(
    sql`select set_config('app.tenant_id', ${tenantId}, true)`,
  );
}

export async function recordMutation(
  transaction: KalendrTransaction,
  tenantId: string,
  appointmentId: string,
  actorType: string,
  action: string,
  version: number,
  actorUserId?: string,
  extra?: Record<string, unknown>,
  /** For the worker only. It never reaches the audit trail, so free text for the customer goes here. */
  payloadExtra?: Record<string, unknown>,
): Promise<void> {
  await transaction.insert(auditEvents).values({
    tenantId,
    appointmentId,
    actorUserId,
    actorType: typeof extra?.apiKeyId === "string" ? "api_key" : actorType,
    action,
    outcome: "success",
    metadata: { ...extra, version },
  });
  await transaction.insert(outboxEvents).values({
    tenantId,
    aggregateType: "appointment",
    aggregateId: appointmentId,
    eventType: action,
    payload: { appointmentId, version, ...(extra?.notifyCustomer === false ? { notifyCustomer: false } : {}), ...payloadExtra },
    dedupeKey: `${action}:${appointmentId}:${version}`,
    traceParent: currentTraceParent(),
  });
  // Workflows (feature 5). A booking made or cancelled with "don't tell the customer" (an import) starts no workflow messages either.
  const quiet = extra?.notifyCustomer === false && (action === "appointment.created" || action === "appointment.status.cancelled");
  if (!quiet) await planAppointment(drizzleRunner(transaction), tenantId, appointmentId, { action, version });
  // Money paid online follows the policy the customer agreed to (feature 23). Queues the refund; calls no provider.
  const policyEvent = policyEventFor(action);
  if (policyEvent) await applyPaymentPolicy(drizzleRunner(transaction), { tenantId, appointmentId, event: policyEvent, actorUserId: actorUserId ?? null });
  // A code or package credit used on a booking that will not happen goes back (feature 25).
  await releaseBookingOffers(drizzleRunner(transaction), { tenantId, appointmentId, action });
}

/** Asks the customer for a review two hours after the visit is marked finished. Once per appointment. */
async function queueReviewRequest(
  transaction: KalendrTransaction,
  tenantId: string,
  appointmentId: string,
  version: number,
): Promise<void> {
  await transaction
    .insert(outboxEvents)
    .values({
      tenantId,
      aggregateType: "appointment",
      aggregateId: appointmentId,
      eventType: "appointment.review_request",
      payload: { appointmentId, version },
      dedupeKey: `review:${appointmentId}`,
      traceParent: currentTraceParent(),
      availableAt: new Date(Date.now() + REVIEW_REQUEST_DELAY_MS),
    })
    .onConflictDoNothing();
}

/** Applies a patch of property values: a key present replaces, an empty value removes it. */
function mergeCustomFields(existing: CustomFieldValues, patch: CustomFieldValues): CustomFieldValues {
  const merged: CustomFieldValues = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (isEmptyFieldValue(value)) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

export function mutationResultFromRow(row: {
  id: string;
  status: AppointmentStatus;
  startsAt: Date;
  endsAt: Date;
  version: number;
}): AppointmentMutationResult {
  return {
    appointmentId: row.id,
    status: row.status,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    version: row.version,
  };
}

function parseStoredBookingResult(value: unknown): BookingCreatedResult | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  if (
    typeof result.appointmentId !== "string" ||
    typeof result.manageToken !== "string" ||
    typeof result.status !== "string" ||
    typeof result.startsAt !== "string" ||
    typeof result.endsAt !== "string"
  ) {
    return null;
  }
  return result as unknown as BookingCreatedResult;
}

function parseStoredStaffBookingResult(value: unknown): StaffBookingCreatedResult | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  if (
    typeof result.appointmentId !== "string" ||
    typeof result.patientId !== "string" ||
    typeof result.status !== "string" ||
    typeof result.startsAt !== "string" ||
    typeof result.endsAt !== "string" ||
    typeof result.version !== "number" ||
    typeof result.manageToken !== "string"
  ) return null;
  return result as unknown as StaffBookingCreatedResult;
}

function websiteBookingSource(channel: "hosted" | "widget" | "iframe" | undefined): "online" | "widget" | "iframe" {
  return channel === "widget" || channel === "iframe" ? channel : "online";
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function slotUnavailable(): ApiError {
  return new ApiError(
    409,
    "slot_unavailable",
    "That time is no longer available. Please choose another slot.",
  );
}

export function versionConflict(): ApiError {
  return new ApiError(
    409,
    "version_conflict",
    "This appointment changed since you opened it. Refresh and try again.",
  );
}

export function databaseUnavailable(): ApiError {
  return new ApiError(
    503,
    "service_unavailable",
    "Booking is temporarily unavailable. Please contact the business.",
  );
}

function openGuests(tenantId: string, appointmentId: string, sealed: string | null): string[] {
  const opened = openPrivate("guests", tenantId, appointmentId, sealed);
  if (!opened) return [];
  try {
    const parsed: unknown = JSON.parse(opened);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string").slice(0, 10) : [];
  } catch {
    return [];
  }
}
