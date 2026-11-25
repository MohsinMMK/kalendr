/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import type { PublicBookingInput } from "@/lib/contracts";

vi.mock("server-only", () => ({}));

import { withTenant } from "@/db/client";
import { createAppointment, listAvailability } from "@/server/appointment-repository";
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
const ZONE = "Asia/Kolkata";

const localDate = (epoch: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epoch));
const dayAt = (date: string, hour: number, minute = 0): Date => new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+05:30`);

describeLocal("availability rules, explained", () => {
  it("names the reason for each missing time, and the engine follows schedules, travel, cover and restriction", async () => {
    const owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const person = randomUUID();
    const cover = randomUUID();
    const serviceId = randomUUID();
    const homeVisits = randomUUID();
    const restrictionId = randomUUID();
    let tenantId = "";
    try {
      const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental' limit 1`;
      const [location] = await owner<{ id: string }[]>`select id from locations where tenant_id = ${tenant?.id ?? ""} limit 1`;
      if (!tenant || !location) throw new Error("Seed the isolated local database before this test");
      tenantId = tenant.id;
      const locationId = location.id;
      await owner.begin(async (transaction) => {
        for (const [id, name] of [[person, "Explain Person"], [cover, "Explain Cover"]] as const) {
          await transaction`insert into practitioners (id, tenant_id, name, title, initials, specialty) values (${id}, ${tenantId}, ${name}, 'Dentist', 'EP', 'Testing')`;
          await transaction`insert into practitioner_services (tenant_id, practitioner_id, service_id) select ${tenantId}, ${id}, null where false`;
        }
        await transaction`
          insert into services (id, tenant_id, name, description, duration_minutes, buffer_before_minutes, buffer_after_minutes,
            slot_interval_minutes, minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types)
          values (${serviceId}, ${tenantId}, 'Explain Service', 'Local integration test', 30, 0, 10, 15, 1440, 30, 'instant', ${["new", "returning"]})`;
        await transaction`insert into service_locations (tenant_id, service_id, location_id) values (${tenantId}, ${serviceId}, ${locationId})`;
        for (const id of [person, cover]) {
          await transaction`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${tenantId}, ${id}, ${serviceId})`;
          await transaction`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${tenantId}, ${id}, ${locationId})`;
          for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
            for (const [from, to] of [["09:00", "13:00"], ["15:00", "19:00"]]) {
              await transaction`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
                values (${randomUUID()}, ${tenantId}, ${locationId}, ${id}, ${dayOfWeek}, ${from}, ${to}, ${ZONE}, '2025-01-01', 15)`;
            }
          }
        }
      });

      const day = localDate(Date.now() + 7 * DAY);
      const book = (startsAt: Date): PublicBookingInput => ({
        clinicSlug: "lotus-dental", patientType: "new", bookingFor: "self", locationId, serviceId, practitionerId: person,
        slotId: randomUUID(), startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
        firstName: "Explain", lastName: "Test", phone: "+919000000077", email: "explain-test@example.com",
        preferredChannel: "email", acceptedPrivacyNotice: true, messagingConsent: false,
      });
      await createAppointment(book(dayAt(day, 11)), randomUUID(), randomUUID().replaceAll("-", ""));

      const explain = (date: string, now?: Date) => withTenant(tenantId, (transaction) =>
        explainDay(transaction, tenantId, { practitionerId: person, serviceId, locationId, date }, now));
      const at = (result: Awaited<ReturnType<typeof explain>>, time: string) => result.steps.find((step) => step.time === time);

      // Outside hours, already booked, the buffer after a visit, the buffer before one, and an offered start.
      const busyDay = await explain(day);
      expect(at(busyDay, "02:00")).toMatchObject({ reason: "outside_hours", label: "Outside working hours" });
      expect(at(busyDay, "14:00")).toMatchObject({ reason: "outside_hours" });
      expect(at(busyDay, "11:00")).toMatchObject({ reason: "already_booked" });
      expect(at(busyDay, "11:30")).toMatchObject({ reason: "buffer_after", label: "Buffer after the 11:00 visit" });
      expect(at(busyDay, "10:30")).toMatchObject({ reason: "buffer_before" });
      expect(at(busyDay, "12:00")).toMatchObject({ reason: null });
      expect(busyDay.bands.some((band) => band.reason === "outside_hours" && band.from >= "12:15" && band.from <= "13:00" && band.to === "15:00")).toBe(true);

      // Too soon, and too far ahead, are about "now", so they are checked with a chosen now.
      const soon = await explain(day, dayAt(day, 6));
      expect(at(soon, "12:00")).toMatchObject({ reason: "within_minimum_notice", label: "Too soon to book online" });
      const far = await explain(day, new Date(dayAt(day, 6).getTime() - 40 * DAY));
      expect(at(far, "12:00")).toMatchObject({ reason: "beyond_booking_window" });

      // A holiday from the country list, named. Trinidad and Tobago lists Deepavali on 8 November 2026.
      await owner`insert into holiday_settings (tenant_id, country) values (${tenantId}, 'TT')`;
      const holiday = await explain("2026-11-08");
      expect(at(holiday, "10:00")).toMatchObject({ reason: "holiday", label: "Holiday: Deepavali" });
      // Turning it off keeps the business open that day.
      await owner`update holiday_settings set opted_out = ${owner.json({ "2026": ["2026-11-08"] })} where tenant_id = ${tenantId}`;
      expect(at(await explain("2026-11-08"), "10:00")?.reason).not.toBe("holiday");
      await owner`delete from holiday_settings where tenant_id = ${tenantId}`;

      // Out of office, with the note.
      const away = localDate(Date.now() + 10 * DAY);
      await owner`insert into time_off (tenant_id, practitioner_id, starts_at, ends_at, reason, public_note, cover_practitioner_id)
        values (${tenantId}, ${person}, ${dayAt(away, 0).toISOString()}, ${new Date(dayAt(away, 0).getTime() + DAY).toISOString()}, 'leave', 'Back tomorrow', ${cover})`;
      const awayDay = await explain(away);
      expect(at(awayDay, "10:00")).toMatchObject({ reason: "out_of_office", label: "Out of office" });
      expect(awayDay.outOfOfficeNote).toBe("Back tomorrow");

      // While the person is away their cover's slots are offered for that day.
      const covered = await listAvailability({ clinicSlug: "lotus-dental", locationId, serviceId, practitionerId: person, from: dayAt(away, 0).toISOString(), to: dayAt(away, 23, 59).toISOString() });
      expect(covered.length).toBeGreaterThan(0);
      expect(new Set(covered.map((slot) => slot.practitionerId))).toEqual(new Set([cover]));

      // A schedule of the service's own, found by name, and a restriction schedule that narrows hours.
      const [defaultSchedule] = await owner<{ id: string }[]>`select id from availability_schedules where practitioner_id = ${person} and is_default`;
      await owner`insert into availability_schedules (id, tenant_id, practitioner_id, name, timezone, is_default) values (${homeVisits}, ${tenantId}, ${person}, 'Home visits', ${ZONE}, false)`;
      const dow = ((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
      await owner`insert into availability_rules (id, tenant_id, location_id, practitioner_id, schedule_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
        values (${randomUUID()}, ${tenantId}, ${locationId}, ${person}, ${homeVisits}, ${dow}, '16:00', '18:00', ${ZONE}, '2025-01-01', 15)`;
      await owner`update services set schedule_id = ${homeVisits} where id = ${serviceId}`;
      const own = await listAvailability({ clinicSlug: "lotus-dental", locationId, serviceId, practitionerId: person, from: dayAt(day, 0).toISOString(), to: dayAt(day, 23, 59).toISOString() });
      expect(own.length).toBeGreaterThan(0);
      expect(own.every((slot) => new Date(slot.startsAt).getTime() >= dayAt(day, 16).getTime() && new Date(slot.endsAt).getTime() <= dayAt(day, 18).getTime())).toBe(true);
      await owner`update services set schedule_id = null where id = ${serviceId}`;

      await owner`insert into availability_schedules (id, tenant_id, practitioner_id, name, timezone, is_default) values (${restrictionId}, ${tenantId}, ${cover}, 'Tuesdays only', ${ZONE}, false)`;
      await owner`insert into availability_rules (id, tenant_id, location_id, practitioner_id, schedule_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
        values (${randomUUID()}, ${tenantId}, ${locationId}, ${cover}, ${restrictionId}, ${dow}, '10:00', '11:00', ${ZONE}, '2025-01-01', 15)`;
      await owner`update services set restriction_schedule_id = ${restrictionId} where id = ${serviceId}`;
      const narrowed = await listAvailability({ clinicSlug: "lotus-dental", locationId, serviceId, practitionerId: cover, from: dayAt(day, 0).toISOString(), to: dayAt(day, 23, 59).toISOString() });
      expect(narrowed.length).toBeGreaterThan(0);
      expect(narrowed.every((slot) => new Date(slot.startsAt).getTime() >= dayAt(day, 10).getTime() && new Date(slot.endsAt).getTime() <= dayAt(day, 11).getTime())).toBe(true);
      expect(defaultSchedule?.id).toBeTruthy();
      await owner`update services set restriction_schedule_id = null where id = ${serviceId}`;

      // Travel: a week in Dubai (UTC+4) reads 09:00 as 05:00 UTC instead of 03:30 UTC.
      const tripDay = localDate(Date.now() + 14 * DAY);
      await owner`insert into travel_periods (tenant_id, practitioner_id, starts_on, ends_on, timezone) values (${tenantId}, ${person}, ${tripDay}::date, (${tripDay}::date + 6), 'Asia/Dubai')`;
      const trip = await listAvailability({ clinicSlug: "lotus-dental", locationId, serviceId, practitionerId: person, from: new Date(dayAt(tripDay, 0).getTime() - DAY).toISOString(), to: new Date(dayAt(tripDay, 0).getTime() + 2 * DAY).toISOString() });
      const firstOnTrip = trip.find((slot) => slot.startsAt.startsWith(tripDay) || new Date(slot.startsAt).getTime() >= dayAt(tripDay, 0).getTime() - 5 * 3_600_000);
      expect(firstOnTrip).toBeDefined();
      const dubaiNine = new Date(`${tripDay}T09:00:00+04:00`).getTime();
      expect(trip.some((slot) => new Date(slot.startsAt).getTime() === dubaiNine)).toBe(true);
      expect(trip.some((slot) => new Date(slot.startsAt).getTime() === dayAt(tripDay, 9).getTime())).toBe(false);
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
          await transaction`delete from holiday_settings where tenant_id = ${tenantId}`;
          await transaction`delete from services where id = ${serviceId}`;
          await transaction`delete from practitioners where id in (${person}, ${cover})`;
        });
      }
      await owner.end();
    }
  }, 60_000);
});
