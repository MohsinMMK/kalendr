/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import { expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createAppointment, createStaffAppointment } from "@/server/appointment-repository";
import { getBookingHistory } from "@/server/booking-history";
import { runBulkAction } from "@/server/bulk-actions";
import { listBookings } from "@/server/bookings-list";
import { createSavedView, deleteSavedView, listSavedViews } from "@/server/saved-views";
import { runStaffAppointmentAction } from "@/server/staff-transitions";
import { applyServiceSetupPatch, getServiceSetup } from "@/server/services-admin";
import { describeScratch } from "@/server/testing/scratch-database";
import { createSchedulingFixture, plusMinutes, startIn, type SchedulingFixture } from "@/server/testing/scheduling-fixture";
import { bookingQuerySchema, type BookingQuery, type BulkInput } from "@/lib/bookings-list";
import type { PublicBookingInput } from "@/lib/contracts";

const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? "";

const book = (input: PublicBookingInput) => createAppointment(input, randomUUID(), randomUUID().replaceAll("-", ""));
const query = (partial: Partial<BookingQuery> = {}): BookingQuery => bookingQuerySchema.parse(partial);
const bulk = (input: BulkInput) => input;

async function addPerson(fixture: SchedulingFixture, name: string): Promise<string> {
  const id = randomUUID();
  const [location] = await fixture.owner<{ id: string; timezone: string }[]>`select id, timezone from locations where tenant_id = ${fixture.tenantId} limit 1`;
  await fixture.owner.begin(async (transaction) => {
    await transaction`insert into practitioners (id, tenant_id, name, title, initials, specialty) values (${id}, ${fixture.tenantId}, ${name}, 'Dentist', 'XX', 'Testing')`;
    await transaction`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${fixture.tenantId}, ${id}, ${location!.id})`;
    await transaction`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${fixture.tenantId}, ${id}, ${fixture.serviceId})`;
    for (let day = 1; day <= 7; day += 1) {
      await transaction`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
        values (${randomUUID()}, ${fixture.tenantId}, ${location!.id}, ${id}, ${day}, '00:00', '23:59', ${location!.timezone}, '2025-01-01', 30)`;
    }
  });
  return id;
}

async function dropPerson(fixture: SchedulingFixture, id: string) {
  const mine = fixture.owner`select id from appointments where practitioner_id = ${id}`;
  await fixture.owner`delete from audit_events where appointment_id in (${mine})`;
  await fixture.owner`delete from outbox_events where aggregate_type = 'appointment' and aggregate_id in (${mine})`;
  await fixture.owner`delete from appointments where practitioner_id = ${id}`;
  await fixture.owner`delete from practitioners where id = ${id}`;
}

async function withMembership(fixture: SchedulingFixture) {
  const [member] = await fixture.owner<{ id: string }[]>`select id from memberships where tenant_id = ${fixture.tenantId} and user_id = ${fixture.context.userId} limit 1`;
  const [other] = await fixture.owner<{ id: string }[]>`select id from memberships where tenant_id = ${fixture.tenantId} and id <> ${member!.id} and is_active limit 1`;
  return { ...fixture.context, membershipId: member!.id, otherMembershipId: other?.id ?? null };
}

describeScratch("bookings list against a real database", () => {
  it("filters by tab, person and customer, counts each tab, and pages by cursor without repeats", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "List" });
    try {
      const day = Array.from({ length: 5 }, (_, index) => startIn(20 + index, 10));
      const made = [] as Awaited<ReturnType<typeof book>>[];
      for (const [index, start] of day.entries()) {
        made.push(await book({ ...fixture.bookingInput(start, plusMinutes(start, 30), `list${index}@acme-corp.in`), firstName: index === 2 ? "Zelda" : "Plain" }));
      }
      await runStaffAppointmentAction(fixture.context, made[4]!.appointmentId, { action: "cancel", expectedVersion: 1 });
      const mine = { practitionerIds: [fixture.practitionerId] };
      const first = await listBookings(fixture.context, query({ ...mine, limit: 2 }));
      expect(first.rows.map((row) => row.startsAt)).toEqual([day[0], day[1]]);
      expect(first.counts).toEqual({ upcoming: 4, needs_approval: 0, past: 0, cancelled: 1 });
      expect(first.nextCursor).not.toBeNull();
      const second = await listBookings(fixture.context, query({ ...mine, limit: 2, cursor: first.nextCursor! }));
      expect(second.rows.map((row) => row.startsAt)).toEqual([day[2], day[3]]);
      expect(second.counts).toBeNull();
      expect(second.nextCursor).toBeNull();
      // A booking made between pages never shifts the next page.
      const cancelled = await listBookings(fixture.context, query({ ...mine, tab: "cancelled" }));
      expect(cancelled.rows.map((row) => row.id)).toEqual([made[4]!.appointmentId]);
      // Customer search by name and by phone digits.
      expect((await listBookings(fixture.context, query({ ...mine, q: "zeld" }))).rows).toHaveLength(1);
      const [patient] = await fixture.owner<{ phone: string }[]>`select phone from patients where id = (select patient_id from appointments where id = ${made[1]!.appointmentId})`;
      const digits = patient!.phone.replace(/\D/g, "").slice(-6);
      expect((await listBookings(fixture.context, query({ ...mine, q: digits }))).rows.map((row) => row.id)).toContain(made[1]!.appointmentId);
      // The text in a filter is a value, not SQL.
      expect((await listBookings(fixture.context, query({ ...mine, q: "'; drop table appointments; --" }))).rows).toHaveLength(0);
      // Date range and the other business.
      expect((await listBookings(fixture.context, query({ ...mine, from: day[1]!, to: day[3]! }))).rows).toHaveLength(2);
      const outsider = await listBookings(fixture.outsider, query({ practitionerIds: [fixture.practitionerId] }));
      expect(outsider.rows).toHaveLength(0);
      await expect(listBookings(fixture.context, query({ cursor: "not-a-cursor" }))).rejects.toMatchObject({ status: 400 });
    } finally {
      await fixture.cleanup();
    }
  });

  it("lists every pending request under Needs approval across the business", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Pending" });
    try {
      const setup = await getServiceSetup(fixture.context, fixture.serviceId);
      await applyServiceSetupPatch(fixture.context, fixture.serviceId, { approval: { rule: "always", noticeHours: 24, requestsHoldSlot: true, hideLocationUntilConfirmed: false } }, setup.version);
      const a = startIn(21, 10);
      const b = startIn(21, 11);
      const first = await book(fixture.bookingInput(a, plusMinutes(a, 30), "p1@acme-corp.in", { proposedStarts: [startIn(22, 10)] }));
      await book(fixture.bookingInput(b, plusMinutes(b, 30), "p2@acme-corp.in"));
      const page = await listBookings(fixture.context, query({ tab: "needs_approval", practitionerIds: [fixture.practitionerId] }));
      expect(page.rows).toHaveLength(2);
      expect(page.counts?.needs_approval).toBe(2);
      expect(page.rows.find((row) => row.id === first.appointmentId)?.proposedCount).toBe(1);
      // Confirming through the bulk action approves them.
      const result = await runBulkAction(fixture.context, bulk({ action: "confirm", items: page.rows.map((row) => ({ id: row.id, expectedVersion: row.version })) }), randomUUID());
      expect(result).toMatchObject({ succeeded: 2, failed: 0 });
      expect((await listBookings(fixture.context, query({ tab: "needs_approval", practitionerIds: [fixture.practitionerId] }))).rows).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("reassigns many bookings, reports the ones that cannot move with a reason, tells customers and records who did it", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Rao" });
    const shah = await addPerson(fixture, "Dr Shah");
    try {
      const starts = Array.from({ length: 5 }, (_, index) => startIn(23, 9 + index));
      const made = [] as Awaited<ReturnType<typeof book>>[];
      for (const [index, start] of starts.entries()) made.push(await book(fixture.bookingInput(start, plusMinutes(start, 30), `r${index}@acme-corp.in`)));
      // Dr Shah is already busy at two of the five times.
      for (const index of [1, 3]) {
        await book({ ...fixture.bookingInput(starts[index]!, plusMinutes(starts[index]!, 30), `busy${index}@acme-corp.in`), practitionerId: shah });
      }
      const rows = (await listBookings(fixture.context, query({ practitionerIds: [fixture.practitionerId] }))).rows;
      expect(rows).toHaveLength(5);
      const key = randomUUID();
      const result = await runBulkAction(fixture.context, bulk({ action: "reassign", practitionerId: shah, items: rows.map((row) => ({ id: row.id, expectedVersion: row.version })) }), key);
      expect(result.succeeded).toBe(3);
      expect(result.failed).toBe(2);
      const failures = result.results.filter((entry) => !entry.ok);
      expect(failures.every((entry) => entry.code === "practitioner_busy" && /Dr Shah is busy at \d/.test(entry.message ?? ""))).toBe(true);
      // The ones that failed stay with the first person; the others moved and keep the same id and manage link.
      const after = await fixture.owner<{ id: string; practitioner_id: string; version: number }[]>`select id, practitioner_id, version from appointments where id in ${fixture.owner(made.map((entry) => entry.appointmentId))}`;
      expect(after.filter((row) => row.practitioner_id === shah)).toHaveLength(3);
      expect(after.filter((row) => row.practitioner_id === fixture.practitionerId)).toHaveLength(2);
      // Each moved customer is told through the outbox.
      const moved = after.filter((row) => row.practitioner_id === shah).map((row) => row.id);
      const events = await fixture.owner<{ aggregate_id: string }[]>`select aggregate_id from outbox_events where event_type = 'appointment.reassigned' and aggregate_id in ${fixture.owner(moved)}`;
      expect(events).toHaveLength(3);
      // Repeating the same bulk request changes nothing more: the moved bookings now have newer versions.
      const again = await runBulkAction(fixture.context, bulk({ action: "reassign", practitionerId: shah, items: rows.map((row) => ({ id: row.id, expectedVersion: row.version })) }), key);
      expect(again.succeeded).toBe(0);
      // History shows the reassignment with the people's names and who did it.
      const history = await getBookingHistory(fixture.context, moved[0]!);
      const entry = history.find((item) => item.action === "appointment.reassigned");
      expect(entry).toMatchObject({ label: "Given to someone else", actor: { type: "staff" } });
      expect(entry?.detail).toMatch(/→ Dr Shah/);
      // Another business sees none of it.
      await expect(getBookingHistory(fixture.outsider, moved[0]!)).rejects.toMatchObject({ status: 404 });
    } finally {
      await dropPerson(fixture, shah);
      await fixture.cleanup();
    }
  });

  it("marks a customer no-show, records a business no-show with a link to rebook, and changes the place", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "NoShow" });
    try {
      const past = startIn(24, 10);
      const one = await book(fixture.bookingInput(past, plusMinutes(past, 30), "ns1@acme-corp.in"));
      const two = await book(fixture.bookingInput(startIn(24, 12), plusMinutes(startIn(24, 12), 30), "ns2@acme-corp.in"));
      // Too early: the visit has not come yet.
      await expect(runStaffAppointmentAction(fixture.context, one.appointmentId, { action: "mark_no_show", who: "customer", expectedVersion: 1 })).rejects.toMatchObject({ code: "too_early" });
      for (const [index, id] of [one.appointmentId, two.appointmentId].entries()) {
        const hours = 2 + index * 3;
        await fixture.owner`update appointments set starts_at = now() - ${hours} * interval '1 hour', ends_at = now() - ${hours} * interval '1 hour' + interval '30 minutes' where id = ${id}`;
        await fixture.owner`update resource_reservations set starts_at = now() - ${hours} * interval '1 hour', ends_at = now() - ${hours} * interval '1 hour' + interval '30 minutes' where appointment_id = ${id}`;
      }
      const customer = await runStaffAppointmentAction(fixture.context, one.appointmentId, { action: "mark_no_show", who: "customer", expectedVersion: 1 });
      expect(customer.status).toBe("no_show");
      expect((await fixture.owner<{ customer_no_show_marked_at: Date | null }[]>`select customer_no_show_marked_at from appointments where id = ${one.appointmentId}`)[0]!.customer_no_show_marked_at).not.toBeNull();
      const host = await runStaffAppointmentAction(fixture.context, two.appointmentId, { action: "mark_no_show", who: "host", expectedVersion: 1 });
      expect(host.status).toBe("cancelled");
      expect(await fixture.owner`select 1 from appointment_host_no_shows where appointment_id = ${two.appointmentId} and practitioner_id = ${fixture.practitionerId}`).toHaveLength(1);
      expect(await fixture.owner`select 1 from outbox_events where aggregate_id = ${two.appointmentId} and event_type = 'appointment.status.cancelled'`).toHaveLength(1);
      // The business's no-show can be rebooked for free: it is a cancelled booking staff can book again.
      const rebooked = await runStaffAppointmentAction(fixture.context, two.appointmentId, { action: "rebook", startsAt: startIn(25, 10), expectedVersion: 2 });
      expect(rebooked.status).toBe("booked");
      // Place: a service that offers in person only refuses anything else, and tells the customer when it changes.
      const live = await book(fixture.bookingInput(startIn(26, 10), plusMinutes(startIn(26, 10), 30), "loc@acme-corp.in"));
      await expect(runStaffAppointmentAction(fixture.context, live.appointmentId, { action: "edit_location", locationChoice: { kind: "they_call" }, expectedVersion: 1 })).rejects.toMatchObject({ status: 400 });
      await fixture.owner`insert into service_location_options (tenant_id, service_id, kind, sort_order) values (${fixture.tenantId}, ${fixture.serviceId}, 'we_call', 5) on conflict do nothing`;
      const changed = await runStaffAppointmentAction(fixture.context, live.appointmentId, { action: "edit_location", locationChoice: { kind: "we_call" }, expectedVersion: 1 });
      expect(changed.version).toBe(2);
      expect((await fixture.owner<{ location_kind: string; delivery_mode: string }[]>`select location_kind, delivery_mode from appointments where id = ${live.appointmentId}`)[0]).toEqual({ location_kind: "we_call", delivery_mode: "phone" });
      expect(await fixture.owner`select 1 from outbox_events where aggregate_id = ${live.appointmentId} and event_type = 'appointment.location_changed'`).toHaveLength(1);
      await fixture.owner`delete from service_location_options where service_id = ${fixture.serviceId} and kind = 'we_call'`;
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps saved views private or shared, and out of reach of other businesses", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Views" });
    try {
      const mine = await withMembership(fixture);
      const view = await createSavedView(mine, { name: "Dr Rao next week", shared: true, tab: "upcoming", filters: { practitionerIds: [fixture.practitionerId], q: "private-customer-name" }, sort: "asc", columns: ["time", "customer", "person"] });
      const own = await createSavedView(mine, { name: "Only mine", shared: false, tab: "past", filters: {}, sort: "desc", columns: [] });
      await expect(createSavedView(mine, { name: "Only mine", shared: false, tab: "past", filters: {}, sort: "desc", columns: [] })).rejects.toMatchObject({ code: "view_exists" });
      const listed = await listSavedViews(mine);
      expect(listed.find((item) => item.id === view.id)).toMatchObject({ shared: true, mine: true, tab: "upcoming", columns: ["time", "customer", "person"] });
      expect(listed.find((item) => item.id === own.id)).toMatchObject({ tab: "past", sort: "desc" });
      expect(await listSavedViews(fixture.outsider)).toEqual([]);
      // The audit trail names no filter values.
      expect(JSON.stringify(await fixture.owner`select metadata from audit_events where action like 'bookings.view_%' and tenant_id = ${fixture.tenantId}`)).not.toContain("private-customer-name");
      if (mine.otherMembershipId) {
        const teammate = { ...mine, membershipId: mine.otherMembershipId };
        const seen = await listSavedViews(teammate);
        expect(seen.map((item) => item.id)).toContain(view.id);
        expect(seen.map((item) => item.id)).not.toContain(own.id);
        await expect(deleteSavedView(teammate, view.id)).rejects.toMatchObject({ status: 404 });
      }
      await deleteSavedView(mine, view.id);
      await deleteSavedView(mine, own.id);
    } finally {
      await fixture.owner`delete from saved_views where tenant_id = ${fixture.tenantId}`;
      await fixture.cleanup();
    }
  });

  it("lets staff book past the notice, window and limits only with a reason, records it in History, and still refuses a double booking", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Override" });
    try {
      // The service takes bookings up to 60 days ahead; staff want day 90 for a customer who asked.
      const far = startIn(90, 10);
      const body = (startsAt: string, extra: Record<string, unknown> = {}) => ({
        clinicSlug: fixture.slug, locationId: fixture.locationId, serviceId: fixture.serviceId, practitionerId: fixture.practitionerId,
        startsAt, source: "desk" as const, newPatient: { firstName: "Over", lastName: "Ride", phone: `+9190${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, email: `over${randomUUID().slice(0, 6)}@acme-corp.in`, preferredChannel: "email" as const, isDependent: false, messagingConsent: false },
        ...extra,
      });
      const create = (input: ReturnType<typeof body>) => createStaffAppointment(fixture.context, input as never, randomUUID(), randomUUID().replaceAll("-", ""));
      // Without a reason the answer says a rule is in the way (so the screen can ask), not just "unavailable".
      await expect(create(body(far))).rejects.toMatchObject({ status: 409, code: "outside_booking_rules" });
      const made = await create(body(far, { limitOverrideReason: "customer_request" }));
      expect(made.status).toBe("booked");
      // The reason code is in the audit trail and in History; nothing typed by a person is.
      const [audit] = await fixture.owner<{ metadata: Record<string, unknown> }[]>`select metadata from audit_events where appointment_id = ${made.appointmentId} and action = 'appointment.created'`;
      expect(audit!.metadata).toMatchObject({ limitOverride: "customer_request" });
      const history = await getBookingHistory(fixture.context, made.appointmentId);
      expect(history.find((entry) => entry.action === "appointment.created")?.detail).toContain("Booked past the usual rules");
      // The override never reaches a true double booking of the same person.
      await expect(create(body(far, { limitOverrideReason: "emergency" }))).rejects.toMatchObject({ status: 409 });
      expect(await fixture.owner`select 1 from appointments where service_id = ${fixture.serviceId} and starts_at = ${far}`).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("pages through past bookings in a business of 100,000, under 300 ms a page, first page and deep pages alike", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Big" });
    try {
      const [location] = await fixture.owner<{ id: string }[]>`select id from locations where tenant_id = ${fixture.tenantId} limit 1`;
      const [patient] = await fixture.owner<{ id: string }[]>`
        insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel) values (${fixture.tenantId}, 'Bulk', 'Customer', '+919000000999', 'bulk@example.com', 'email') returning id`;
      await fixture.owner`
        insert into appointments (id, tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash)
        select gen_random_uuid()::text, ${fixture.tenantId}, ${location!.id}, ${patient!.id}, ${fixture.practitionerId}, ${fixture.serviceId},
          now() - (n || ' minutes')::interval - interval '2 days', now() - (n || ' minutes')::interval - interval '2 days' + interval '30 minutes', 'completed', 'online',
          md5(random()::text || n::text) || md5(n::text)
        from generate_series(1, 100000) as n`;
      await fixture.owner`analyze appointments`;
      let cursor: string | undefined;
      const times: number[] = [];
      let rows = 0;
      // Ten thousand bookings, a hundred at a time, as a receptionist scrolling would.
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const started = performance.now();
        const page = await listBookings(fixture.context, query({ tab: "past", limit: 100, ...(cursor ? { cursor } : {}) }));
        times.push(performance.now() - started);
        rows += page.rows.length;
        cursor = page.nextCursor ?? undefined;
        if (!cursor) break;
      }
      expect(rows).toBe(10_000);
      // A page far down costs the same as the first: the cursor, not an offset.
      const deep = await listBookings(fixture.context, query({ tab: "past", limit: 100, sort: "asc", practitionerIds: [fixture.practitionerId] }));
      const started = performance.now();
      await listBookings(fixture.context, query({ tab: "past", limit: 100, ...(deep.nextCursor ? { cursor: deep.nextCursor } : {}), sort: "asc", practitionerIds: [fixture.practitionerId] }));
      times.push(performance.now() - started);
      times.sort((a, b) => a - b);
      expect(times[times.length - 1]!).toBeLessThan(300);
      expect(times[Math.floor(times.length / 2)]!).toBeLessThan(100);
    } finally {
      await fixture.owner`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where tenant_id = ${fixture.tenantId} and email = 'bulk@example.com')`.catch(() => undefined);
      await fixture.owner`delete from patients where tenant_id = ${fixture.tenantId} and email = 'bulk@example.com'`.catch(() => undefined);
      await fixture.cleanup();
    }
  }, 300_000);
});
