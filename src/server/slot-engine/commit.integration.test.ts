/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import type { PublicBookingInput } from "@/lib/contracts";

vi.mock("server-only", () => ({}));

import { createAppointment, listAvailability } from "@/server/appointment-repository";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const localDatabase = (url: string | undefined): boolean => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5544", "5545"].includes(parsed.port) && ["/kalendr_local", "/nira_local"].includes(parsed.pathname);
};
const describeLocal = localDatabase(runtimeUrl) && localDatabase(ownerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

const DAY = 86_400_000;

describeLocal("the booking commit applies the service's own rules", () => {
  it("refuses a booking inside the notice, beyond the window or in a length the service does not offer, and prices the length booked", async () => {
    const owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const practitionerId = randomUUID();
    const serviceId = randomUUID();
    let tenantId = "";
    try {
      const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental' limit 1`;
      const [location] = await owner<{ id: string }[]>`select id from locations where tenant_id = ${tenant?.id ?? ""} limit 1`;
      if (!tenant || !location) throw new Error("Seed the isolated local database before this test");
      tenantId = tenant.id;
      const locationId = location.id;
      await owner.begin(async (transaction) => {
        await transaction`insert into practitioners (id, tenant_id, name, title, initials, specialty) values (${practitionerId}, ${tenantId}, 'Rules Test Person', 'Dentist', 'RT', 'Testing')`;
        await transaction`
          insert into services (id, tenant_id, name, description, duration_minutes, buffer_before_minutes, buffer_after_minutes,
            slot_interval_minutes, minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types, price_minor)
          values (${serviceId}, ${tenantId}, 'Rules Test Service', 'Local integration test', 30, 0, 15, 15, 1440, 30, 'instant', ${["new", "returning"]}, 50000)`;
        await transaction`insert into service_durations (tenant_id, service_id, minutes, price_minor, is_default, sort_order) values
          (${tenantId}, ${serviceId}, 30, 50000, true, 0), (${tenantId}, ${serviceId}, 45, 70000, false, 1), (${tenantId}, ${serviceId}, 60, 90000, false, 2)`;
        await transaction`insert into service_locations (tenant_id, service_id, location_id) values (${tenantId}, ${serviceId}, ${locationId})`;
        await transaction`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${tenantId}, ${practitionerId}, ${serviceId})`;
        await transaction`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${tenantId}, ${practitionerId}, ${locationId})`;
        for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
          await transaction`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
            values (${randomUUID()}, ${tenantId}, ${locationId}, ${practitionerId}, ${dayOfWeek}, '09:00', '17:00', 'Asia/Kolkata', '2025-01-01', 15)`;
        }
      });

      const dayAt = (daysAhead: number, hour: number, minute = 0): Date => {
        const local = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + daysAhead * DAY));
        return new Date(`${local}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+05:30`);
      };
      const book = (startsAt: Date, minutes: number): PublicBookingInput => ({
        clinicSlug: "lotus-dental", patientType: "new", bookingFor: "self", locationId, serviceId, practitionerId,
        slotId: randomUUID(), startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + minutes * 60_000).toISOString(),
        firstName: "Rules", lastName: "Test", phone: "+919000000088", email: "rules-test@example.com",
        preferredChannel: "email", acceptedPrivacyNotice: true, messagingConsent: false,
      });
      const create = (input: PublicBookingInput) => createAppointment(input, randomUUID(), randomUUID().replaceAll("-", ""));
      const query = (from: Date, to: Date, durationMinutes?: number) => listAvailability({
        clinicSlug: "lotus-dental", locationId, serviceId, practitionerId, from: from.toISOString(), to: to.toISOString(),
        ...(durationMinutes ? { durationMinutes } : {}),
      });

      // The page stops offering what the notice or the window forbids.
      const soon = await query(new Date(), new Date(Date.now() + 20 * 3_600_000));
      expect(soon).toEqual([]);
      const tooFar = await query(new Date(Date.now() + 31 * DAY), new Date(Date.now() + 33 * DAY));
      expect(tooFar).toEqual([]);

      // A direct booking that breaks one is refused with a sentence, not just a code.
      await expect(create(book(new Date(Date.now() + 2 * 3_600_000), 30))).rejects.toMatchObject({ status: 409, code: "slot_unavailable" });
      await expect(create(book(dayAt(40, 10), 30))).rejects.toMatchObject({ status: 409, code: "slot_unavailable", message: expect.stringContaining("further ahead") });
      await expect(create(book(dayAt(0, 23), 30))).rejects.toMatchObject({ status: 409, code: "slot_unavailable" });

      // Lengths: each one offers its own slots, and a length the service does not list is refused.
      const thirty = await query(dayAt(7, 0), dayAt(7, 23, 59), 30);
      const sixty = await query(dayAt(7, 0), dayAt(7, 23, 59), 60);
      expect(thirty.length).toBeGreaterThan(sixty.length);
      expect(sixty.every((slot) => new Date(slot.endsAt).getTime() - new Date(slot.startsAt).getTime() === 60 * 60_000)).toBe(true);
      await expect(query(dayAt(7, 0), dayAt(7, 23, 59), 50)).rejects.toMatchObject({ status: 400 });
      await expect(create(book(dayAt(7, 14), 50))).rejects.toMatchObject({ status: 409, code: "slot_unavailable" });

      // The appointment is priced at the length that was booked.
      const created = await create(book(dayAt(7, 10), 45));
      const [stored] = await owner<{ price_minor: number; location_kind: string | null }[]>`select price_minor, location_kind from appointments where id = ${created.appointmentId}`;
      expect(stored).toMatchObject({ price_minor: 70000, location_kind: "in_person" });

      // The 15 minute after-buffer also blocks a start that would begin inside it: 10:00 to 10:45, buffer to 11:00.
      const around = await query(dayAt(7, 9), dayAt(7, 13), 30);
      const startsAt = around.map((slot) => slot.startsAt);
      expect(startsAt).not.toContain(dayAt(7, 10, 45).toISOString());
      expect(startsAt).toContain(dayAt(7, 11).toISOString());
      await expect(create(book(dayAt(7, 10, 45), 30))).rejects.toMatchObject({ status: 409, code: "slot_unavailable" });

      // Two people taking the same last slot at the same moment: one booking, one refusal.
      const race = await Promise.allSettled([create(book(dayAt(7, 15), 30)), create(book(dayAt(7, 15), 30))]);
      expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(race.filter((result) => result.status === "rejected")).toHaveLength(1);
    } finally {
      if (tenantId) {
        await owner.begin(async (transaction) => {
          const patients = await transaction<{ patient_id: string }[]>`select patient_id from appointments where service_id = ${serviceId}`;
          await transaction`delete from audit_events where appointment_id in (select id from appointments where service_id = ${serviceId})`;
          await transaction`delete from outbox_events where tenant_id = ${tenantId} and aggregate_id in (select id from appointments where service_id = ${serviceId})`;
          await transaction`delete from appointments where service_id = ${serviceId}`;
          await transaction`delete from idempotency_keys where tenant_id = ${tenantId} and route = '/api/public/appointments' and created_at > now() - interval '5 minutes'`;
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
