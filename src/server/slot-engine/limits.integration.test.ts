/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import type { PublicBookingInput } from "@/lib/contracts";
import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

vi.mock("server-only", () => ({}));

import { createAppointment, createStaffAppointment, listAvailabilityDetailed } from "@/server/appointment-repository";
import { getBookingLimits, replaceBookingLimits } from "@/server/booking-limits-admin";
import { withTenant } from "@/db/client";
import { explainDay } from "@/server/slot-engine/explain";

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

describeLocal("booking limits against a real database", () => {
  it("stops at the limit, gives one winner for the last place, caps customers, lets staff override with a reason, and stays inside its business", async () => {
    const owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const personA = randomUUID();
    const personB = randomUUID();
    const serviceOne = randomUUID();
    const serviceTwo = randomUUID();
    let tenantId = "";
    try {
      const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = ${slug} limit 1`;
      const [other] = await owner<{ id: string }[]>`select id from tenants where slug <> ${slug} limit 1`;
      const [location] = await owner<{ id: string; timezone: string }[]>`select id, timezone from locations where tenant_id = ${tenant?.id ?? ""} limit 1`;
      const [member] = await owner<{ user_id: string }[]>`select user_id from memberships where tenant_id = ${tenant?.id ?? ""} limit 1`;
      if (!tenant || !other || !location || !member) throw new Error("Seed the isolated local database before this test");
      tenantId = tenant.id;
      const locationId = location.id;
      const zone = location.timezone;
      await owner.begin(async (transaction) => {
        for (const id of [personA, personB]) {
          await transaction`insert into practitioners (id, tenant_id, name, title, initials, specialty) values (${id}, ${tenantId}, 'Limits Test', 'Dentist', 'LT', 'Testing')`;
          await transaction`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${tenantId}, ${id}, ${locationId})`;
        }
        for (const id of [serviceOne, serviceTwo]) {
          await transaction`
            insert into services (id, tenant_id, name, description, duration_minutes, buffer_before_minutes, buffer_after_minutes,
              slot_interval_minutes, minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types, price_minor)
            values (${id}, ${tenantId}, 'Limits Test Service', 'Local integration test', 60, 0, 0, 60, 0, 60, 'instant', ${["new", "returning"]}, 1000)`;
          await transaction`insert into service_locations (tenant_id, service_id, location_id) values (${tenantId}, ${id}, ${locationId})`;
          for (const person of [personA, personB]) {
            await transaction`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${tenantId}, ${person}, ${id})`;
          }
        }
        for (const person of [personA, personB]) {
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
      const localDate = (daysAhead: number) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + daysAhead * DAY));
      const dayAt = (daysAhead: number, hour: number): Date => {
        // Build the local wall time, then find the instant by checking the zone's offset on that date.
        const guess = new Date(`${localDate(daysAhead)}T${String(hour).padStart(2, "0")}:00:00Z`);
        const shown = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23", minute: "2-digit" }).format(guess);
        const [hh = 0, mm = 0] = shown.split(":").map(Number);
        return new Date(guess.getTime() - ((hh - hour) * 60 + mm) * 60_000);
      };
      const book = (serviceId: string, practitionerId: string, startsAt: Date, email: string): PublicBookingInput => ({
        clinicSlug: slug, patientType: "new", bookingFor: "self", locationId, serviceId, practitionerId,
        slotId: randomUUID(), startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
        firstName: "Limits", lastName: "Test", phone: `+9190000${Math.floor(10000 + Math.random() * 89999)}`, email,
        preferredChannel: "email", acceptedPrivacyNotice: true, messagingConsent: false,
      });
      const create = (input: PublicBookingInput) => createAppointment(input, randomUUID(), randomUUID().replaceAll("-", ""));
      const limit = (maxValue: number, period: "day" | "week" = "day") => ({ measure: "count" as const, period, maxValue, weekStart: 1 as const });
      const unique = () => `limits-${randomUUID().slice(0, 8)}@example.com`;

      // A service limited to 3 a day stops after the third booking that day, and the day shows as full.
      await replaceBookingLimits(context, { target: { scope: "service", scopeId: serviceOne }, limits: [limit(3)] });
      const loaded = await getBookingLimits(context, "service", serviceOne);
      expect(loaded.limits).toHaveLength(1);
      for (const hour of [9, 10, 11]) await create(book(serviceOne, personA, dayAt(7, hour), unique()));
      await expect(create(book(serviceOne, personB, dayAt(7, 12), unique()))).rejects.toMatchObject({ status: 409, code: "limit_reached" });
      const listing = await listAvailabilityDetailed({ clinicSlug: slug, locationId, serviceId: serviceOne, practitionerId: "first_available", from: dayAt(7, 0).toISOString(), to: dayAt(9, 0).toISOString() });
      expect(listing.fullDays).toContain(localDate(7));
      expect(listing.slots.some((slot) => slot.startsAt.startsWith(localDate(7)) && new Date(slot.startsAt).getTime() < dayAt(8, 0).getTime())).toBe(false);
      expect(listing.slots.some((slot) => new Date(slot.startsAt).getTime() >= dayAt(8, 0).getTime())).toBe(true);

      // "Why no slot?" names the limit and how full it is.
      const explained = await withTenant(tenantId, (transaction) => explainDay(transaction, tenantId, { practitionerId: personB, serviceId: serviceOne, locationId, date: localDate(7) }));
      expect(explained.steps.find((step) => step.time === "14:00")?.label).toBe("Daily limit reached (3 of 3)");

      // Two people taking the last place of the day at once, with different practitioners: one booking, one clear refusal.
      await replaceBookingLimits(context, { target: { scope: "service", scopeId: serviceTwo }, limits: [limit(1)] });
      for (const day of [10, 11, 12]) {
        const race = await Promise.allSettled([
          create(book(serviceTwo, personA, dayAt(day, 10), unique())),
          create(book(serviceTwo, personB, dayAt(day, 10), unique())),
        ]);
        expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const refusal = race.find((result) => result.status === "rejected");
        expect(refusal).toMatchObject({ reason: { code: "limit_reached" } });
      }

      // A person's cap applies across all their services.
      await replaceBookingLimits(context, { target: { scope: "practitioner", scopeId: personB }, limits: [limit(2)] });
      await create(book(serviceOne, personB, dayAt(14, 9), unique()));
      await create(book(serviceOne, personB, dayAt(14, 10), unique()));
      await expect(create(book(serviceTwo, personB, dayAt(14, 11), unique()))).rejects.toMatchObject({ code: "limit_reached" });
      await create(book(serviceTwo, personA, dayAt(14, 11), unique()));

      // A customer at their cap is told so, and with the switch on a link is queued for their existing booking.
      await replaceBookingLimits(context, {
        target: { scope: "service", scopeId: serviceOne }, limits: [],
        serviceRules: { maxActivePerCustomer: 2, offerRescheduleWhenCapped: true, firstSlotOnly: false },
      });
      const regular = unique();
      await create(book(serviceOne, personA, dayAt(20, 9), regular));
      await create(book(serviceOne, personA, dayAt(20, 10), regular));
      const capped = await create(book(serviceOne, personA, dayAt(20, 11), regular)).catch((error: unknown) => error);
      expect(capped).toMatchObject({ status: 409, code: "customer_cap_reached", message: expect.stringContaining("sent a link") });
      expect(JSON.stringify(capped)).not.toContain("manage");
      const [queued] = await owner<{ count: string }[]>`select count(*) from outbox_events where tenant_id = ${tenantId} and dedupe_key like 'appointment.reschedule_offer:%'`;
      expect(Number(queued?.count)).toBeGreaterThanOrEqual(1);
      await create(book(serviceOne, personA, dayAt(20, 11), unique()));

      // Staff can go past a limit with a fixed reason, and the audit row keeps only that reason.
      await replaceBookingLimits(context, { target: { scope: "service", scopeId: serviceTwo }, limits: [limit(1)] });
      const staffBooking = (withReason: boolean) => createStaffAppointment(context, {
        clinicSlug: slug, locationId, serviceId: serviceTwo, practitionerId: personA, startsAt: dayAt(10, 13).toISOString(), source: "desk",
        newPatient: { firstName: "Desk", lastName: "Person", phone: "+919000000077", email: unique(), preferredChannel: "email", isDependent: false, messagingConsent: false },
        ...(withReason ? { limitOverrideReason: "owner_decision" as const } : {}),
      }, randomUUID(), randomUUID().replaceAll("-", ""));
      await expect(staffBooking(false)).rejects.toMatchObject({ code: "limit_reached" });
      const overridden = await staffBooking(true);
      const [audit] = await owner<{ metadata: Record<string, unknown> }[]>`select metadata from audit_events where appointment_id = ${overridden.appointmentId} and action = 'appointment.created'`;
      expect(audit?.metadata).toMatchObject({ limitOverride: "owner_decision" });

      // Another business can neither read nor change these limits.
      const runtime = postgres(runtimeUrl!, { max: 1, prepare: false });
      try {
        const visible = await runtime.begin(async (transaction) => {
          await transaction`select set_config('app.tenant_id', ${other.id}, true)`;
          return transaction<{ count: string }[]>`select count(*) from booking_limits where tenant_id = ${tenantId}`;
        });
        expect(Number(visible[0]?.count)).toBe(0);
        await expect(runtime.begin(async (transaction) => {
          await transaction`select set_config('app.tenant_id', ${other.id}, true)`;
          await transaction`insert into booking_limits (tenant_id, scope, service_id, measure, period, max_value) values (${tenantId}, 'service', ${serviceOne}, 'count', 'week', 5)`;
        })).rejects.toThrow();
      } finally {
        await runtime.end();
      }
    } finally {
      if (tenantId) {
        await owner.begin(async (transaction) => {
          const patients = await transaction<{ patient_id: string }[]>`select patient_id from appointments where service_id in (${serviceOne}, ${serviceTwo})`;
          await transaction`delete from audit_events where appointment_id in (select id from appointments where service_id in (${serviceOne}, ${serviceTwo}))`;
          await transaction`delete from outbox_events where tenant_id = ${tenantId} and aggregate_id in (select id from appointments where service_id in (${serviceOne}, ${serviceTwo}))`;
          await transaction`delete from appointments where service_id in (${serviceOne}, ${serviceTwo})`;
          await transaction`delete from idempotency_keys where tenant_id = ${tenantId} and created_at > now() - interval '10 minutes'`;
          if (patients.length) await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id in ${transaction(patients.map((patient) => patient.patient_id))})`;
          if (patients.length) await transaction`delete from patients where id in ${transaction(patients.map((patient) => patient.patient_id))}`;
          await transaction`delete from booking_limits where tenant_id = ${tenantId} and (service_id in (${serviceOne}, ${serviceTwo}) or practitioner_id in (${personA}, ${personB}))`;
          await transaction`delete from availability_rules where practitioner_id in (${personA}, ${personB})`;
          await transaction`delete from practitioner_services where practitioner_id in (${personA}, ${personB})`;
          await transaction`delete from practitioner_locations where practitioner_id in (${personA}, ${personB})`;
          await transaction`delete from service_locations where service_id in (${serviceOne}, ${serviceTwo})`;
          await transaction`delete from services where id in (${serviceOne}, ${serviceTwo})`;
          await transaction`delete from practitioners where id in (${personA}, ${personB})`;
        });
      }
      await owner.end();
    }
  }, 120_000);
});
