/** @vitest-environment node */

import { getPublicClinicCatalog } from "./public-catalog";
import { getStaffSnapshot } from "./staff-repository";
import {
  clinicRegistrationSchema,
  registerClinic,
} from "./clinic-registration";
import { createStaffResource, createStaffService } from "./staff-operations";
import { updateStaffPractitioner } from "./staff-team";
import { rescheduleAffectedAppointments } from "./timing-automation";

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import type { PublicBookingInput } from "@/lib/contracts";
import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

vi.mock("server-only", () => ({}));

import {
  createAppointment,
  createStaffAppointment,
  listAvailability,
  manageAppointment,
  mutateStaffAppointment,
  recordHeardFrom,
  updateAppointmentStatus,
} from "@/server/appointment-repository";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const localDatabase = (url: string | undefined): boolean => {
  if (!url) return false;
  const parsed = new URL(url);
  return (
    parsed.hostname === "127.0.0.1" &&
    ["5544", "5545"].includes(parsed.port) &&
    ["/kalendr_local", "/nira_local"].includes(parsed.pathname) // nira_local: a local cluster made before the rename (see scripts/local-db.sh)
  );
};
const describeLocal =
  localDatabase(runtimeUrl) &&
  localDatabase(ownerUrl) &&
  process.env.KALENDR_PREVIEW_MODE === "false"
    ? describe
    : describe.skip;

describeLocal("database appointment correctness", () => {
  it("creates an owner clinic, requires reviewed hours, and becomes bookable after setup", async () => {
    const owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const slug = `onboarding-${randomUUID().slice(0, 8)}`;
    const email = `${slug}@example.com`;
    let tenantId = "";
    try {
      const input = clinicRegistrationSchema.parse({
        clinicName: "Onboarding Test Dental",
        slug,
        ownerName: "Test Owner",
        email,
        password: randomUUID(),
        phone: "+919000000401",
        city: "Pune",
        address: "11 Test Road, Maharashtra",
        ownerPractices: true,
        practice: {
          name: "Test Owner",
          title: "Dentist",
          specialty: "General dentistry",
        },
      });
      const created = await registerClinic(input);
      tenantId = created.tenantId;
      const [member] = await owner<
        { user_id: string; email_verified: boolean }[]
      >`select membership.user_id, auth_user.email_verified from memberships membership join auth_users auth_user on auth_user.id = membership.user_id where membership.tenant_id = ${tenantId}`;
      const context: StaffContext = {
        tenantId,
        clinicSlug: slug,
        clinicName: created.clinicName,
        role: "owner",
        permissions: resolvePermissions("owner", {}),
        membershipId: null,
        userId: member.user_id,
        userName: "Test Owner",
        userEmail: email,
        preview: false,
      };
      // A new business starts from its template (feature 11): typical services, and hours for the owner who takes bookings.
      const starter = await getStaffSnapshot(context);
      expect(starter.availability.length).toBeGreaterThan(0);
      expect(starter.setup.complete).toBe(true);
      const starterServiceCount = starter.catalog.services.length;
      expect(starterServiceCount).toBeGreaterThan(0);
      await createStaffService(context, {
        name: "Consultation",
        description: "Test visit",
        durationMinutes: 30,
        bookingMode: "request",
        requiredResourceKind: "chair",
      });
      expect((await getStaffSnapshot(context)).setup.missing).toEqual(["resource"]);
      await createStaffResource(context, { name: "Chair 1", kind: "chair" });
      const beforeHours = await getStaffSnapshot(context);
      expect(beforeHours.setup.missing).toEqual([]);
      await updateStaffPractitioner(
        context,
        beforeHours.catalog.practitioners[0].id,
        {
          hours: {
            days: [1, 2, 3, 4, 5],
            startsAtLocal: "09:00",
            endsAtLocal: "17:00",
          },
        },
      );
      expect((await getStaffSnapshot(context)).setup.complete).toBe(true);
      expect((await getPublicClinicCatalog(slug))?.services).toHaveLength(starterServiceCount + 1);
      await expect(registerClinic(input)).rejects.toMatchObject({
        status: 409,
        code: "slug_taken",
      });
    } finally {
      if (tenantId) await owner`delete from tenants where id = ${tenantId}`;
      await owner`delete from auth_users where email = ${email}`;
      await owner.end();
    }
  });
  it("keeps inactive services in staff history while hiding unbookable public choices", async () => {
    const owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const inactiveServiceId = randomUUID();
    const unlinkedServiceId = randomUUID();
    try {
      const [tenant] = await owner<
        { id: string; name: string }[]
      >`select id, name from tenants where slug = 'lotus-dental'`;
      if (!tenant)
        throw new Error("Seed the isolated local database before this test");
      await owner`
        insert into services (id, tenant_id, name, description, duration_minutes, booking_mode, patient_types, is_active)
        values (${inactiveServiceId}, ${tenant.id}, 'Historical service test', 'Test only', 30, 'instant', array['new','returning'], false),
          (${unlinkedServiceId}, ${tenant.id}, 'Unlinked service test', 'Test only', 30, 'instant', array['new','returning'], true)
      `;
      const catalog = await getPublicClinicCatalog("lotus-dental");
      expect(
        catalog?.services.some(
          (service) =>
            service.id === inactiveServiceId ||
            service.id === unlinkedServiceId,
        ),
      ).toBe(false);
      const context: StaffContext = {
        tenantId: tenant.id,
        clinicSlug: "lotus-dental",
        clinicName: tenant.name,
        role: "owner",
        permissions: resolvePermissions("owner", {}),
        membershipId: null,
        userId: null,
        userName: "Catalog test",
        userEmail: "catalog@example.com",
        preview: false,
      };
      const snapshot = await getStaffSnapshot(context);
      expect(snapshot.historicalNames.services[inactiveServiceId]).toBe(
        "Historical service test",
      );
      expect(
        snapshot.catalog.services.find(
          (service) => service.id === inactiveServiceId,
        )?.isActive,
      ).toBe(false);
      expect(snapshot.historicalNames.services[unlinkedServiceId]).toBe(
        "Unlinked service test",
      );
      await expect(
        getStaffSnapshot({ ...context, tenantId: randomUUID() }),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      await owner`delete from services where id in (${inactiveServiceId}, ${unlinkedServiceId})`;
      await owner.end();
    }
  });

  it("enforces booking windows, buffer conflicts, exact slots, eligibility, and versions", async () => {
    const owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const practitionerId = randomUUID();
    const serviceId = randomUUID();
    const resourceId = randomUUID();
    let tenantId = "";
    let locationId = "";
    let staffUserId = "";
    const idempotencyKeyValues: string[] = [];

    try {
      const tenants = await owner<{ id: string }[]>`
        select id from tenants where slug = 'lotus-dental' limit 1
      `;
      tenantId = tenants[0]?.id ?? "";
      if (!tenantId)
        throw new Error("Seed the isolated local database before this test");
      const locations = await owner<{ id: string }[]>`
        select id from locations where tenant_id = ${tenantId} limit 1
      `;
      locationId = locations[0]?.id ?? "";
      const memberships = await owner<{ user_id: string }[]>`
        select user_id from memberships
        where tenant_id = ${tenantId} and role = 'owner' and is_active
        limit 1
      `;
      staffUserId = memberships[0]?.user_id ?? "";
      if (!locationId || !staffUserId)
        throw new Error("Local seed is incomplete");

      await owner.begin(async (transaction) => {
        await transaction`
          insert into practitioners (id, tenant_id, name, title, initials, specialty)
          values (${practitionerId}, ${tenantId}, 'Booking Test Practitioner', 'Dentist', 'BT', 'Testing')
        `;
        await transaction`
          insert into services (
            id, tenant_id, name, description, duration_minutes,
            buffer_before_minutes, buffer_after_minutes, slot_interval_minutes,
            minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types
          ) values (
            ${serviceId}, ${tenantId}, 'Booking Test Service', 'Local integration test', 30,
            5, 10, 15, 60, 90, 'instant', ${["new", "returning"]}
          )
        `;
        await transaction`
          insert into resources (id, tenant_id, location_id, name, kind)
          values (${resourceId}, ${tenantId}, ${locationId}, 'Booking Test Chair', 'chair')
        `;
        await transaction`
          insert into service_locations (tenant_id, service_id, location_id)
          values (${tenantId}, ${serviceId}, ${locationId})
        `;
        await transaction`
          insert into practitioner_services (tenant_id, practitioner_id, service_id)
          values (${tenantId}, ${practitionerId}, ${serviceId})
        `;
        await transaction`
          insert into practitioner_locations (tenant_id, practitioner_id, location_id)
          values (${tenantId}, ${practitionerId}, ${locationId})
        `;
        for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
          await transaction`
            insert into availability_rules (
              id, tenant_id, location_id, practitioner_id, day_of_week,
              starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes
            ) values (
              ${randomUUID()}, ${tenantId}, ${locationId}, ${practitionerId}, ${dayOfWeek},
              '09:00', '17:00', 'Asia/Kolkata', '2025-01-01', 15
            )
          `;
        }
      });

      const localDay = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(Date.now() + 7 * 86_400_000));
      const at = (
        hour: number,
        minute = 0,
        second = 0,
        millisecond = 0,
      ): string =>
        `${localDay}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.${String(millisecond).padStart(3, "0")}+05:30`;
      const booking = (
        hour: number,
        minute = 0,
        second = 0,
        millisecond = 0,
      ): PublicBookingInput => ({
        clinicSlug: "lotus-dental",
        patientType: "new",
        bookingFor: "self",
        locationId,
        serviceId,
        practitionerId,
        slotId: randomUUID(),
        startsAt: at(hour, minute, second, millisecond),
        endsAt: new Date(
          new Date(at(hour, minute, second, millisecond)).getTime() +
            30 * 60_000,
        ).toISOString(),
        firstName: "Booking",
        lastName: "Test",
        phone: "+919000000099",
        email: "booking-test@example.com",
        preferredChannel: "email",
        acceptedPrivacyNotice: true,
        messagingConsent: false,
      });
      const create = (input: PublicBookingInput) => {
        const idempotencyKey = randomUUID();
        idempotencyKeyValues.push(idempotencyKey);
        return createAppointment(
          input,
          idempotencyKey,
          randomUUID().replaceAll("-", ""),
        );
      };
      const expectSlotConflict = async (operation: () => Promise<unknown>) => {
        await expect(operation()).rejects.toMatchObject({
          status: 409,
          code: "slot_unavailable",
        });
      };

      const availability = await listAvailability({
        clinicSlug: "lotus-dental",
        locationId,
        serviceId,
        practitionerId,
        from: at(9),
        to: at(15),
      });
      expect(
        availability.some(
          (slot) => slot.startsAt === new Date(at(10)).toISOString(),
        ),
      ).toBe(true);
      expect(
        availability.some(
          (slot) => slot.startsAt === new Date(at(9)).toISOString(),
        ),
      ).toBe(false);

      const created = await create(booking(10));
      const bookingSnapshot = await getStaffSnapshot({
        tenantId,
        clinicSlug: "lotus-dental",
        clinicName: "Lotus Dental Studio",
        role: "owner",
        permissions: resolvePermissions("owner", {}),
        membershipId: null,
        userId: staffUserId,
        userName: "Test staff",
        userEmail: "staff@example.com",
        preview: false,
      });
      expect(
        bookingSnapshot.appointments.find(
          (item) => item.id === created.appointmentId,
        ),
      ).toMatchObject({
        startsAt: new Date(at(10)).toISOString(),
        endsAt: new Date(at(10, 30)).toISOString(),
      });
      const reservations = await owner<{ starts_at: Date; ends_at: Date }[]>`
        select starts_at, ends_at from resource_reservations
        where appointment_id = ${created.appointmentId} and state = 'confirmed'
      `;
      expect(reservations).toHaveLength(1);
      expect(reservations[0]!.starts_at.toISOString()).toBe(
        new Date(at(9, 55)).toISOString(),
      );
      expect(reservations[0]!.ends_at.toISOString()).toBe(
        new Date(at(10, 40)).toISOString(),
      );

      await expectSlotConflict(() => create(booking(10, 30)));
      await expectSlotConflict(() => create(booking(11, 0, 59)));
      await expectSlotConflict(() => create(booking(11, 0, 0, 1)));
      await expectSlotConflict(() => create(booking(9)));
      const afterBooking = await listAvailability({
        clinicSlug: "lotus-dental",
        locationId,
        serviceId,
        practitionerId,
        from: at(9),
        to: at(15),
      });
      expect(
        afterBooking.some(
          (slot) => slot.startsAt === new Date(at(10, 30)).toISOString(),
        ),
      ).toBe(false);
      expect(
        afterBooking.some(
          (slot) => slot.startsAt === new Date(at(10, 45)).toISOString(),
        ),
      ).toBe(true);

      await owner`update services set minimum_lead_minutes = 20160 where id = ${serviceId}`;
      await expectSlotConflict(() => create(booking(12)));
      await owner`update services set minimum_lead_minutes = 60, maximum_advance_days = 1 where id = ${serviceId}`;
      await expectSlotConflict(() => create(booking(12)));
      await owner`update services set maximum_advance_days = 90 where id = ${serviceId}`;

      const moved = await manageAppointment(created.manageToken, {
        action: "reschedule",
        startsAt: at(11),
        expectedVersion: 1,
      });
      expect(moved.version).toBe(2);
      // Moving a booking gives it a new link (feature 8); the old one stops working.
      let liveToken = moved.manageToken ?? created.manageToken;
      expect(liveToken).not.toBe(created.manageToken);
      await expect(manageAppointment(created.manageToken, { action: "confirm", expectedVersion: 2 })).rejects.toMatchObject({ status: 404 });
      await expect(
        manageAppointment(liveToken, {
          action: "reschedule",
          startsAt: at(12),
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ status: 409, code: "version_conflict" });
      await owner`update services set is_active = false where id = ${serviceId}`;
      await expectSlotConflict(() =>
        manageAppointment(liveToken, {
          action: "reschedule",
          startsAt: at(12),
          expectedVersion: 2,
        }),
      );
      await owner`update services set is_active = true, required_resource_kind = 'chair' where id = ${serviceId}`;
      const withChair = await manageAppointment(liveToken, {
        action: "reschedule",
        startsAt: at(12),
        expectedVersion: 2,
      });
      expect(withChair.version).toBe(3);
      liveToken = withChair.manageToken ?? liveToken;
      const withChairReservations = await owner<
        { resource_id: string | null }[]
      >`
        select resource_id from resource_reservations
        where appointment_id = ${created.appointmentId} and state = 'confirmed'
      `;
      expect(withChairReservations).toHaveLength(2);
      expect(
        withChairReservations.some((row) => row.resource_id !== null),
      ).toBe(true);
      await owner`update services set required_resource_kind = null where id = ${serviceId}`;
      const withoutChair = await manageAppointment(liveToken, {
        action: "reschedule",
        startsAt: at(13),
        expectedVersion: 3,
      });
      expect(withoutChair.version).toBe(4);
      const withoutChairReservations = await owner<
        { resource_id: string | null }[]
      >`
        select resource_id from resource_reservations
        where appointment_id = ${created.appointmentId} and state = 'confirmed'
      `;
      expect(withoutChairReservations).toHaveLength(1);
      expect(withoutChairReservations[0]!.resource_id).toBeNull();

      const noShow = await updateAppointmentStatus(
        staffUserId,
        created.appointmentId,
        {
          status: "no_show",
          expectedVersion: 4,
        },
      );
      expect(noShow.version).toBe(5);
      const active = await owner<{ count: number }[]>`
        select count(*)::int as count from resource_reservations
        where appointment_id = ${created.appointmentId} and state in ('held', 'confirmed')
      `;
      expect(active[0]?.count).toBe(0);

      const cancellable = await create(booking(16));
      const confirmed = await manageAppointment(cancellable.manageToken, {
        action: "confirm",
        expectedVersion: 1,
      });
      expect(confirmed).toMatchObject({
        version: 2,
        startsAt: new Date(at(16)).toISOString(),
      });
      const [confirmedRow] = await owner<
        { confirmation_status: string }[]
      >`select confirmation_status from appointments where id = ${cancellable.appointmentId}`;
      expect(confirmedRow?.confirmation_status).toBe("confirmed");
      // "How did you hear about us" is saved once; a second answer doesn't overwrite it.
      await expect(recordHeardFrom(cancellable.manageToken, "friend")).resolves.toEqual({ saved: true });
      await expect(recordHeardFrom(cancellable.manageToken, "search")).resolves.toEqual({ saved: false });
      const [heardRow] = await owner<{ heard_from: string | null }[]>`select heard_from from appointments where id = ${cancellable.appointmentId}`;
      expect(heardRow?.heard_from).toBe("friend");
      const cancelled = await manageAppointment(cancellable.manageToken, {
        action: "cancel",
        expectedVersion: 2,
        reason: "Integration verification",
      });
      expect(cancelled).toMatchObject({
        status: "cancelled",
        version: 3,
        startsAt: new Date(at(16)).toISOString(),
      });
      const released = await owner<{ count: number }[]>`
        select count(*)::int as count from resource_reservations
        where appointment_id = ${cancellable.appointmentId} and state in ('held', 'confirmed')
      `;
      expect(released[0]?.count).toBe(0);

      const staffContext: StaffContext = {
        tenantId,
        clinicSlug: "lotus-dental",
        clinicName: "Lotus Dental Studio",
        role: "owner",
        permissions: resolvePermissions("owner", {}),
        membershipId: null,
        userId: staffUserId,
        userName: "Local owner",
        userEmail: "kalendr.owner@example.com",
        preview: false,
      };
      const existingPatient = await owner<{ patient_id: string }[]>`
        select patient_id from appointments where id = ${created.appointmentId}
      `;
      const patientId = existingPatient[0]!.patient_id;
      const existingPatientInput = {
        clinicSlug: "lotus-dental",
        locationId,
        serviceId,
        practitionerId,
        startsAt: at(14),
        source: "desk" as const,
        patientId,
      };
      const staffKey = randomUUID();
      idempotencyKeyValues.push(staffKey);
      const staffHash = randomUUID().replaceAll("-", "");
      const staffCreated = await createStaffAppointment(
        staffContext,
        existingPatientInput,
        staffKey,
        staffHash,
      );
      expect(staffCreated.patientId).toBe(patientId);
      expect(
        await createStaffAppointment(
          staffContext,
          existingPatientInput,
          staffKey,
          staffHash,
        ),
      ).toEqual(staffCreated);
      await expect(
        createStaffAppointment(
          staffContext,
          existingPatientInput,
          staffKey,
          "different-hash",
        ),
      ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
      const linkedPatient = await owner<
        { patient_id: string; booking_source: string }[]
      >`
        select patient_id, booking_source from appointments where id = ${staffCreated.appointmentId}
      `;
      expect(linkedPatient[0]).toMatchObject({
        patient_id: patientId,
        booking_source: "staff",
      });

      const newPatientInput = {
        clinicSlug: "lotus-dental",
        locationId,
        serviceId,
        practitionerId,
        startsAt: at(15),
        source: "desk" as const,
        newPatient: {
          firstName: "Staff",
          lastName: "Created",
          phone: "+919000000098",
          email: "staff-booking-test@example.com",
          preferredChannel: "sms" as const,
          isDependent: false,
          messagingConsent: false,
        },
      };
      const newStaffKey = randomUUID();
      idempotencyKeyValues.push(newStaffKey);
      const newPatientCreated = await createStaffAppointment(
        staffContext,
        newPatientInput,
        newStaffKey,
        randomUUID().replaceAll("-", ""),
      );
      const newlyLinkedPatient = await owner<{ patient_id: string }[]>`
        select patient_id from appointments where id = ${newPatientCreated.appointmentId}
      `;
      expect(newlyLinkedPatient[0]?.patient_id).toBe(
        newPatientCreated.patientId,
      );
      await expectSlotConflict(() =>
        createStaffAppointment(
          staffContext,
          { ...newPatientInput, startsAt: at(15, 15) },
          randomUUID(),
          randomUUID().replaceAll("-", ""),
        ),
      );
      await expect(
        createStaffAppointment(
          staffContext,
          {
            ...existingPatientInput,
            startsAt: at(16),
            patientId: randomUUID(),
          },
          randomUUID(),
          randomUUID().replaceAll("-", ""),
        ),
      ).rejects.toMatchObject({ status: 404, code: "patient_not_found" });
    } finally {
      if (tenantId) {
        await owner.begin(async (transaction) => {
          const patients = await transaction<{ patient_id: string }[]>`
            select patient_id from appointments where service_id = ${serviceId}
          `;
          await transaction`delete from audit_events where appointment_id in (select id from appointments where service_id = ${serviceId})`;
          await transaction`delete from outbox_events where tenant_id = ${tenantId} and aggregate_id in (select id from appointments where service_id = ${serviceId})`;
          await transaction`delete from appointments where service_id = ${serviceId}`;
          if (idempotencyKeyValues.length) {
            await transaction`delete from idempotency_keys where tenant_id = ${tenantId} and route in ('/api/public/appointments', '/api/staff/appointments') and key in ${transaction(idempotencyKeyValues)}`;
          }
          if (patients.length)
            await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id in ${transaction(patients.map((patient) => patient.patient_id))})`;
            await transaction`delete from patients where id in ${transaction(patients.map((patient) => patient.patient_id))}`;
          await transaction`delete from availability_rules where practitioner_id = ${practitionerId}`;
          await transaction`delete from practitioner_services where practitioner_id = ${practitionerId}`;
          await transaction`delete from practitioner_locations where practitioner_id = ${practitionerId}`;
          await transaction`delete from service_locations where service_id = ${serviceId}`;
          await transaction`delete from resources where id = ${resourceId}`;
          await transaction`delete from services where id = ${serviceId}`;
          await transaction`delete from practitioners where id = ${practitionerId}`;
        });
      }
      await owner.end();
    }
  }, 30_000);

  it("hides public slots that overlap saved leave or closed time", async () => {
    const owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const practitionerId = randomUUID();
    const serviceId = randomUUID();
    const blockId = randomUUID();
    let tenantId = "";
    let locationId = "";
    try {
      const tenants = await owner<
        { id: string }[]
      >`select id from tenants where slug = 'lotus-dental' limit 1`;
      tenantId = tenants[0]?.id ?? "";
      if (!tenantId)
        throw new Error("Seed the isolated local database before this test");
      const locations = await owner<
        { id: string }[]
      >`select id from locations where tenant_id = ${tenantId} limit 1`;
      locationId = locations[0]?.id ?? "";
      await owner.begin(async (transaction) => {
        await transaction`insert into practitioners (id, tenant_id, name, title, initials, specialty) values (${practitionerId}, ${tenantId}, 'Leave Test Practitioner', 'Dentist', 'LT', 'Testing')`;
        await transaction`insert into services (id, tenant_id, name, description, duration_minutes, buffer_before_minutes, buffer_after_minutes, slot_interval_minutes, minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types) values (${serviceId}, ${tenantId}, 'Leave Test Service', 'Local integration test', 30, 0, 0, 15, 60, 90, 'instant', ${["new", "returning"]})`;
        await transaction`insert into service_locations (tenant_id, service_id, location_id) values (${tenantId}, ${serviceId}, ${locationId})`;
        await transaction`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${tenantId}, ${practitionerId}, ${serviceId})`;
        await transaction`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${tenantId}, ${practitionerId}, ${locationId})`;
        for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
          await transaction`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes) values (${randomUUID()}, ${tenantId}, ${locationId}, ${practitionerId}, ${dayOfWeek}, '09:00', '17:00', 'Asia/Kolkata', '2025-01-01', 15)`;
        }
      });
      const localDay = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(Date.now() + 7 * 86_400_000));
      const at = (hour: number, minute = 0): string =>
        `${localDay}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000+05:30`;
      const query = {
        clinicSlug: "lotus-dental",
        locationId,
        serviceId,
        practitionerId,
        from: at(11),
        to: at(14),
      };
      const open = await listAvailability(query);
      expect(
        open.some((slot) => slot.startsAt === new Date(at(12)).toISOString()),
      ).toBe(true);
      await owner`insert into schedule_blocks (id, tenant_id, location_id, practitioner_id, starts_at, ends_at, reason) values (${blockId}, ${tenantId}, ${locationId}, ${practitionerId}, ${at(12)}, ${at(13)}, 'Leave')`;
      const closed = await listAvailability(query);
      expect(
        closed.some((slot) => slot.startsAt === new Date(at(12)).toISOString()),
      ).toBe(false);
      expect(
        closed.some(
          (slot) => slot.startsAt === new Date(at(11, 30)).toISOString(),
        ),
      ).toBe(true);
    } finally {
      if (tenantId) {
        await owner.begin(async (transaction) => {
          await transaction`delete from schedule_blocks where id = ${blockId}`;
          await transaction`delete from availability_rules where practitioner_id = ${practitionerId}`;
          await transaction`delete from practitioner_services where practitioner_id = ${practitionerId}`;
          await transaction`delete from practitioner_locations where practitioner_id = ${practitionerId}`;
          await transaction`delete from service_locations where service_id = ${serviceId}`;
          await transaction`delete from services where id = ${serviceId}`;
          await transaction`delete from practitioners where id = ${practitionerId}`;
        });
      }
      await owner.end();
    }
  }, 30_000);

  it("moves bookings when a doctor's hours shrink, and keeps private profile fields out of the public catalog", async () => {
    const owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const practitionerId = randomUUID();
    const serviceId = randomUUID();
    const keys: string[] = [];
    let tenantId = "";
    let locationId = "";
    try {
      const tenants = await owner<{ id: string; name: string }[]>`select id, name from tenants where slug = 'lotus-dental' limit 1`;
      tenantId = tenants[0]?.id ?? "";
      if (!tenantId) throw new Error("Seed the isolated local database before this test");
      locationId = (await owner<{ id: string }[]>`select id from locations where tenant_id = ${tenantId} limit 1`)[0]!.id;
      await owner.begin(async (transaction) => {
        await transaction`insert into practitioners (id, tenant_id, name, title, initials, specialty) values (${practitionerId}, ${tenantId}, 'Timing Test Doctor', 'Dentist', 'TT', 'Testing')`;
        await transaction`insert into services (id, tenant_id, name, description, duration_minutes, buffer_before_minutes, buffer_after_minutes, slot_interval_minutes, minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types) values (${serviceId}, ${tenantId}, 'Timing Test Service', 'Local integration test', 30, 0, 0, 15, 60, 90, 'instant', ${["new", "returning"]})`;
        await transaction`insert into service_locations (tenant_id, service_id, location_id) values (${tenantId}, ${serviceId}, ${locationId})`;
        await transaction`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${tenantId}, ${practitionerId}, ${serviceId})`;
        await transaction`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${tenantId}, ${practitionerId}, ${locationId})`;
        for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
          await transaction`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes) values (${randomUUID()}, ${tenantId}, ${locationId}, ${practitionerId}, ${dayOfWeek}, '09:00', '17:00', 'Asia/Kolkata', '2025-01-01', 15)`;
        }
      });
      const context: StaffContext = {
        tenantId,
        clinicSlug: "lotus-dental",
        clinicName: tenants[0]!.name,
        role: "owner",
        permissions: resolvePermissions("owner", {}),
        membershipId: null,
        userId: (await owner<{ user_id: string }[]>`select user_id from memberships where tenant_id = ${tenantId} and role = 'owner' limit 1`)[0]!.user_id,
        userName: "Timing test",
        userEmail: "timing@example.com",
        preview: false,
      };
      const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 7 * 86_400_000));
      const at = (hour: number, minute = 0): string =>
        `${localDay}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000+05:30`;
      const book = async (startsAt: string, phone: string, preferredChannel: "whatsapp" | "phone") => {
        const key = randomUUID();
        keys.push(key);
        return createStaffAppointment(context, {
          clinicSlug: "lotus-dental",
          locationId,
          serviceId,
          practitionerId,
          startsAt,
          source: "desk",
          newPatient: { firstName: "Timing", lastName: "Patient", phone, email: `${phone.slice(1)}@example.com`, preferredChannel, isDependent: false, messagingConsent: false },
        }, key, randomUUID().replaceAll("-", ""));
      };
      const inside = await book(at(10), "+919000000301", "whatsapp");
      const outside = await book(at(15), "+919000000302", "whatsapp");

      await updateStaffPractitioner(context, practitionerId, {
        hours: { days: [1, 2, 3, 4, 5, 6, 7], startsAtLocal: "09:00", endsAtLocal: "12:00" },
        photoDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        bio: "Gentle with nervous patients.",
        experienceYears: 12,
        phone: "+919000000399",
        registrationNumber: "KMC-1234",
      });
      const timing = await rescheduleAffectedAppointments(context, practitionerId);
      expect(timing.unresolved).toEqual([]);
      expect(timing.moved).toEqual([
        { appointmentId: outside.appointmentId, from: new Date(at(15)).toISOString(), to: new Date(at(11, 30)).toISOString() },
      ]);

      const rows = await owner<{ id: string; starts_at: Date; clinic_moved_from: Date | null; confirmation_status: string }[]>`
        select id, starts_at, clinic_moved_from, confirmation_status from appointments where service_id = ${serviceId}`;
      const moved = rows.find((row) => row.id === outside.appointmentId)!;
      expect(moved.starts_at.toISOString()).toBe(new Date(at(11, 30)).toISOString());
      expect(moved.clinic_moved_from?.toISOString()).toBe(new Date(at(15)).toISOString());
      expect(moved.confirmation_status).toBe("needs_action");
      const untouched = rows.find((row) => row.id === inside.appointmentId)!;
      expect(untouched.starts_at.toISOString()).toBe(new Date(at(10)).toISOString());
      expect(untouched.clinic_moved_from).toBeNull();
      const events = await owner<{ event_type: string }[]>`
        select event_type from outbox_events where tenant_id = ${tenantId} and aggregate_id = ${outside.appointmentId} and event_type = 'appointment.reschedule'`;
      expect(events).toHaveLength(1);
      expect(await rescheduleAffectedAppointments(context, practitionerId)).toEqual({ moved: [], unresolved: [] });

      const staffDoctor = (await getStaffSnapshot(context)).catalog.practitioners.find((row) => row.id === practitionerId);
      // The photo is now a stored picture with its own address, not a data URL in the row.
      expect(staffDoctor?.photoUrl).toMatch(/^\/api\/public\/media\/lotus-dental\/[0-9a-f-]+$/);
      expect(staffDoctor).toMatchObject({ experienceYears: 12, phone: "+919000000399", registrationNumber: "KMC-1234" });
      const publicDoctor = (await getPublicClinicCatalog("lotus-dental"))?.practitioners.find((row) => row.id === practitionerId);
      expect(publicDoctor).toMatchObject({ bio: "Gentle with nervous patients.", experienceYears: 12 });
      expect(publicDoctor).not.toHaveProperty("phone");
      expect(publicDoctor).not.toHaveProperty("registrationNumber");
    } finally {
      if (tenantId) {
        await owner.begin(async (transaction) => {
          const patients = await transaction<{ patient_id: string }[]>`select patient_id from appointments where service_id = ${serviceId}`;
          await transaction`delete from audit_events where appointment_id in (select id from appointments where service_id = ${serviceId})`;
          await transaction`delete from outbox_events where tenant_id = ${tenantId} and aggregate_id in (select id from appointments where service_id = ${serviceId})`;
          await transaction`delete from appointments where service_id = ${serviceId}`;
          if (keys.length) await transaction`delete from idempotency_keys where tenant_id = ${tenantId} and key in ${transaction(keys)}`;
          if (patients.length) await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id in ${transaction(patients.map((patient) => patient.patient_id))})`;
          if (patients.length) await transaction`delete from patients where id in ${transaction(patients.map((patient) => patient.patient_id))}`;
          await transaction`delete from availability_rules where practitioner_id = ${practitionerId}`;
          await transaction`delete from practitioner_services where practitioner_id = ${practitionerId}`;
          await transaction`delete from practitioner_locations where practitioner_id = ${practitionerId}`;
          await transaction`delete from service_locations where service_id = ${serviceId}`;
          await transaction`delete from services where id = ${serviceId}`;
          await transaction`delete from practitioners where id = ${practitionerId}`;
        });
      }
      await owner.end();
    }
  }, 30_000);

  it("lets staff change a visit's length by dragging its end, refuses a clash or a silly length, and records who is told", async () => {
    const owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const practitionerId = randomUUID();
    const serviceId = randomUUID();
    const keys: string[] = [];
    let tenantId = "";
    try {
      const tenants = await owner<{ id: string; name: string }[]>`select id, name from tenants where slug = 'lotus-dental' limit 1`;
      tenantId = tenants[0]?.id ?? "";
      if (!tenantId) throw new Error("Seed the isolated local database before this test");
      const locationId = (await owner<{ id: string }[]>`select id from locations where tenant_id = ${tenantId} limit 1`)[0]!.id;
      await owner.begin(async (transaction) => {
        await transaction`insert into practitioners (id, tenant_id, name, title, initials, specialty) values (${practitionerId}, ${tenantId}, 'Resize Test Doctor', 'Dentist', 'RT', 'Testing')`;
        await transaction`
          insert into services (id, tenant_id, name, description, duration_minutes, buffer_before_minutes, buffer_after_minutes, slot_interval_minutes, minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types)
          values (${serviceId}, ${tenantId}, 'Resize Test Service', 'Local integration test', 30, 0, 0, 15, 60, 90, 'instant', ${["new", "returning"]})`;
        await transaction`insert into service_locations (tenant_id, service_id, location_id) values (${tenantId}, ${serviceId}, ${locationId})`;
        await transaction`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${tenantId}, ${practitionerId}, ${serviceId})`;
        await transaction`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${tenantId}, ${practitionerId}, ${locationId})`;
        for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
          await transaction`
            insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
            values (${randomUUID()}, ${tenantId}, ${locationId}, ${practitionerId}, ${dayOfWeek}, '09:00', '17:00', 'Asia/Kolkata', '2025-01-01', 15)`;
        }
      });
      const context: StaffContext = {
        tenantId,
        clinicSlug: "lotus-dental",
        clinicName: tenants[0]!.name,
        role: "owner",
        permissions: resolvePermissions("owner", {}),
        membershipId: null,
        userId: (await owner<{ user_id: string }[]>`select user_id from memberships where tenant_id = ${tenantId} and role = 'owner' limit 1`)[0]!.user_id,
        userName: "Resize test",
        userEmail: "resize@example.com",
        preview: false,
      };
      const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 8 * 86_400_000));
      const at = (hour: number, minute = 0): string => `${localDay}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000+05:30`;
      const book = (startsAt: string, phone: string) => {
        const key = randomUUID();
        keys.push(key);
        return createStaffAppointment(context, {
          clinicSlug: "lotus-dental", locationId, serviceId, practitionerId, startsAt, source: "desk",
          newPatient: { firstName: "Resize", lastName: "Patient", phone, email: `${phone.slice(1)}@example.com`, preferredChannel: "email", isDependent: false, messagingConsent: false },
        }, key, randomUUID().replaceAll("-", ""));
      };
      const first = await book(at(10), "+919000000501");
      const second = await book(at(11), "+919000000502");

      // A longer visit: the start stays, the end moves, the version goes up and a change event is queued.
      const longer = await mutateStaffAppointment(context, first.appointmentId, { action: "resize", endsAt: at(10, 45), expectedVersion: 1 });
      expect(longer.version).toBe(2);
      const [row] = await owner<{ starts_at: Date; ends_at: Date }[]>`select starts_at, ends_at from appointments where id = ${first.appointmentId}`;
      expect(row.starts_at.toISOString()).toBe(new Date(at(10)).toISOString());
      expect(row.ends_at.toISOString()).toBe(new Date(at(10, 45)).toISOString());
      const reservations = await owner<{ ends_at: Date }[]>`select ends_at from resource_reservations where appointment_id = ${first.appointmentId} and practitioner_id = ${practitionerId} and state in ('held', 'confirmed')`;
      expect(reservations.map((reservation) => reservation.ends_at.toISOString())).toEqual([new Date(at(10, 45)).toISOString()]);
      expect(await owner`select 1 from outbox_events where aggregate_id = ${first.appointmentId} and event_type = 'appointment.resize'`).toHaveLength(1);

      // Into the next visit: refused, and nothing changed.
      await expect(mutateStaffAppointment(context, first.appointmentId, { action: "resize", endsAt: at(11, 15), expectedVersion: 2 })).rejects.toMatchObject({ status: 409, code: "slot_unavailable" });
      expect((await owner<{ version: number }[]>`select version from appointments where id = ${first.appointmentId}`)[0]!.version).toBe(2);

      // Too short, too long, and a stale version.
      await expect(mutateStaffAppointment(context, first.appointmentId, { action: "resize", endsAt: at(10, 2), expectedVersion: 2 })).rejects.toMatchObject({ status: 400 });
      await expect(mutateStaffAppointment(context, first.appointmentId, { action: "resize", endsAt: `${localDay}T23:00:00.000+05:30`, expectedVersion: 2 })).rejects.toMatchObject({ status: 400 });
      await expect(mutateStaffAppointment(context, first.appointmentId, { action: "resize", endsAt: at(10, 30), expectedVersion: 1 })).rejects.toMatchObject({ status: 409, code: "version_conflict" });

      // Staff who choose not to tell the customer: the choice is written down for the worker, in the queue and in the audit trail.
      await mutateStaffAppointment(context, second.appointmentId, { action: "reschedule", startsAt: at(14), practitionerId, expectedVersion: 1, notifyCustomer: false });
      const [event] = await owner<{ payload: { notifyCustomer?: boolean } }[]>`select payload from outbox_events where aggregate_id = ${second.appointmentId} and event_type = 'appointment.reschedule'`;
      expect(event.payload.notifyCustomer).toBe(false);
      const [audit] = await owner<{ metadata: { notifyCustomer?: boolean } }[]>`select metadata from audit_events where appointment_id = ${second.appointmentId} and action = 'appointment.reschedule'`;
      expect(audit.metadata.notifyCustomer).toBe(false);
      // The default still tells them: no flag at all.
      await mutateStaffAppointment(context, second.appointmentId, { action: "reschedule", startsAt: at(15), practitionerId, expectedVersion: 2 });
      const events = await owner<{ payload: { notifyCustomer?: boolean } }[]>`select payload from outbox_events where aggregate_id = ${second.appointmentId} and event_type = 'appointment.reschedule' order by created_at`;
      expect(events[1]?.payload.notifyCustomer).toBeUndefined();
    } finally {
      if (tenantId) {
        await owner.begin(async (transaction) => {
          const patients = await transaction<{ patient_id: string }[]>`select patient_id from appointments where service_id = ${serviceId}`;
          await transaction`delete from audit_events where appointment_id in (select id from appointments where service_id = ${serviceId})`;
          await transaction`delete from outbox_events where tenant_id = ${tenantId} and aggregate_id in (select id from appointments where service_id = ${serviceId})`;
          await transaction`delete from appointments where service_id = ${serviceId}`;
          if (keys.length) await transaction`delete from idempotency_keys where tenant_id = ${tenantId} and key in ${transaction(keys)}`;
          if (patients.length) await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id in ${transaction(patients.map((patient) => patient.patient_id))})`;
          if (patients.length) await transaction`delete from patients where id in ${transaction(patients.map((patient) => patient.patient_id))}`;
          await transaction`delete from availability_rules where practitioner_id = ${practitionerId}`;
          await transaction`delete from practitioner_services where practitioner_id = ${practitionerId}`;
          await transaction`delete from practitioner_locations where practitioner_id = ${practitionerId}`;
          await transaction`delete from service_locations where service_id = ${serviceId}`;
          await transaction`delete from services where id = ${serviceId}`;
          await transaction`delete from practitioners where id = ${practitionerId}`;
        });
      }
      await owner.end();
    }
  }, 30_000);
});
