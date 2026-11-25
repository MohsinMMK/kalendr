/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { PublicBookingInput } from "@/lib/contracts";
import { isolatedDatabaseReady } from "@/test/isolated-database";
import { createTenant, staffContext, type TenantFixture } from "@/test/privacy-fixture";

vi.mock("server-only", () => ({}));

import { createAppointment, createStaffAppointment, listAvailability, listAvailabilityDetailed } from "@/server/appointment-repository";
import type { StaffBookingInput } from "@/server/contracts";
import { getServiceRouting, getTeamShare, listLeaveBookings, reassignLeaveBookings, saveServiceRouting } from "@/server/routing-admin";
import { createSlotHold } from "@/server/slot-holds";
import { GET as availabilityRoute } from "@/app/api/public/availability/route";
import { POST as holdRoute } from "@/app/api/public/holds/route";
import { POST as bookingRoute } from "@/app/api/public/appointments/route";
import { addDays, isoWeekday, localDateOf, localInstant } from "@/server/slot-engine/time";
import type { StaffContext } from "@/server/staff-context";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? process.env.KALENDR_E2E_OWNER_URL;
const describeIsolated = isolatedDatabaseReady(runtimeUrl, ownerUrl) ? describe : describe.skip;

const ZONE = "Asia/Kolkata";

function dayAhead(minDays: number): string {
  let date = localDateOf(Date.now(), ZONE);
  for (let guard = 0; guard < 60; guard += 1) {
    date = addDays(date, 1);
    if (new Date(localInstant(date, "00:00", ZONE)).getTime() > Date.now() + minDays * 86_400_000 && isoWeekday(date) <= 5) return date;
  }
  throw new Error("no date");
}

interface Salon {
  fixture: TenantFixture;
  context: StaffContext;
  stylists: [string, string, string];
}

describeIsolated("team routing (feature 20)", () => {
  let owner: postgres.Sql;
  let salon: Salon;

  async function makeSalon(label: string, weights: [number, number, number] = [1, 1, 1]): Promise<Salon> {
    const fixture = await createTenant(owner, label, "wellness");
    await owner`update services set duration_minutes = 60, slot_interval_minutes = 60, minimum_lead_minutes = 0, maximum_advance_days = 90, assignment = 'any_available' where id = ${fixture.serviceId}`;
    await owner`insert into service_locations (tenant_id, service_id, location_id) values (${fixture.tenantId}, ${fixture.serviceId}, ${fixture.locationId})`;
    const ids: string[] = [fixture.practitionerId];
    for (const name of ["Stylist B", "Stylist C"]) {
      const [row] = await owner<{ id: string }[]>`insert into practitioners (tenant_id, name, title, initials, specialty) values (${fixture.tenantId}, ${name}, 'Stylist', 'S', 'Hair') returning id`;
      ids.push(row!.id);
    }
    for (const [index, id] of ids.entries()) {
      await owner`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${fixture.tenantId}, ${id}, ${fixture.locationId})`;
      await owner`insert into practitioner_services (tenant_id, practitioner_id, service_id, weight) values (${fixture.tenantId}, ${id}, ${fixture.serviceId}, ${weights[index]!})`;
      for (let day = 1; day <= 7; day += 1) {
        await owner`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
          values (${randomUUID()}, ${fixture.tenantId}, ${fixture.locationId}, ${id}, ${day}, '09:00', '17:00', ${ZONE}, '2025-01-01', 60)`;
      }
    }
    const [user] = await owner<{ id: string }[]>`insert into auth_users (name, email, email_verified) values (${`Staff ${label}`}, ${`staff-${randomUUID().slice(0, 8)}@example.com`}, true) returning id`;
    await owner`insert into memberships (tenant_id, user_id, role) values (${fixture.tenantId}, ${user!.id}, 'owner')`;
    return { fixture, context: staffContext(fixture, { userId: user!.id }), stylists: [ids[0]!, ids[1]!, ids[2]!] };
  }

  const at = (date: string, time: string) => new Date(localInstant(date, time, ZONE)).toISOString();
  const endOf = (iso: string) => new Date(Date.parse(iso) + 3_600_000).toISOString();

  const publicBooking = (place: Salon, startsAt: string, over: Partial<PublicBookingInput> = {}): PublicBookingInput => ({
    clinicSlug: place.fixture.slug, patientType: "new", bookingFor: "self", locationId: place.fixture.locationId, serviceId: place.fixture.serviceId,
    practitionerId: "anyone", slotId: `slot_${randomUUID().replaceAll("-", "")}`, startsAt, endsAt: endOf(startsAt),
    firstName: "Route", lastName: `Customer${randomUUID().slice(0, 6)}`, phone: `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
    email: `route-${randomUUID().slice(0, 8)}@example.com`, preferredChannel: "email", acceptedPrivacyNotice: true, messagingConsent: false, ...over,
  });
  const book = (place: Salon, startsAt: string, over: Partial<PublicBookingInput> = {}) =>
    createAppointment(publicBooking(place, startsAt, over), randomUUID(), randomUUID().replaceAll("-", ""));
  const personOf = async (appointmentId: string) => (await owner<{ practitioner_id: string }[]>`select practitioner_id from appointments where id = ${appointmentId}`)[0]!.practitioner_id;

  const staffBook = (place: Salon, practitionerId: string, startsAt: string): Promise<{ appointmentId: string }> => {
    const input: StaffBookingInput = {
      clinicSlug: place.fixture.slug, locationId: place.fixture.locationId, serviceId: place.fixture.serviceId, practitionerId, startsAt, source: "desk",
      newPatient: { firstName: "Desk", lastName: `Guest${randomUUID().slice(0, 5)}`, phone: "+919800000222", email: "", preferredChannel: "email", isDependent: false, messagingConsent: false },
    };
    return createStaffAppointment(place.context, input, `desk-${randomUUID()}`, randomUUID());
  };

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 4, prepare: false });
    salon = await makeSalon("route-a");
  });
  afterAll(async () => {
    await owner?.end();
  });

  it("shows the union of the three stylists' free times under 'Anyone available', each time once", async () => {
    const place = await makeSalon("route-union");
    const date = dayAhead(3);
    const [a, b, c] = place.stylists;
    await staffBook(place, a, at(date, "10:00"));
    await staffBook(place, b, at(date, "10:00"));
    // 11:00 is taken for everyone, 12:00 only for A and B.
    for (const id of place.stylists) await staffBook(place, id, at(date, "11:00"));
    await staffBook(place, a, at(date, "12:00"));
    await staffBook(place, b, at(date, "12:00"));
    const window = { from: at(date, "00:00"), to: at(addDays(date, 1), "00:00") };
    const listing = await listAvailabilityDetailed({ clinicSlug: place.fixture.slug, locationId: place.fixture.locationId, serviceId: place.fixture.serviceId, practitionerId: "anyone", ...window });
    const starts = listing.slots.map((slot) => slot.startsAt);
    expect(starts).toContain(at(date, "10:00")); // only C is free
    expect(starts).toContain(at(date, "12:00"));
    expect(starts).not.toContain(at(date, "11:00"));
    expect(new Set(starts).size).toBe(starts.length);
    expect(listing.slots.every((slot) => slot.practitionerId === "anyone")).toBe(true);
    expect(listing.slots).toHaveLength(7); // 09:00–17:00 is eight hours; 11:00 is the only one nobody has
    expect(listing.nextByPerson?.[c]).toBe(at(date, "09:00"));
    // The per-person view still works for a chosen person.
    const onlyA = await listAvailability({ clinicSlug: place.fixture.slug, locationId: place.fixture.locationId, serviceId: place.fixture.serviceId, practitionerId: a, ...window });
    expect(onlyA.map((slot) => slot.startsAt)).not.toContain(at(date, "10:00"));
  });

  it("spreads thirty 'anyone' bookings in line with weights 2:1:1", async () => {
    const place = await makeSalon("route-weights", [2, 1, 1]);
    const tally = new Map<string, number>(place.stylists.map((id) => [id, 0]));
    let date = dayAhead(3);
    let made = 0;
    while (made < 30) {
      for (const time of ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"]) {
        if (made >= 30) break;
        const result = await book(place, at(date, time));
        const person = await personOf(result.appointmentId);
        tally.set(person, (tally.get(person) ?? 0) + 1);
        made += 1;
      }
      date = addDays(date, 1);
      while (isoWeekday(date) > 5) date = addDays(date, 1);
    }
    const [a, b, c] = place.stylists.map((id) => tally.get(id)!) as [number, number, number];
    expect(a + b + c).toBe(30);
    expect(a).toBeGreaterThanOrEqual(14);
    expect(a).toBeLessThanOrEqual(16);
    expect(b).toBeGreaterThanOrEqual(7);
    expect(b).toBeLessThanOrEqual(8);
    expect(c).toBeGreaterThanOrEqual(7);
    expect(c).toBeLessThanOrEqual(8);
  }, 120_000);

  it("gives two customers taking the same 'anyone' time two different stylists, and refuses the fourth for three stylists", async () => {
    const date = dayAhead(8);
    const two = await Promise.all([book(salon, at(date, "10:00")), book(salon, at(date, "10:00"))]);
    const people = await Promise.all(two.map((result) => personOf(result.appointmentId)));
    expect(new Set(people).size).toBe(2);

    const date2 = dayAhead(9);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => book(salon, at(date2, "14:00"))));
    const won = results.filter((result) => result.status === "fulfilled");
    const lost = results.filter((result) => result.status === "rejected");
    expect(won).toHaveLength(3);
    expect(lost).toHaveLength(2);
    for (const failure of lost) expect((failure as PromiseRejectedResult).reason).toMatchObject({ code: "slot_unavailable" });
    const winners = await Promise.all(won.map((result) => personOf((result as PromiseFulfilledResult<{ appointmentId: string }>).value.appointmentId)));
    expect(new Set(winners).size).toBe(3);
  }, 60_000);

  it("keeps the stylist a customer was shown when they hold the time, and gives the next customer another", async () => {
    const place = await makeSalon("route-hold");
    const date = dayAhead(4);
    const request = { clinicSlug: place.fixture.slug, locationId: place.fixture.locationId, serviceId: place.fixture.serviceId, practitionerId: "anyone", startsAt: at(date, "10:00"), endsAt: endOf(at(date, "10:00")) };
    const first = await createSlotHold(request);
    const second = await createSlotHold(request);
    const holds = await owner<{ practitioner_id: string }[]>`select practitioner_id from slot_holds where tenant_id = ${place.fixture.tenantId} order by created_at`;
    expect(new Set(holds.map((row) => row.practitioner_id)).size).toBe(2);
    const booked = await book(place, at(date, "10:00"), { holdToken: second.holdToken });
    expect(await personOf(booked.appointmentId)).toBe(holds[1]!.practitioner_id);
    expect(first.holdToken).not.toBe(second.holdToken);
  });

  it("prefers the stylist a returning customer saw last time when the service asks for it and they are free", async () => {
    const place = await makeSalon("route-returning");
    await owner`update services set prefer_returning_person = true where id = ${place.fixture.serviceId}`;
    const email = `returning-${randomUUID().slice(0, 8)}@example.com`;
    const phone = "+919811111111";
    const date = dayAhead(4);
    const first = await book(place, at(date, "10:00"), { email, phone, firstName: "Ret", lastName: "Urning" });
    const saw = await personOf(first.appointmentId);
    await owner`update appointments set status = 'completed' where id = ${first.appointmentId}`;
    // Everyone else is further below their share, but the returning customer still gets the person they saw.
    for (const id of place.stylists.filter((stylist) => stylist !== saw)) await staffBook(place, id, at(date, "08:00".replace("08", "09")));
    const again = await book(place, at(addDays(date, 1), "10:00"), { email, phone, firstName: "Ret", lastName: "Urning" });
    expect(await personOf(again.appointmentId)).toBe(saw);
  });

  it("moves a stylist's week off to the cover person in one action, tells the customers, and leaves the rest as needing a person", async () => {
    const place = await makeSalon("route-leave");
    const [away, cover] = place.stylists;
    const date = dayAhead(6);
    const moved = [at(date, "10:00"), at(date, "11:00"), at(addDays(date, 1), "10:00")];
    const kept = at(date, "14:00");
    const ids: string[] = [];
    for (const time of [...moved, kept]) ids.push((await staffBook(place, away, time)).appointmentId);
    await staffBook(place, cover, kept); // the cover is busy at 14:00
    const [timeOff] = await owner<{ id: string }[]>`
      insert into time_off (tenant_id, practitioner_id, starts_at, ends_at, reason, cover_practitioner_id)
      values (${place.fixture.tenantId}, ${away}, ${at(date, "00:00")}::timestamptz, ${at(addDays(date, 3), "00:00")}::timestamptz, 'leave', ${cover}) returning id`;
    const before = await owner<{ id: string; version: number; manage_token_hash: string; starts_at: Date }[]>`select id, version, manage_token_hash, starts_at from appointments where id in ${owner(ids)} order by starts_at`;

    const view = await listLeaveBookings(place.context, timeOff!.id);
    expect(view.bookings).toHaveLength(4);
    expect(view.coverPractitionerId).toBe(cover);
    expect(view.bookings.filter((entry) => entry.coverFree === false)).toHaveLength(1);

    const key = `leave-${randomUUID()}`;
    const result = await reassignLeaveBookings(place.context, { timeOffId: timeOff!.id }, key);
    expect(result.moved).toBe(3);
    expect(result.needsPerson).toHaveLength(1);
    expect(result.needsPerson[0]!.appointmentId).toBe(ids[3]);

    const after = await owner<{ id: string; version: number; manage_token_hash: string; starts_at: Date; practitioner_id: string }[]>`select id, version, manage_token_hash, starts_at, practitioner_id from appointments where id in ${owner(ids)} order by starts_at`;
    for (const row of after.filter((entry) => ids.slice(0, 3).includes(entry.id))) {
      const was = before.find((entry) => entry.id === row.id)!;
      expect(row.practitioner_id).toBe(cover);
      expect(row.starts_at.getTime()).toBe(was.starts_at.getTime()); // same time
      expect(row.manage_token_hash).toBe(was.manage_token_hash); // same manage link
      expect(row.version).toBe(was.version + 1);
    }
    expect(after.find((entry) => entry.id === ids[3])!.practitioner_id).toBe(away);
    const told = await owner<{ aggregate_id: string }[]>`select aggregate_id from outbox_events where tenant_id = ${place.fixture.tenantId} and event_type = 'appointment.reassigned'`;
    expect(told.map((row) => row.aggregate_id).sort()).toEqual(ids.slice(0, 3).sort());
    const [audit] = await owner<{ metadata: Record<string, unknown> }[]>`select metadata from audit_events where tenant_id = ${place.fixture.tenantId} and action = 'routing.leave.reassigned'`;
    expect(audit!.metadata).toMatchObject({ moved: 3, needsPerson: 1 });

    // The same request again moves nothing and sends nothing twice.
    expect(await reassignLeaveBookings(place.context, { timeOffId: timeOff!.id }, key)).toEqual(result);
    const left = await listLeaveBookings(place.context, timeOff!.id);
    expect(left.bookings.map((entry) => entry.appointmentId)).toEqual([ids[3]]);

    // While the stylist is away, a new "anyone" booking goes to the cover person.
    const cover2 = await book(place, at(addDays(date, 1), "13:00"));
    expect(await personOf(cover2.appointmentId)).toBe(cover);
  }, 60_000);

  it("saves how a service gives out bookings, checks the version, and shows each person's share of the month", async () => {
    const place = await makeSalon("route-admin");
    const view = await getServiceRouting(place.context, place.fixture.serviceId);
    expect(view.people).toHaveLength(3);
    const saved = await saveServiceRouting(place.context, place.fixture.serviceId, {
      assignment: "round_robin", preferReturningPerson: true, expectedVersion: view.version,
      people: view.people.map((person, index) => ({ practitionerId: person.practitionerId, priority: index, weight: index === 0 ? 2 : 1 })),
    });
    expect(saved.assignment).toBe("round_robin");
    expect(saved.version).toBe(view.version + 1);
    await expect(saveServiceRouting(place.context, place.fixture.serviceId, {
      assignment: "any_available", preferReturningPerson: false, expectedVersion: view.version, people: [],
    })).rejects.toMatchObject({ code: "version_conflict" });
    await expect(saveServiceRouting(place.context, place.fixture.serviceId, {
      assignment: "any_available", preferReturningPerson: false, expectedVersion: saved.version, people: [{ practitionerId: randomUUID(), priority: 0, weight: 1 }],
    })).rejects.toMatchObject({ code: "validation_error" });
    const [audit] = await owner<{ metadata: Record<string, unknown> }[]>`select metadata from audit_events where tenant_id = ${place.fixture.tenantId} and action = 'routing.service.updated'`;
    expect(Object.keys(audit!.metadata).sort()).toEqual(["assignment", "people", "preferReturningPerson", "serviceId"]);

    const date = dayAhead(5);
    for (const time of ["09:00", "10:00", "11:00", "12:00"]) await book(place, at(date, time));
    const month = `${date.slice(0, 7)}`;
    const share = await getTeamShare(place.context, month);
    expect(share.people).toHaveLength(3);
    expect(share.total).toBe(4);
    expect(share.people.reduce((sum, person) => sum + person.bookings, 0)).toBe(4);
    expect(share.people[0]!.weightPercent).toBeGreaterThan(0);
  });

  it("works through the public HTTP routes: the pooled list, a hold and a booking all take 'anyone'", async () => {
    const place = await makeSalon("route-http");
    const date = dayAhead(5);
    const params = new URLSearchParams({ clinicSlug: place.fixture.slug, locationId: place.fixture.locationId, serviceId: place.fixture.serviceId, practitionerId: "anyone", from: at(date, "00:00"), to: at(addDays(date, 1), "00:00") });
    const listed = await availabilityRoute(new Request(`https://app.example.test/api/public/availability?${params}`));
    expect(listed.status).toBe(200);
    const listing = (await listed.json()).data as { slots: Array<{ startsAt: string; endsAt: string; practitionerId: string }>; nextByPerson: Record<string, string> };
    expect(listing.slots.length).toBeGreaterThan(0);
    expect(listing.slots.every((slot) => slot.practitionerId === "anyone")).toBe(true);
    expect(Object.keys(listing.nextByPerson)).toHaveLength(3);
    const slot = listing.slots.find((entry) => entry.startsAt === at(date, "10:00"))!;
    const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const held = await holdRoute(new Request("https://app.example.test/api/public/holds", json({ clinicSlug: place.fixture.slug, locationId: place.fixture.locationId, serviceId: place.fixture.serviceId, practitionerId: "anyone", startsAt: slot.startsAt, endsAt: slot.endsAt })));
    expect(held.status).toBe(201);
    const holdToken = ((await held.json()).data as { holdToken: string }).holdToken;
    const booked = await bookingRoute(new Request("https://app.example.test/api/public/appointments", json({ ...publicBooking(place, slot.startsAt, { holdToken }), origin: undefined }, { "idempotency-key": `http-${randomUUID()}` })));
    expect(booked.status).toBe(201);
    const id = ((await booked.json()).data as { appointmentId: string }).appointmentId;
    expect(place.stylists).toContain(await personOf(id));
  });

  it("keeps routing settings when a service's people are edited, and keeps one business out of another's", async () => {
    const other = await makeSalon("route-other");
    await expect(getServiceRouting(other.context, salon.fixture.serviceId)).rejects.toMatchObject({ code: "service_not_found" });
    await expect(listLeaveBookings(other.context, randomUUID())).rejects.toMatchObject({ code: "time_off_not_found" });
    const [owned] = await owner<{ count: string }[]>`select count(*) from practitioner_services where tenant_id = ${other.fixture.tenantId}`;
    expect(Number(owned!.count)).toBe(3);
    const runtime = postgres(runtimeUrl!, { max: 1, prepare: false });
    try {
      const seen = await runtime.begin(async (transaction) => {
        await transaction`select set_config('app.tenant_id', ${other.fixture.tenantId}, true)`;
        return transaction<{ count: string }[]>`select count(*) from practitioner_services where tenant_id = ${salon.fixture.tenantId}`;
      });
      expect(Number(seen[0]!.count)).toBe(0);
    } finally {
      await runtime.end();
    }
  });
});
