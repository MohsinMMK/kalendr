/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { expect, it, vi } from "vitest";

import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";
import { describeScratch } from "@/server/testing/scratch-database";

vi.mock("server-only", () => ({}));

import { withTenant } from "@/db/client";
import { createAppointment } from "@/server/appointment-repository";
import { replaceBookingLimits } from "@/server/booking-limits-admin";
import { assertSlotOfferable } from "@/server/slot-engine/commit";

const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const DAY = 86_400_000;
const slug = "lotus-dental";

describeScratch("the slot check for a visit that is not a fresh booking", () => {
  it("keeps the daily limit when asked (approvals, waitlist offers), and a hold at one location blocks the person at another", async () => {
    const owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const person = randomUUID();
    const service = randomUUID();
    const secondLocation = randomUUID();
    let tenantId = "";
    try {
      const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = ${slug} limit 1`;
      const [location] = await owner<{ id: string; timezone: string }[]>`select id, timezone from locations where tenant_id = ${tenant?.id ?? ""} limit 1`;
      const [member] = await owner<{ user_id: string }[]>`select user_id from memberships where tenant_id = ${tenant?.id ?? ""} limit 1`;
      if (!tenant || !location || !member) throw new Error("Seed the scratch database before this test");
      tenantId = tenant.id;
      const zone = location.timezone;
      await owner.begin(async (transaction) => {
        await transaction`insert into locations (id, tenant_id, name, address, city, timezone) values (${secondLocation}, ${tenantId}, 'Second room', '1 Test Road', 'Pune', ${zone})`;
        await transaction`insert into practitioners (id, tenant_id, name, title, initials, specialty) values (${person}, ${tenantId}, 'Existing Mode', 'Dentist', 'EM', 'Testing')`;
        await transaction`
          insert into services (id, tenant_id, name, description, duration_minutes, buffer_before_minutes, buffer_after_minutes,
            slot_interval_minutes, minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types, price_minor)
          values (${service}, ${tenantId}, 'Existing Mode Service', 'Local integration test', 60, 0, 0, 60, 0, 60, 'instant', ${["new", "returning"]}, 1000)`;
        await transaction`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${tenantId}, ${person}, ${service})`;
        for (const locationId of [location.id, secondLocation]) {
          await transaction`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${tenantId}, ${person}, ${locationId})`;
          await transaction`insert into service_locations (tenant_id, service_id, location_id) values (${tenantId}, ${service}, ${locationId})`;
          for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
            await transaction`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
              values (${randomUUID()}, ${tenantId}, ${locationId}, ${person}, ${dayOfWeek}, '09:00', '17:00', ${zone}, '2025-01-01', 60)`;
          }
        }
      });
      const context: StaffContext = {
        tenantId, clinicSlug: slug, clinicName: slug, role: "owner", permissions: resolvePermissions("owner", {}),
        membershipId: null, userId: member.user_id, userName: "Owner", userEmail: "owner@example.com", preview: false,
      };
      const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 6 * DAY));
      const at = (hour: number): Date => {
        const guess = new Date(`${localDate}T${String(hour).padStart(2, "0")}:00:00Z`);
        const shown = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23", minute: "2-digit" }).format(guess);
        const [hh = 0, mm = 0] = shown.split(":").map(Number);
        return new Date(guess.getTime() - ((hh - hour) * 60 + mm) * 60_000);
      };
      const check = (hour: number, locationId: string, extra: { enforceLimits?: boolean; mode?: "existing" | "standard" } = {}) =>
        withTenant(tenantId, (transaction) => assertSlotOfferable(transaction, {
          tenantId, locationId, serviceId: service, practitionerId: person, startsAt: at(hour), endsAt: at(hour + 1),
          mode: extra.mode ?? "existing", keepExistingLength: true, ...(extra.enforceLimits ? { enforceLimits: true } : {}),
        }));

      // One a day, and that one is taken.
      await replaceBookingLimits(context, { target: { scope: "service", scopeId: service }, limits: [{ measure: "count", period: "day", maxValue: 1, weekStart: 1 }] });
      await createAppointment({
        clinicSlug: slug, patientType: "new", bookingFor: "self", locationId: location.id, serviceId: service, practitionerId: person,
        slotId: randomUUID(), startsAt: at(9).toISOString(), endsAt: at(10).toISOString(),
        firstName: "Existing", lastName: "Mode", phone: `+9190000${Math.floor(10000 + Math.random() * 89999)}`,
        email: `existing-${randomUUID().slice(0, 8)}@example.com`, preferredChannel: "email", acceptedPrivacyNotice: true, messagingConsent: false,
      }, randomUUID(), randomUUID().replaceAll("-", ""));
      // A visit moving within its own day is not a new booking: no limit.
      await expect(check(12, location.id)).resolves.toBeTruthy();
      // An approval or a waitlist offer is: the limit holds.
      await expect(check(12, location.id, { enforceLimits: true })).rejects.toMatchObject({ code: "limit_reached" });

      // A live hold on this person at the first location keeps them busy at the second one too.
      await owner`
        insert into slot_holds (tenant_id, service_id, practitioner_id, location_id, starts_at, ends_at, reserved_starts_at, reserved_ends_at, token_hash, expires_at)
        values (${tenantId}, ${service}, ${person}, ${location.id}, ${at(14)}, ${at(15)}, ${at(14)}, ${at(15)}, ${randomUUID()}, now() + interval '5 minutes')`;
      await expect(check(14, secondLocation)).rejects.toMatchObject({ code: "slot_unavailable" });
      await expect(check(15, secondLocation)).resolves.toBeTruthy();

      // With nobody left who can take it (switched off, or over the plan's calendar limit), the time is simply not free.
      await owner`update practitioners set is_active = false where tenant_id = ${tenantId} and id = ${person}`;
      await expect(check(15, secondLocation)).rejects.toMatchObject({ code: "slot_unavailable" });
    } finally {
      if (tenantId) {
        await owner`delete from slot_holds where tenant_id = ${tenantId} and practitioner_id = ${person}`;
        // Switched off so repeated runs don't push the seed clinic past its plan's calendar limit.
        await owner`update practitioners set is_active = false where tenant_id = ${tenantId} and id = ${person}`;
        await owner`delete from booking_limits where tenant_id = ${tenantId} and scope_id = ${service}`.catch(() => undefined);
      }
      await owner.end();
    }
  });
});
