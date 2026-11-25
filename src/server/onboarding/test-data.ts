import "server-only";

import { randomUUID } from "node:crypto";

import { TZDate } from "@date-fns/tz";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { withTenant } from "@/db/client";
import { appointments, auditEvents, onboardingProgress, patients } from "@/db/schema";

import { ApiError } from "../api-error";
import { createStaffAppointment } from "../appointment-repository";
import { canonicalJsonHash } from "../crypto";
import { assertNotReadOnlyImpersonation, requirePermission, type StaffContext } from "../staff-context";
import { writeMark } from "./progress";

/**
 * The owner's test booking and the sample data (feature 11). Both are ordinary bookings made through the ordinary
 * booking code, then flagged `is_test` so counts and reports leave them out, and removed in one click by
 * `kalendr_purge_test_rows`. Sample customers are named "(sample)" so nobody mistakes them for real people. No message goes
 * out for a sample booking.
 */

export const testBookingQuerySchema = z.strictObject({ since: z.iso.datetime({ offset: true }) });

export interface TestBookingView {
  found: boolean;
  appointmentId?: string;
  startsAt?: string;
  serviceName?: string;
  /** How the confirmation is going: its channel and state, or null before the worker has queued one. */
  confirmation?: { channel: string; status: string } | null;
}

interface CandidateRow extends Record<string, unknown> {
  appointment_id: string;
  patient_id: string;
  starts_at: Date | string;
  service_name: string;
  already_test: boolean;
  patient_created_at: Date | string;
  other_bookings: number;
}

/**
 * Looks for the booking the owner just made on their own page, by their own email and the time the panel opened, flags it as
 * a test, and reports how its confirmation is going. Asking again after it is found changes nothing.
 */
export async function findTestBooking(context: StaffContext, sinceIso: string): Promise<TestBookingView> {
  requirePermission(context, "settings.manage");
  assertNotReadOnlyImpersonation(context);
  if (context.preview) return { found: false };
  const since = new Date(sinceIso);
  if (Number.isNaN(since.getTime()) || Date.now() - since.getTime() > 6 * 3_600_000) return { found: false };
  return withTenant(context.tenantId, async (transaction) => {
    const [candidate] = await transaction.execute<CandidateRow>(sql`
      select appointment.id as appointment_id, appointment.patient_id, appointment.starts_at, service.name as service_name, appointment.is_test as already_test,
        patient.created_at as patient_created_at,
        (select count(*)::int from appointments as other where other.tenant_id = appointment.tenant_id and other.patient_id = appointment.patient_id and other.id <> appointment.id) as other_bookings
      from appointments as appointment
      join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
      join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
      where appointment.tenant_id = ${context.tenantId}
        and lower(patient.email) = lower(${context.userEmail})
        and appointment.created_at >= ${since.toISOString()}::timestamptz
        and appointment.status in ('requested', 'booked', 'checked_in')
      order by appointment.created_at desc
      limit 1
    `);
    if (!candidate) return { found: false };
    if (!candidate.already_test) {
      await transaction.update(appointments).set({ isTest: true }).where(and(eq(appointments.tenantId, context.tenantId), eq(appointments.id, candidate.appointment_id)));
      // The owner as a customer is a test customer only if this booking made them and nothing else uses them.
      if (new Date(candidate.patient_created_at) >= since && candidate.other_bookings === 0) {
        await transaction.update(patients).set({ isTest: true }).where(and(eq(patients.tenantId, context.tenantId), eq(patients.id, candidate.patient_id)));
      }
      await writeMark(transaction, context.tenantId, "test_booking", "done");
      await transaction.insert(auditEvents).values({
        tenantId: context.tenantId, appointmentId: candidate.appointment_id, actorUserId: context.userId, actorType: "staff",
        action: "onboarding.test_booking", outcome: "success", metadata: {},
      });
    }
    const [notice] = await transaction.execute<{ channel: string; status: string }>(sql`
      select channel::text as channel, status::text as status from notifications
      where tenant_id = ${context.tenantId} and appointment_id = ${candidate.appointment_id}
      order by created_at desc limit 1
    `);
    return {
      found: true,
      appointmentId: candidate.appointment_id,
      startsAt: new Date(candidate.starts_at).toISOString(),
      serviceName: candidate.service_name,
      confirmation: notice ?? null,
    };
  });
}

/**
 * Removes every test booking and sample customer with it. Safe to press when there is nothing to remove. A test booking that
 * somehow holds a payment or a record is never deleted: it is retired (entered in error, its time freed) and counted separately.
 * A customer with a consent record (append-only) or anything else pointing at them is kept and counted too.
 */
export async function removeTestData(context: StaffContext): Promise<{ appointmentsRemoved: number; customersRemoved: number; appointmentsRetired: number; customersKept: number }> {
  requirePermission(context, "settings.manage");
  assertNotReadOnlyImpersonation(context);
  if (context.preview) throw new ApiError(409, "preview_mode", "There is no test data in the preview.");
  return withTenant(context.tenantId, async (transaction) => {
    const [result] = await transaction.execute<{ appointments_removed: number; customers_removed: number; appointments_retired: number; customers_kept: number }>(sql`select * from kalendr_purge_test_rows(${context.tenantId})`);
    await transaction.delete(onboardingProgress).where(and(eq(onboardingProgress.tenantId, context.tenantId), eq(onboardingProgress.stepKey, "sample_data")));
    const counts = { appointmentsRemoved: result?.appointments_removed ?? 0, customersRemoved: result?.customers_removed ?? 0, appointmentsRetired: result?.appointments_retired ?? 0, customersKept: result?.customers_kept ?? 0 };
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "onboarding.test_data_removed", outcome: "success", metadata: counts,
    });
    return counts;
  });
}

const sampleCustomers = [
  ["Priya (sample)", "Shah"], ["Rahul (sample)", "Verma"], ["Anita (sample)", "Nair"], ["Kabir (sample)", "Singh"],
  ["Meera (sample)", "Iyer"], ["Dev (sample)", "Patel"], ["Sana (sample)", "Khan"], ["Arjun (sample)", "Rao"],
] as const;

/** Local clock times to try on each of the next seven days. A time that is closed or taken is skipped. */
const sampleTimes = [[10, 0], [11, 30], [14, 30], [16, 0]] as const;

interface SampleSetup extends Record<string, unknown> {
  practitioner_id: string;
  location_id: string;
  timezone: string;
  service_ids: string[];
}

export interface SampleDataResult {
  added: number;
}

/** A week of clearly labelled sample appointments and customers, so an owner can explore a busy schedule. Nothing is sent to anyone. */
export async function addSampleData(context: StaffContext): Promise<SampleDataResult> {
  requirePermission(context, "settings.manage");
  assertNotReadOnlyImpersonation(context);
  requirePermission(context, "appointments.book");
  if (context.preview) throw new ApiError(409, "preview_mode", "Sample data is not added in the preview.");
  const existing = await withTenant(context.tenantId, async (transaction) => {
    const [marked] = await transaction.select().from(onboardingProgress).where(and(eq(onboardingProgress.tenantId, context.tenantId), eq(onboardingProgress.stepKey, "sample_data")));
    if (marked?.doneAt) return true;
    return false;
  });
  if (existing) throw new ApiError(409, "sample_data_exists", "Sample data is already in. Remove it first if you want a fresh set.");
  const setup = await withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.execute<SampleSetup>(sql`
      select person.id as practitioner_id, place.location_id, location.timezone,
        array(select link.service_id from practitioner_services as link join services as service on service.tenant_id = link.tenant_id and service.id = link.service_id and service.is_active and service.booking_mode = 'instant'
              where link.tenant_id = person.tenant_id and link.practitioner_id = person.id order by service.created_at) as service_ids
      from practitioners as person
      join practitioner_locations as place on place.tenant_id = person.tenant_id and place.practitioner_id = person.id
      join locations as location on location.tenant_id = place.tenant_id and location.id = place.location_id and location.is_active
      where person.tenant_id = ${context.tenantId} and person.is_active
        and exists (select 1 from availability_rules as rule where rule.tenant_id = person.tenant_id and rule.practitioner_id = person.id)
      order by person.created_at limit 1
    `);
    return row;
  });
  if (!setup || setup.service_ids.length === 0) {
    throw new ApiError(409, "nothing_to_book", "Sample data needs a service, a person and opening hours first. Finish those steps, then add it.");
  }
  let added = 0;
  const today = TZDate.tz(setup.timezone);
  for (let offset = 1; offset <= 7 && added < sampleCustomers.length; offset += 1) {
    for (const [hour, minute] of sampleTimes) {
      if (added >= sampleCustomers.length || added >= offset * 2) break;
      const day = new TZDate(today.getFullYear(), today.getMonth(), today.getDate() + offset, hour, minute, 0, setup.timezone);
      const [first, last] = sampleCustomers[added]!;
      const input = {
        clinicSlug: context.clinicSlug,
        locationId: setup.location_id,
        serviceId: setup.service_ids[added % setup.service_ids.length]!,
        practitionerId: setup.practitioner_id,
        startsAt: day.toISOString(),
        source: "desk" as const,
        notifyCustomer: false,
        newPatient: {
          firstName: first, lastName: last, phone: `+91900000${String(1000 + added)}`, email: `sample${added + 1}@sample.example`,
          preferredChannel: "email" as const, isDependent: false, messagingConsent: false,
        },
      };
      try {
        const booked = await createStaffAppointment(context, input, `sample:${randomUUID()}`, canonicalJsonHash(input));
        await withTenant(context.tenantId, async (transaction) => {
          await transaction.update(appointments).set({ isTest: true, isSample: true }).where(and(eq(appointments.tenantId, context.tenantId), eq(appointments.id, booked.appointmentId)));
          await transaction.update(patients).set({ isTest: true }).where(and(eq(patients.tenantId, context.tenantId), eq(patients.id, booked.patientId)));
        });
        added += 1;
      } catch (error: unknown) {
        // A closed or taken time is skipped; anything else is a real problem.
        if (!(error instanceof ApiError) || error.status >= 500) throw error;
      }
    }
  }
  if (added === 0) throw new ApiError(409, "nothing_to_book", "No free time was found in the next week. Check your opening hours, then add sample data.");
  await withTenant(context.tenantId, async (transaction) => {
    await writeMark(transaction, context.tenantId, "sample_data", "done");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "onboarding.sample_data_added", outcome: "success", metadata: { appointments: added },
    });
  });
  return { added };
}
