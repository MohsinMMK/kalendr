/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import { expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { PublicBookingInput } from "@/lib/contracts";
import { createAppointment } from "@/server/appointment-repository";
import { addBlocklistEntry, decideBookingReport, listBlocklist, listBookingReports, removeBlocklistEntry } from "@/server/spam";
import { runStaffAppointmentAction } from "@/server/staff-transitions";
import { describeScratch } from "@/server/testing/scratch-database";
import { createSchedulingFixture, plusMinutes, startIn, type SchedulingFixture } from "@/server/testing/scheduling-fixture";

const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? "";
const book = (input: PublicBookingInput, key: string = randomUUID()) => createAppointment(input, key, key.replaceAll("-", ""));

async function tidy(fixture: SchedulingFixture): Promise<void> {
  await fixture.owner`delete from booking_reports where tenant_id = ${fixture.tenantId}`;
  await fixture.owner`delete from blocklist_entries where tenant_id = ${fixture.tenantId}`;
  await fixture.owner`delete from audit_events where tenant_id = ${fixture.tenantId} and action = 'booking.refused_blocklist'`;
  await fixture.owner`delete from idempotency_keys where tenant_id = ${fixture.tenantId} and route = '/api/public/appointments' and response_status = 201 and created_at > now() - interval '1 hour'`;
  await fixture.cleanup();
}

describeScratch("spam protection (feature 44)", () => {
  it("reports a booking and its repeats, then blocks the email: a variant books silently", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Spam" });
    try {
      const t1 = startIn(12, 10);
      const real = await book(fixture.bookingInput(t1, plusMinutes(t1, 30), "r.a.j+x@gmail.com", { firstName: "Raj", lastName: "Spam" }));
      expect(real.status).toBe("booked");

      // A repeat of that booking: a second visit in a made-up series, as feature 17 would have stored it.
      const [patient] = await fixture.owner<{ patient_id: string }[]>`select patient_id from appointments where id = ${real.appointmentId}`;
      const t2 = startIn(19, 10);
      const second = await book(fixture.bookingInput(t2, plusMinutes(t2, 30), "r.a.j+x@gmail.com", { firstName: "Raj", lastName: "Spam" }));
      const [seriesRow] = await fixture.owner<{ id: string }[]>`
        insert into appointment_series (tenant_id, patient_id, service_id, practitioner_id, location_id, rule_text, rule, starts_on, time_of_day, duration_minutes, occurrence_count)
        values (${fixture.tenantId}, ${patient!.patient_id}, ${fixture.serviceId}, ${fixture.practitionerId}, ${fixture.locationId}, 'Weekly', '{}', current_date, '10:00', 30, 2) returning id`;
      await fixture.owner`update appointments set series_id = ${seriesRow!.id}, series_index = 1 where id = ${real.appointmentId}`;
      await fixture.owner`update appointments set series_id = ${seriesRow!.id}, series_index = 2 where id = ${second.appointmentId}`;
      const eventsBefore = await fixture.owner<{ n: number }[]>`select count(*)::int as n from outbox_events where tenant_id = ${fixture.tenantId}`;

      const [version] = await fixture.owner<{ version: number }[]>`select version from appointments where id = ${real.appointmentId}`;
      await runStaffAppointmentAction(fixture.context, real.appointmentId, { action: "report_spam", reasonCode: "fake_details", expectedVersion: version!.version });

      const rows = await fixture.owner<{ id: string; status: string; spam_state: string; cancelled_by: string | null; cancel_reason_code: string | null }[]>`
        select id, status, spam_state, cancelled_by, cancel_reason_code from appointments where series_id = ${seriesRow!.id} order by series_index`;
      expect(rows.map((row) => row.status)).toEqual(["cancelled", "cancelled"]);
      expect(rows.map((row) => row.cancelled_by)).toEqual(["system", "system"]);
      expect(rows[0]!.cancel_reason_code).toBe("spam");
      expect(rows[0]!.spam_state).toBe("reported");
      // The customer is told nothing: every cancel event says so.
      const quiet = await fixture.owner<{ quiet: boolean }[]>`
        select (payload->>'notifyCustomer') = 'false' as quiet from outbox_events
        where tenant_id = ${fixture.tenantId} and event_type = 'appointment.status.cancelled' and aggregate_id in (${real.appointmentId}, ${second.appointmentId})`;
      expect(quiet).toHaveLength(2);
      expect(quiet.every((row) => row.quiet)).toBe(true);
      expect((await fixture.owner<{ n: number }[]>`select count(*)::int as n from outbox_events where tenant_id = ${fixture.tenantId}`)[0]!.n).toBe(eventsBefore[0]!.n + 2);
      // Reporting twice is refused.
      await expect(runStaffAppointmentAction(fixture.context, real.appointmentId, { action: "report_spam", reasonCode: "other", expectedVersion: version!.version + 1 })).rejects.toMatchObject({ code: "already_reported" });

      const queue = await listBookingReports(fixture.context, "open");
      expect(queue).toHaveLength(1);
      expect(queue[0]).toMatchObject({ reasonCode: "fake_details", emailHint: "r•••@gmail.com", status: "open" });
      expect(JSON.stringify(queue)).not.toContain("raj@gmail.com");

      // Blocking the email: the entry stores only a hash and a masked hint.
      const decided = await decideBookingReport(fixture.context, queue[0]!.id, { decision: "block", kind: "email" });
      expect(decided.status).toBe("blocked");
      const stored = await fixture.owner<{ value_hash: string; hint: string }[]>`select value_hash, hint from blocklist_entries where tenant_id = ${fixture.tenantId}`;
      expect(stored).toHaveLength(1);
      expect(JSON.stringify(stored)).not.toContain("raj");
      await expect(decideBookingReport(fixture.context, queue[0]!.id, { decision: "ignore" })).rejects.toMatchObject({ code: "report_decided" });

      // A new booking from a dotted, +tagged variant: normal confirmation, but nothing exists.
      const counts = async () => (await fixture.owner<{ appointments: number; patients: number; reservations: number }[]>`
        select (select count(*)::int from appointments where tenant_id = ${fixture.tenantId}) as appointments,
          (select count(*)::int from patients where tenant_id = ${fixture.tenantId}) as patients,
          (select count(*)::int from resource_reservations where tenant_id = ${fixture.tenantId} and state in ('held', 'confirmed')) as reservations`)[0]!;
      const before = await counts();
      const outboxBefore = (await fixture.owner<{ n: number }[]>`select count(*)::int as n from outbox_events where tenant_id = ${fixture.tenantId}`)[0]!.n;
      const t3 = startIn(26, 10);
      const key = randomUUID();
      const fake = await book(fixture.bookingInput(t3, plusMinutes(t3, 30), "R.aj+new@Gmail.com", { firstName: "Someone", lastName: "Else" }), key);
      const normal = await book(fixture.bookingInput(startIn(27, 10), plusMinutes(startIn(27, 10), 30), "honest@acme-corp.in"));
      expect(Object.keys(fake).sort()).toEqual(Object.keys(normal).sort());
      expect(fake.status).toBe("booked");
      expect(fake.startsAt).toBe(t3);
      const after = await counts();
      // Only the honest booking left rows behind.
      expect(after.appointments).toBe(before.appointments + 1);
      expect(after.patients).toBe(before.patients + 1);
      expect(after.reservations).toBe(before.reservations + 1);
      expect((await fixture.owner<{ n: number }[]>`select count(*)::int as n from outbox_events where tenant_id = ${fixture.tenantId}`)[0]!.n).toBeGreaterThan(outboxBefore);
      const none = await fixture.owner<{ n: number }[]>`select count(*)::int as n from appointments where id = ${fake.appointmentId}`;
      expect(none[0]!.n).toBe(0);
      // The slot was not held: someone else can book it.
      const other = await book(fixture.bookingInput(t3, plusMinutes(t3, 30), "free@acme-corp.in"));
      expect(other.status).toBe("booked");
      // One refused audit row with no contact details; a retry with the same key replays and adds none.
      const refused = await fixture.owner<{ outcome: string; metadata: Record<string, unknown>; appointment_id: string | null }[]>`
        select outcome, metadata, appointment_id from audit_events where tenant_id = ${fixture.tenantId} and action = 'booking.refused_blocklist'`;
      expect(refused).toHaveLength(1);
      expect(refused[0]!.outcome).toBe("refused");
      expect(refused[0]!.appointment_id).toBeNull();
      expect(JSON.stringify(refused[0]!.metadata)).not.toMatch(/gmail|raj|@|\d{6}/i);
      const replay = await book(fixture.bookingInput(t3, plusMinutes(t3, 30), "R.aj+new@Gmail.com", { firstName: "Someone", lastName: "Else" }), key);
      expect(replay.appointmentId).toBe(fake.appointmentId);

      // Removing the entry never restores the cancelled bookings.
      const entries = await listBlocklist(fixture.context);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.hint).toBe("r•••@gmail.com");
      await removeBlocklistEntry(fixture.context, entries[0]!.id);
      expect((await fixture.owner<{ n: number }[]>`select count(*)::int as n from appointments where series_id = ${seriesRow!.id} and status = 'cancelled'`)[0]!.n).toBe(2);
      await fixture.owner`delete from appointment_series where id = ${seriesRow!.id}`.catch(() => undefined);
    } finally {
      await fixture.owner`update appointments set series_id = null, series_index = null where tenant_id = ${fixture.tenantId} and service_id = ${fixture.serviceId}`;
      await fixture.owner`delete from appointment_series where tenant_id = ${fixture.tenantId} and service_id = ${fixture.serviceId}`;
      await tidy(fixture);
    }
  });

  it("blocks a whole domain, a phone, refuses a free-mail domain, and keeps businesses apart", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "SpamDomain" });
    try {
      await expect(addBlocklistEntry(fixture.context, { kind: "email_domain", value: "gmail.com", reasonCode: "other" })).rejects.toMatchObject({ code: "domain_too_broad" });
      await addBlocklistEntry(fixture.context, { kind: "email_domain", value: "@Troll.example", reasonCode: "abusive" });
      await addBlocklistEntry(fixture.context, { kind: "phone", value: "+91 90000 11111", reasonCode: "fake_details" });
      const t1 = startIn(13, 10);
      const t2 = startIn(13, 11);
      const t3 = startIn(13, 12);
      const countAppointments = async () => (await fixture.owner<{ n: number }[]>`select count(*)::int as n from appointments where tenant_id = ${fixture.tenantId} and service_id = ${fixture.serviceId}`)[0]!.n;
      await book(fixture.bookingInput(t1, plusMinutes(t1, 30), "anyone@troll.example"));
      await book(fixture.bookingInput(t2, plusMinutes(t2, 30), "clean@acme-corp.in", { phone: "090000 11111" }));
      expect(await countAppointments()).toBe(0);
      await book(fixture.bookingInput(t3, plusMinutes(t3, 30), "clean@acme-corp.in"));
      expect(await countAppointments()).toBe(1);
      // The other business sees none of this.
      expect(await listBlocklist(fixture.outsider)).toEqual([]);
      const crossRows = await fixture.owner<{ n: number }[]>`select count(*)::int as n from blocklist_entries where tenant_id = ${fixture.otherTenantId}`;
      expect(crossRows[0]!.n).toBe(0);
    } finally {
      await tidy(fixture);
    }
  });
});
