/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { expect, it, vi } from "vitest";

import { describeScratch } from "@/server/testing/scratch-database";

vi.mock("server-only", () => ({}));

import { withTenant } from "@/db/client";
import { createAppointment, getManageSnapshot, manageAppointment } from "@/server/appointment-repository";
import { loadMovedBooking } from "@/server/old-manage-link";
import { assertSlotOfferable } from "@/server/slot-engine/commit";

const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const DAY = 86_400_000;
const slug = "lotus-dental";

describeScratch("optimized slots and the old reschedule link", () => {
  it("commits the start next to a booking only when optimized slots is on, and an old link only ever says the booking moved", async () => {
    const owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const person = randomUUID();
    const service = randomUUID();
    let tenantId = "";
    try {
      const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = ${slug} limit 1`;
      const [location] = await owner<{ id: string; timezone: string }[]>`select id, timezone from locations where tenant_id = ${tenant?.id ?? ""} limit 1`;
      if (!tenant || !location) throw new Error("Seed the scratch database before this test");
      tenantId = tenant.id;
      const zone = location.timezone;
      await owner.begin(async (transaction) => {
        await transaction`insert into practitioners (id, tenant_id, name, title, initials, specialty) values (${person}, ${tenantId}, 'Optimized Test', 'Dentist', 'OT', 'Testing')`;
        await transaction`
          insert into services (id, tenant_id, name, slug, description, duration_minutes, buffer_before_minutes, buffer_after_minutes,
            slot_interval_minutes, minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types, price_minor)
          values (${service}, ${tenantId}, 'Optimized Service', ${`optimized-${service.slice(0, 8)}`}, 'Local integration test', 30, 0, 15, 30, 0, 60, 'instant', ${["new", "returning"]}, 1000)`;
        await transaction`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${tenantId}, ${person}, ${service})`;
        await transaction`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${tenantId}, ${person}, ${location.id})`;
        await transaction`insert into service_locations (tenant_id, service_id, location_id) values (${tenantId}, ${service}, ${location.id})`;
        for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
          await transaction`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
            values (${randomUUID()}, ${tenantId}, ${location.id}, ${person}, ${dayOfWeek}, '09:00', '17:00', ${zone}, '2025-01-01', 30)`;
        }
      });
      const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 8 * DAY));
      const at = (hour: number, minute = 0): Date => {
        const guess = new Date(`${localDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
        const shown = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23", minute: "2-digit" }).format(guess);
        const [hh = 0, mm = 0] = shown.split(":").map(Number);
        return new Date(guess.getTime() - ((hh - hour) * 60 + (mm - minute)) * 60_000);
      };
      const check = (startsAt: Date) => withTenant(tenantId, (transaction) => assertSlotOfferable(transaction, {
        tenantId, locationId: location.id, serviceId: service, practitionerId: person, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), mode: "standard",
      }));
      const phone = () => `+9190000${Math.floor(10000 + Math.random() * 89999)}`;
      const book = (startsAt: Date) => createAppointment({
        clinicSlug: slug, patientType: "new", bookingFor: "self", locationId: location.id, serviceId: service, practitionerId: person,
        slotId: randomUUID(), startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
        firstName: "Optimized", lastName: "Test", phone: phone(), email: `opt-${randomUUID().slice(0, 8)}@example.com`,
        preferredChannel: "email", acceptedPrivacyNotice: true, messagingConsent: false,
      }, randomUUID(), randomUUID().replaceAll("-", ""));

      // A 30-minute booking at 10:00 with a 15-minute buffer holds the person until 10:45, which is off the 30-minute grid.
      const first = await book(at(10));
      await expect(check(at(10, 45))).rejects.toMatchObject({ code: "slot_unavailable" });
      await owner`update services set optimized_slots = true where id = ${service}`;
      await expect(check(at(10, 45))).resolves.toBeTruthy();
      await expect(check(at(10, 30))).rejects.toMatchObject({ code: "slot_unavailable" });
      await owner`update services set optimized_slots = false where id = ${service}`;
      await expect(check(at(10, 45))).rejects.toMatchObject({ code: "slot_unavailable" });

      // Old link: a move retires the token. It can no longer read, cancel or move the booking, even moved twice.
      const originalToken = first.manageToken;
      const firstMove = await manageAppointment(originalToken, { action: "reschedule", startsAt: at(13).toISOString(), expectedVersion: 1 });
      const secondToken = firstMove.manageToken!;
      const secondMove = await manageAppointment(secondToken, { action: "reschedule", startsAt: at(14).toISOString(), expectedVersion: 2 });
      const liveToken = secondMove.manageToken!;
      for (const dead of [originalToken, secondToken]) {
        await expect(getManageSnapshot(dead)).rejects.toMatchObject({ status: 404 });
        await expect(manageAppointment(dead, { action: "cancel", expectedVersion: 3, reasonCode: "other" })).rejects.toMatchObject({ status: 404 });
        await expect(manageAppointment(dead, { action: "reschedule", startsAt: at(15).toISOString(), expectedVersion: 3 })).rejects.toMatchObject({ status: 404 });
        const landing = await loadMovedBooking(dead);
        expect(landing?.newTime?.startsAt).toBe(at(14).toISOString());
        expect(landing?.bookAgainPath).toMatch(/^\/book\/lotus-dental\/optimized-/);
        expect(JSON.stringify(landing)).not.toContain(liveToken);
      }
      // A token nobody ever had is nothing at all.
      await expect(loadMovedBooking(randomUUID())).resolves.toBeNull();
      // The live link still works.
      await expect(getManageSnapshot(liveToken)).resolves.toBeTruthy();

      // Book again can be switched off per service; a cancelled booking shows no new time.
      await owner`update services set rebook_from_old_link = false where id = ${service}`;
      expect((await loadMovedBooking(originalToken))?.bookAgainPath).toBeNull();
      await manageAppointment(liveToken, { action: "cancel", expectedVersion: 3, reasonCode: "other" });
      expect((await loadMovedBooking(originalToken))?.newTime).toBeNull();

      // Another business cannot read it: the retired-link table is tenant-isolated.
      const [other] = await owner<{ id: string }[]>`select id from tenants where id <> ${tenantId} limit 1`;
      if (other) {
        const rows = await withTenant(other.id, (transaction) => transaction.execute(sql`select 1 from retired_manage_tokens`));
        expect(rows.length).toBe(0);
      }
    } finally {
      if (tenantId) {
        await owner`delete from appointments where tenant_id = ${tenantId} and practitioner_id = ${person}`.catch(() => undefined);
        await owner`update practitioners set is_active = false where tenant_id = ${tenantId} and id = ${person}`;
      }
      await owner.end();
    }
  });
});
