/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import type { PublicBookingInput } from "@/lib/contracts";

vi.mock("server-only", () => ({}));

import { createAppointment, listAvailability } from "@/server/appointment-repository";
import { createSlotHold, releaseSlotHold } from "@/server/slot-holds";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const localDatabase = (url: string | undefined): boolean => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5544", "5545"].includes(parsed.port) && ["/kalendr_local", "/nira_local"].includes(parsed.pathname);
};
const describeLocal = localDatabase(runtimeUrl) && localDatabase(ownerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

const DAY = 86_400_000;
const slug = "lotus-dental";

describeLocal("slot holds against a real database", () => {
  it("keeps a picked time from everyone else for five minutes, gives it back, and turns the customer's own hold into their booking", async () => {
    const owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const person = randomUUID();
    const service = randomUUID();
    let tenantId = "";
    try {
      const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = ${slug} limit 1`;
      const [other] = await owner<{ id: string }[]>`select id from tenants where slug <> ${slug} limit 1`;
      const [location] = await owner<{ id: string; timezone: string }[]>`select id, timezone from locations where tenant_id = ${tenant?.id ?? ""} limit 1`;
      if (!tenant || !other || !location) throw new Error("Seed the isolated local database before this test");
      tenantId = tenant.id;
      const locationId = location.id;
      await owner.begin(async (transaction) => {
        await transaction`insert into practitioners (id, tenant_id, name, title, initials, specialty) values (${person}, ${tenantId}, 'Hold Test', 'Dentist', 'HT', 'Testing')`;
        await transaction`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${tenantId}, ${person}, ${locationId})`;
        await transaction`
          insert into services (id, tenant_id, name, description, duration_minutes, buffer_before_minutes, buffer_after_minutes,
            slot_interval_minutes, minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types, price_minor)
          values (${service}, ${tenantId}, 'Hold Test Service', 'Local integration test', 60, 0, 0, 60, 0, 60, 'instant', ${["new", "returning"]}, 1000)`;
        await transaction`insert into service_locations (tenant_id, service_id, location_id) values (${tenantId}, ${service}, ${locationId})`;
        await transaction`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${tenantId}, ${person}, ${service})`;
        for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
          await transaction`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
            values (${randomUUID()}, ${tenantId}, ${locationId}, ${person}, ${dayOfWeek}, '09:00', '17:00', ${location.timezone}, '2025-01-01', 60)`;
        }
      });

      const open = await listAvailability({ clinicSlug: slug, locationId, serviceId: service, practitionerId: person, from: new Date(Date.now() + 3 * DAY).toISOString(), to: new Date(Date.now() + 5 * DAY).toISOString() });
      expect(open.length).toBeGreaterThan(4);
      const [first, second, third] = open as [typeof open[number], typeof open[number], typeof open[number]];
      const request = (slot: typeof first, replaceToken?: string) => ({
        clinicSlug: slug, locationId, serviceId: service, practitionerId: person, startsAt: slot.startsAt, endsAt: slot.endsAt, ...(replaceToken ? { replaceToken } : {}),
      });
      const visible = async (slotId: string) => (await listAvailability({ clinicSlug: slug, locationId, serviceId: service, practitionerId: person, from: first.startsAt, to: new Date(Date.parse(third.endsAt) + DAY).toISOString() })).some((slot) => slot.id === slotId);

      // One customer holds a time: nobody else sees it, holds it or books it.
      const held = await createSlotHold(request(first));
      expect(Date.parse(held.expiresAt) - Date.now()).toBeGreaterThan(4 * 60_000);
      expect(Date.parse(held.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
      expect(await visible(first.id)).toBe(false);
      await expect(createSlotHold(request(first))).rejects.toMatchObject({ status: 409, code: "slot_unavailable" });
      const book = (slot: typeof first, holdToken?: string): PublicBookingInput => ({
        clinicSlug: slug, patientType: "new", bookingFor: "self", locationId, serviceId: service, practitionerId: person,
        slotId: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt, firstName: "Hold", lastName: "Test", phone: "+919000000055",
        email: `hold-${randomUUID().slice(0, 6)}@example.com`, preferredChannel: "email", acceptedPrivacyNotice: true, messagingConsent: false,
        ...(holdToken ? { holdToken } : {}),
      });
      const create = (input: PublicBookingInput) => createAppointment(input, randomUUID(), randomUUID().replaceAll("-", ""));
      await expect(create(book(first))).rejects.toMatchObject({ code: "slot_unavailable" });
      await expect(create(book(first, "not-the-token-not-the-token"))).rejects.toMatchObject({ code: "slot_unavailable" });

      // Only the hash of the token is stored.
      const stored = await owner<{ token_hash: string }[]>`select token_hash from slot_holds where tenant_id = ${tenantId} and practitioner_id = ${person}`;
      expect(stored).toHaveLength(1);
      expect(stored[0]?.token_hash).not.toContain(held.holdToken);

      // Picking another time lets the first one go: one live hold per browser.
      const moved = await createSlotHold(request(second, held.holdToken));
      expect(await visible(first.id)).toBe(true);
      expect(await visible(second.id)).toBe(false);

      // After five minutes without booking, the time comes back, even though no clean-up job ran.
      await owner`update slot_holds set expires_at = now() - interval '1 second' where tenant_id = ${tenantId} and practitioner_id = ${person}`;
      expect(await visible(second.id)).toBe(true);
      await expect(create(book(second, moved.holdToken))).resolves.toMatchObject({ status: "booked" });

      // The customer's own hold becomes the booking, and the hold row is gone.
      const mine = await createSlotHold(request(third));
      await expect(create(book(third, mine.holdToken))).resolves.toMatchObject({ status: "booked" });
      const left = await owner<{ count: string }[]>`select count(*) from slot_holds where tenant_id = ${tenantId} and practitioner_id = ${person}`;
      expect(Number(left[0]?.count)).toBe(0);

      // Releasing frees the time at once, and another business cannot see these holds.
      const again = await createSlotHold(request(first));
      expect(await visible(first.id)).toBe(false);
      await releaseSlotHold(slug, again.holdToken);
      expect(await visible(first.id)).toBe(true);
      const hold = await createSlotHold(request(first));
      const runtime = postgres(runtimeUrl!, { max: 1, prepare: false });
      try {
        const seen = await runtime.begin(async (transaction) => {
          await transaction`select set_config('app.tenant_id', ${other.id}, true)`;
          return transaction<{ count: string }[]>`select count(*) from slot_holds where tenant_id = ${tenantId}`;
        });
        expect(Number(seen[0]?.count)).toBe(0);
      } finally {
        await runtime.end();
      }
      await releaseSlotHold(slug, hold.holdToken);
    } finally {
      if (tenantId) {
        await owner.begin(async (transaction) => {
          const patients = await transaction<{ patient_id: string }[]>`select patient_id from appointments where service_id = ${service}`;
          await transaction`delete from slot_holds where service_id = ${service}`;
          await transaction`delete from audit_events where appointment_id in (select id from appointments where service_id = ${service})`;
          await transaction`delete from outbox_events where tenant_id = ${tenantId} and aggregate_id in (select id from appointments where service_id = ${service})`;
          await transaction`delete from appointments where service_id = ${service}`;
          await transaction`delete from idempotency_keys where tenant_id = ${tenantId} and created_at > now() - interval '10 minutes'`;
          if (patients.length) await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id in ${transaction(patients.map((patient) => patient.patient_id))})`;
          if (patients.length) await transaction`delete from patients where id in ${transaction(patients.map((patient) => patient.patient_id))}`;
          await transaction`delete from availability_rules where practitioner_id = ${person}`;
          await transaction`delete from practitioner_services where practitioner_id = ${person}`;
          await transaction`delete from practitioner_locations where practitioner_id = ${person}`;
          await transaction`delete from service_locations where service_id = ${service}`;
          await transaction`delete from services where id = ${service}`;
          await transaction`delete from practitioners where id = ${person}`;
        });
      }
      await owner.end();
    }
  }, 60_000);
});
