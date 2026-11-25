/** @vitest-environment node */

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
} from "@/server/appointment-repository";
import { updateStaffPatient } from "@/server/staff-operations";

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

describeLocal("booking sources, returning patients and walk-ins", () => {
  it("records where bookings came from, reuses returning patients, checks in walk-ins and audits patient edits", async () => {
    const owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const practitionerId = randomUUID();
    const serviceId = randomUUID();
    let tenantId = "";
    let locationId = "";
    let staffUserId = "";
    const idempotencyKeyValues: string[] = [];
    const extraPatientIds: string[] = [];

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
          values (${practitionerId}, ${tenantId}, 'Source Test Practitioner', 'Dentist', 'ST', 'Testing')
        `;
        await transaction`
          insert into services (
            id, tenant_id, name, description, duration_minutes,
            buffer_before_minutes, buffer_after_minutes, slot_interval_minutes,
            minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types
          ) values (
            ${serviceId}, ${tenantId}, 'Source Test Service', 'Local integration test', 15,
            0, 0, 15, 120, 90, 'instant', ${["new", "returning"]}
          )
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
        // Open around the clock so walk-in openings exist whenever the test runs.
        for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
          await transaction`
            insert into availability_rules (
              id, tenant_id, location_id, practitioner_id, day_of_week,
              starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes
            ) values (
              ${randomUUID()}, ${tenantId}, ${locationId}, ${practitionerId}, ${dayOfWeek},
              '00:00', '23:45', 'Asia/Kolkata', '2025-01-01', 15
            )
          `;
        }
      });

      const localDay = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(Date.now() + 10 * 86_400_000));
      const at = (hour: number, minute = 0): string =>
        `${localDay}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000+05:30`;
      const booking = (
        hour: number,
        overrides: Partial<PublicBookingInput> = {},
      ): PublicBookingInput => ({
        clinicSlug: "lotus-dental",
        patientType: "new",
        bookingFor: "self",
        locationId,
        serviceId,
        practitionerId,
        slotId: randomUUID(),
        startsAt: at(hour),
        endsAt: new Date(new Date(at(hour)).getTime() + 15 * 60_000).toISOString(),
        firstName: "Source",
        lastName: "Tester",
        phone: "+91 90000 00077",
        email: "source-test@example.com",
        preferredChannel: "email",
        accessibilityNeed: "Step-free access",
        acceptedPrivacyNotice: true,
        messagingConsent: false,
        ...overrides,
      });
      const create = (input: PublicBookingInput) => {
        const key = randomUUID();
        idempotencyKeyValues.push(key);
        return createAppointment(input, key, randomUUID().replaceAll("-", ""));
      };

      // A hosted booking with no origin is "online"; a widget booking keeps its referrer and UTM tags.
      const first = await create(booking(10, { reasonForVisit: "Sensitive tooth" }));
      const second = await create(
        booking(11, {
          patientType: "returning",
          firstName: "  source ",
          lastName: "TESTER",
          phone: "+919000000077",
          email: "Source-Test@Example.com",
          dateOfBirth: "1990-04-12",
          accessibilityNeed: "Different need",
          messagingConsent: true,
          origin: {
            channel: "widget",
            referrerHost: "www.example-dental.com",
            utmSource: "google",
            utmMedium: "cpc",
            utmCampaign: "spring",
          },
        }),
      );
      const iframe = await create(
        booking(12, {
          firstName: "Other",
          origin: { channel: "iframe" },
        }),
      );

      const rows = await owner<
        {
          id: string;
          patient_id: string;
          booking_source: string;
          reason_for_visit: string | null;
          referrer_host: string | null;
          utm_source: string | null;
          utm_medium: string | null;
          utm_campaign: string | null;
        }[]
      >`
        select id, patient_id, booking_source, reason_for_visit, referrer_host,
          utm_source, utm_medium, utm_campaign
        from appointments where service_id = ${serviceId}
      `;
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(first.appointmentId)).toMatchObject({
        booking_source: "online",
        reason_for_visit: "Sensitive tooth",
        referrer_host: null,
      });
      expect(byId.get(second.appointmentId)).toMatchObject({
        booking_source: "widget",
        reason_for_visit: null,
        referrer_host: "www.example-dental.com",
        utm_source: "google",
        utm_medium: "cpc",
        utm_campaign: "spring",
      });
      expect(byId.get(iframe.appointmentId)?.booking_source).toBe("iframe");

      // Same name, email and phone (ignoring case and spacing) is the same patient: gaps are
      // filled and consent updated, but saved details are never overwritten from the public form.
      const firstPatientId = byId.get(first.appointmentId)!.patient_id;
      expect(byId.get(second.appointmentId)?.patient_id).toBe(firstPatientId);
      expect(byId.get(iframe.appointmentId)?.patient_id).not.toBe(firstPatientId);
      const [matched] = await owner<
        {
          first_name: string;
          date_of_birth: string | null;
          accessibility_need: string | null;
          messaging_consent_at: Date | null;
        }[]
      >`
        select first_name, date_of_birth::text as date_of_birth, accessibility_need, messaging_consent_at
        from patients where id = ${firstPatientId}
      `;
      expect(matched).toMatchObject({
        first_name: "Source",
        date_of_birth: "1990-04-12",
        accessibility_need: "Step-free access",
      });
      expect(matched?.messaging_consent_at).toBeInstanceOf(Date);
      const [createdAudit] = await owner<{ metadata: Record<string, unknown> }[]>`
        select metadata from audit_events
        where appointment_id = ${second.appointmentId} and action = 'appointment.created'
      `;
      expect(createdAudit?.metadata).toMatchObject({
        channel: "widget",
        patientMatch: "returning",
      });

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

      // Walk-in openings ignore the two-hour lead time; public openings in the same window do not.
      const now = Date.now();
      const window = {
        clinicSlug: "lotus-dental",
        locationId,
        serviceId,
        practitionerId,
        from: new Date(now - 15 * 60_000).toISOString(),
        to: new Date(now + 3 * 3_600_000).toISOString(),
      };
      const walkInSlots = await listAvailability(window, { walkIn: true });
      const publicSlots = await listAvailability(window);
      expect(walkInSlots.length).toBeGreaterThan(0);
      const earliestWalkIn = new Date(walkInSlots[0]!.startsAt).getTime();
      expect(earliestWalkIn).toBeLessThan(now + 2 * 3_600_000);
      expect(earliestWalkIn).toBeGreaterThanOrEqual(now - 15 * 60_000);
      expect(
        publicSlots.every(
          (slot) => new Date(slot.startsAt).getTime() >= now + 2 * 3_600_000,
        ),
      ).toBe(true);

      // The service can be met in person or by phone. The desk never asks, so it books in person at the branch;
      // a customer on the public page must choose.
      await owner`insert into service_location_options (tenant_id, service_id, kind, location_id) values (${tenantId}, ${serviceId}, 'in_person', ${locationId}), (${tenantId}, ${serviceId}, 'we_call', null)`;

      const walkInKey = randomUUID();
      idempotencyKeyValues.push(walkInKey);
      const walkIn = await createStaffAppointment(
        staffContext,
        {
          clinicSlug: "lotus-dental",
          locationId,
          serviceId,
          practitionerId,
          startsAt: walkInSlots[0]!.startsAt,
          source: "walk_in",
          reasonForVisit: "Broken filling",
          newPatient: {
            firstName: "Walk",
            lastName: "In",
            phone: "+919000000076",
            email: "walk-in-test@example.com",
            dateOfBirth: "1985-01-30",
            preferredChannel: "sms",
            isDependent: false,
            messagingConsent: true,
          },
        },
        walkInKey,
        randomUUID().replaceAll("-", ""),
      );
      extraPatientIds.push(walkIn.patientId);
      expect(walkIn.manageToken).toEqual(expect.any(String));
      const [meeting] = await owner<{ location_kind: string | null }[]>`select location_kind from appointments where id = ${walkIn.appointmentId}`;
      expect(meeting?.location_kind).toBe("in_person");
      const [walkInRow] = await owner<
        {
          status: string;
          confirmation_status: string;
          booking_source: string;
          reason_for_visit: string | null;
        }[]
      >`
        select status, confirmation_status, booking_source, reason_for_visit
        from appointments where id = ${walkIn.appointmentId}
      `;
      expect(walkInRow).toEqual({
        status: "checked_in",
        confirmation_status: "confirmed",
        booking_source: "walk_in",
        reason_for_visit: "Broken filling",
      });
      const [walkInPatient] = await owner<
        { date_of_birth: string | null; messaging_consent_at: Date | null }[]
      >`
        select date_of_birth::text as date_of_birth, messaging_consent_at
        from patients where id = ${walkIn.patientId}
      `;
      expect(walkInPatient?.date_of_birth).toBe("1985-01-30");
      expect(walkInPatient?.messaging_consent_at).toBeInstanceOf(Date);

      // A walk-in has to be now: a slot days away is refused even though it is open.
      await expect(
        createStaffAppointment(
          staffContext,
          {
            clinicSlug: "lotus-dental",
            locationId,
            serviceId,
            practitionerId,
            startsAt: at(15),
            source: "walk_in",
            patientId: firstPatientId,
          },
          randomUUID(),
          randomUUID().replaceAll("-", ""),
        ),
      ).rejects.toMatchObject({ status: 409, code: "slot_unavailable" });

      // A phone booking is recorded as such and confirmed straight away.
      const phoneKey = randomUUID();
      idempotencyKeyValues.push(phoneKey);
      const phone = await createStaffAppointment(
        staffContext,
        {
          clinicSlug: "lotus-dental",
          locationId,
          serviceId,
          practitionerId,
          startsAt: at(14),
          source: "phone",
          patientId: firstPatientId,
        },
        phoneKey,
        randomUUID().replaceAll("-", ""),
      );
      const [phoneRow] = await owner<
        { status: string; confirmation_status: string; booking_source: string }[]
      >`
        select status, confirmation_status, booking_source from appointments where id = ${phone.appointmentId}
      `;
      expect(phoneRow).toEqual({
        status: "booked",
        confirmation_status: "confirmed",
        booking_source: "phone",
      });

      // Editing a patient saves only what changed and audits field names, never values.
      const unchanged = await updateStaffPatient(staffContext, walkIn.patientId, {
        firstName: "Walk",
        email: "WALK-IN-TEST@example.com",
      });
      expect(unchanged.firstName).toBe("Walk");
      const updated = await updateStaffPatient(staffContext, walkIn.patientId, {
        lastName: "Inn",
        dateOfBirth: null,
        accessibilityNeed: "  Prefers Urdu  ",
        messagingConsent: false,
      });
      expect(updated).toMatchObject({
        lastName: "Inn",
        accessibilityNeed: "Prefers Urdu",
      });
      expect(updated.dateOfBirth).toBeUndefined();
      expect(updated.messagingConsentAt).toBeUndefined();
      const audits = await owner<{ metadata: { patientId: string; fields: string[] } }[]>`
        select metadata from audit_events
        where tenant_id = ${tenantId} and action = 'patient.updated'
          and metadata->>'patientId' = ${walkIn.patientId}
      `;
      expect(audits).toHaveLength(1);
      expect(audits[0]!.metadata.fields.sort()).toEqual(
        ["accessibilityNeed", "dateOfBirth", "lastName"].sort(),
      );
      // The consent switch goes through the consent ledger, so it is evidence and not just a field edit.
      const ledger = async () => owner<{ granted: boolean; source: string; actor_type: string }[]>`
        select granted, source, actor_type from consent_records
        where tenant_id = ${tenantId} and patient_id = ${walkIn.patientId} and purpose = 'appointment_messages'
        order by created_at, id
      `;
      expect((await ledger()).at(-1)).toEqual({ granted: false, source: "staff", actor_type: "staff" });
      expect(JSON.stringify(audits[0]!.metadata)).not.toContain("Urdu");
      // Ticking consent again from the desk stores a fresh consent time.
      const consented = await updateStaffPatient(staffContext, walkIn.patientId, {
        lastName: "Edited",
        messagingConsent: true,
      });
      expect(consented.lastName).toBe("Edited");
      expect(consented.messagingConsentAt).toEqual(expect.any(String));
      expect((await ledger()).at(-1)).toEqual({ granted: true, source: "staff", actor_type: "staff" });
      await expect(
        updateStaffPatient(staffContext, randomUUID(), { firstName: "Nobody" }),
      ).rejects.toMatchObject({ status: 404, code: "patient_not_found" });
    } finally {
      if (tenantId) {
        await owner.begin(async (transaction) => {
          const linked = await transaction<{ patient_id: string }[]>`
            select patient_id from appointments where service_id = ${serviceId}
          `;
          const patientIds = [
            ...new Set([...linked.map((row) => row.patient_id), ...extraPatientIds]),
          ];
          await transaction`delete from audit_events where appointment_id in (select id from appointments where service_id = ${serviceId})`;
          if (patientIds.length)
            await transaction`delete from audit_events where tenant_id = ${tenantId} and action = 'patient.updated' and metadata->>'patientId' in ${transaction(patientIds)}`;
          await transaction`delete from outbox_events where tenant_id = ${tenantId} and aggregate_id in (select id from appointments where service_id = ${serviceId})`;
          await transaction`delete from resource_reservations where appointment_id in (select id from appointments where service_id = ${serviceId})`;
          await transaction`delete from appointments where service_id = ${serviceId}`;
          if (idempotencyKeyValues.length)
            await transaction`delete from idempotency_keys where tenant_id = ${tenantId} and key in ${transaction(idempotencyKeyValues)}`;
          if (patientIds.length)
            await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id in ${transaction(patientIds)})`;
            await transaction`delete from patients where id in ${transaction(patientIds)}`;
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
