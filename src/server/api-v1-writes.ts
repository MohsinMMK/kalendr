import "server-only";

import { z } from "zod";

import { withTenant } from "@/db/client";
import { ApiError } from "@/server/api-error";
import type { ApiKeyContext } from "@/server/api-key-context";
import { staffContextFor } from "@/server/api-key-context";
import {
  createStaffAppointment, mutateStaffAppointment, updateAppointmentStatus,
} from "@/server/appointment-repository";
import { staffBookingSchema } from "@/server/contracts";
import type { StaffBookingInput } from "@/server/contracts";
import { canonicalJsonHash } from "@/server/crypto";
import { claimKey, finishKey } from "@/server/idempotent";
import { applyFeatureLimits, loadStaffBusinessProfile } from "@/server/business-profile";
import type {
  createAppointmentBody, newCustomerBody, V1Appointment, V1Customer, rescheduleBody, cancelBody,
} from "@/server/api-v1-contracts";
import { defaultLocationId, getAppointment, getCustomer, readAppointment, toCustomer } from "@/server/api-v1-reads";
import { insertStaffPatient, staffPatientInput } from "@/server/staff-operations";
import { queueCustomerCreated } from "@/server/webhooks/events";

/**
 * The v1 writes. Booking, moving and cancelling call the same server functions the staff screens call, so the
 * slot check, the limits, the audit trail and the outbox events are the app's own and cannot be skipped from here.
 * An API key has no user, so the audit row names the key instead.
 */

const CUSTOMERS_ROUTE = "/api/v1/customers";

function mapToStaffBooking(context: ApiKeyContext, body: z.infer<typeof createAppointmentBody>, locationId: string): StaffBookingInput {
  const candidate = {
    clinicSlug: context.clinicSlug,
    locationId,
    serviceId: body.serviceId,
    practitionerId: body.staffId,
    startsAt: body.startsAt,
    ...(body.durationMinutes ? { durationMinutes: body.durationMinutes } : {}),
    source: "desk",
    ...(body.reasonForVisit ? { reasonForVisit: body.reasonForVisit } : {}),
    ...(body.notes ? { notes: body.notes } : {}),
    ...(body.customerId ? { patientId: body.customerId } : {}),
    ...(body.customer ? {
      newPatient: {
        firstName: body.customer.firstName, lastName: body.customer.lastName, phone: body.customer.phone,
        email: body.customer.email, ...(body.customer.dateOfBirth ? { dateOfBirth: body.customer.dateOfBirth } : {}),
        preferredChannel: "email", isDependent: false, messagingConsent: false,
      },
    } : {}),
  };
  const parsed = staffBookingSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ApiError(400, "validation_error", "Please check the fields in the request.", { body: parsed.error.issues.map((issue) => issue.message) });
  }
  return parsed.data;
}

export async function bookAppointment(
  context: ApiKeyContext,
  body: z.infer<typeof createAppointmentBody>,
  idempotencyKey: string,
): Promise<V1Appointment> {
  const staff = staffContextFor(context);
  // Checked here so the answer is the v1 `customer_not_found`, in the same words a customer lookup gives.
  if (body.customerId) await getCustomer(context.tenantId, body.customerId);
  const locationId = body.locationId ?? await defaultLocationId(context.tenantId);
  const input = applyFeatureLimits(mapToStaffBooking(context, body, locationId), await loadStaffBusinessProfile(staff));
  const created = await createStaffAppointment(staff, input, idempotencyKey, canonicalJsonHash(input));
  // A customer added with the booking is a new customer for webhooks too. The dedupe key makes a replay harmless.
  if (body.customer) await withTenant(context.tenantId, (tx) => queueCustomerCreated(tx, context.tenantId, created.patientId));
  // The manage token in `created` is for staff to hand over; the API never returns it.
  return getAppointment(context.tenantId, created.appointmentId);
}

/** The version to guard with: the caller's, or the current one read now (documented as the weaker guarantee). */
async function versionFor(context: ApiKeyContext, appointmentId: string, given: number | undefined): Promise<{ version: number; staffId: string }> {
  const row = await withTenant(context.tenantId, (tx) => readAppointment(tx, context.tenantId, appointmentId));
  return { version: given ?? row.version, staffId: row.practitionerId };
}

export async function rescheduleAppointment(
  context: ApiKeyContext,
  appointmentId: string,
  body: z.infer<typeof rescheduleBody>,
): Promise<V1Appointment> {
  const current = await versionFor(context, appointmentId, body.version);
  await mutateStaffAppointment(staffContextFor(context), appointmentId, {
    action: "reschedule",
    startsAt: body.startsAt,
    practitionerId: body.staffId ?? current.staffId,
    expectedVersion: current.version,
  });
  return getAppointment(context.tenantId, appointmentId);
}

export async function cancelAppointment(
  context: ApiKeyContext,
  appointmentId: string,
  body: z.infer<typeof cancelBody>,
): Promise<V1Appointment> {
  const current = await versionFor(context, appointmentId, body.version);
  await updateAppointmentStatus(
    "",
    appointmentId,
    { status: "cancelled", expectedVersion: current.version, ...(body.reason ? { reason: body.reason } : {}) },
    { tenantId: context.tenantId, keyId: context.keyId, keyPrefix: context.keyPrefix },
  );
  return getAppointment(context.tenantId, appointmentId);
}

/**
 * Adds a customer. The Idempotency-Key, the row, the audit entry and the `customer.created` outbox event all commit
 * together, so a retry after a dropped connection returns the same customer and sends one event.
 */
export async function createCustomer(
  context: ApiKeyContext,
  body: z.infer<typeof newCustomerBody>,
  idempotencyKey: string,
): Promise<V1Customer> {
  return withTenant(context.tenantId, async (transaction) => {
    const claim = await claimKey<V1Customer>(transaction, context.tenantId, CUSTOMERS_ROUTE, idempotencyKey, body);
    if ("replay" in claim) return claim.replay;
    const parsed = staffPatientInput.safeParse({
      firstName: body.firstName, lastName: body.lastName, phone: body.phone, email: body.email,
      ...(body.dateOfBirth ? { dateOfBirth: body.dateOfBirth } : {}),
      preferredChannel: "email", isDependent: false, messagingConsent: false,
    });
    if (!parsed.success) {
      throw new ApiError(400, "validation_error", "Please check the fields in the request.", { body: parsed.error.issues.map((issue) => issue.message) });
    }
    // The same insert and audit entry the staff desk uses; the key is named in the audit row.
    const created = await insertStaffPatient(transaction, staffContextFor(context), parsed.data);
    await queueCustomerCreated(transaction, context.tenantId, created.id);
    const customer = toCustomer(created);
    await finishKey(transaction, claim.claimId, customer);
    return customer;
  });
}
