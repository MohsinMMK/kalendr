/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { EnrolInput } from "@/lib/classes-contracts";
import { isolatedDatabaseReady } from "@/test/isolated-database";
import { drainTenantOutbox } from "@/test/outbox-drain";
import { createTenant, staffContext, type TenantFixture } from "@/test/privacy-fixture";

vi.mock("server-only", () => ({}));

import { createAppointment, createStaffAppointment, listAvailability } from "@/server/appointment-repository";
import { actOnSeat, addWalkIn, cancelSession, createClassType, createSessions, enrol, getSeat, getSession, listClassTypes, listSessions, listTimetable, markAttendance, messageEveryone, updateSessionCapacity } from "@/server/classes";
import { addDays, isoWeekday, localDateOf, localInstant } from "@/server/slot-engine/time";
import type { StaffContext } from "@/server/staff-context";
import { createHandlers } from "@/worker/handlers";
import { localCaptureSink, type MessageSink, type OutgoingMessage } from "@/worker/delivery";
import { sha256 } from "@/server/crypto";
import { withLockedStaffAppointment } from "@/server/appointment-tx";
import { reassignIn } from "@/server/visit-actions";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? process.env.KALENDR_E2E_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeIsolated = isolatedDatabaseReady(runtimeUrl, ownerUrl, workerUrl) ? describe : describe.skip;

const ZONE = "Asia/Kolkata";

// The Nth weekday that starts more than a day from now, so it is always more than N days ahead
// and every N gets its own date. Skipping weekends must not fold two Ns onto the same Monday,
// or two tests book the same teacher at the same time.
function dayAhead(weekdays: number): string {
  let date = localDateOf(Date.now(), ZONE);
  let counted = 0;
  for (let guard = 0; guard < 60; guard += 1) {
    date = addDays(date, 1);
    if (new Date(localInstant(date, "00:00", ZONE)).getTime() <= Date.now() + 86_400_000 || isoWeekday(date) > 5) continue;
    counted += 1;
    if (counted === weekdays) return date;
  }
  throw new Error("no date");
}

interface Studio {
  fixture: TenantFixture;
  context: StaffContext;
  roomId: string;
  teacherId: string;
  classId: string;
}

describeIsolated("group sessions and classes (feature 18)", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let studio: Studio;
  const sent: OutgoingMessage[] = [];
  const sink: MessageSink = {
    mode: "local_capture",
    async deliver(tenantDb, message, now) {
      sent.push(message);
      return localCaptureSink.deliver(tenantDb, message, now);
    },
  };

  const at = (date: string, time: string) => new Date(localInstant(date, time, ZONE)).toISOString();
  const customer = (over: Partial<EnrolInput> = {}): EnrolInput => ({
    clinicSlug: studio.fixture.slug, firstName: "Seat", lastName: `Person${randomUUID().slice(0, 6)}`, phone: "",
    email: `seat-${randomUUID().slice(0, 8)}@example.com`, preferredChannel: "email", acceptedPrivacyNotice: true, messagingConsent: false, joinWaitlist: false, ...over,
  });
  const take = (sessionId: string, over: Partial<EnrolInput> = {}) => enrol(sessionId, customer(over), `enrol-${randomUUID()}`);

  async function makeStudio(label: string, capacity = 2): Promise<Studio> {
    const fixture = await createTenant(owner, label, "wellness");
    await owner`insert into locations (id, tenant_id, name, address, city, timezone) values (${randomUUID()}, ${fixture.tenantId}, 'Annex', '2 Road', 'Pune', ${ZONE}) on conflict do nothing`;
    const [room] = await owner<{ id: string }[]>`insert into resources (tenant_id, location_id, name, kind) values (${fixture.tenantId}, ${fixture.locationId}, 'Studio 1', 'room') returning id`;
    await owner`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${fixture.tenantId}, ${fixture.practitionerId}, ${fixture.locationId})`;
    for (let day = 1; day <= 7; day += 1) {
      await owner`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
        values (${randomUUID()}, ${fixture.tenantId}, ${fixture.locationId}, ${fixture.practitionerId}, ${day}, '06:00', '20:00', ${ZONE}, '2025-01-01', 60)`;
    }
    // A one-to-one service for the same teacher, to prove the two share one calendar.
    await owner`update services set duration_minutes = 60, slot_interval_minutes = 60, minimum_lead_minutes = 0, maximum_advance_days = 90 where id = ${fixture.serviceId}`;
    await owner`insert into service_locations (tenant_id, service_id, location_id) values (${fixture.tenantId}, ${fixture.serviceId}, ${fixture.locationId})`;
    await owner`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${fixture.tenantId}, ${fixture.practitionerId}, ${fixture.serviceId})`;
    const [user] = await owner<{ id: string }[]>`insert into auth_users (name, email, email_verified) values (${`Staff ${label}`}, ${`staff-${randomUUID().slice(0, 8)}@example.com`}, true) returning id`;
    await owner`insert into memberships (tenant_id, user_id, role) values (${fixture.tenantId}, ${user!.id}, 'owner')`;
    const context = staffContext(fixture, { userId: user!.id });
    const type = await createClassType(context, {
      name: "Morning yoga", description: "Flow", durationMinutes: 60, capacity, priceMinor: null, locationIds: [fixture.locationId], practitionerIds: [fixture.practitionerId], requiredResourceKind: "room",
    });
    return { fixture, context, roomId: room!.id, teacherId: fixture.practitionerId, classId: type.serviceId };
  }

  async function oneSession(place: Studio, date: string, time: string, capacity?: number): Promise<string> {
    const result = await createSessions(place.context, { serviceId: place.classId, practitionerId: place.teacherId, locationId: place.fixture.locationId, date, time, ...(capacity ? { capacity } : {}) });
    expect(result.clashes).toEqual([]);
    return result.sessionIds[0]!;
  }
  const enrolmentsOf = (sessionId: string) => owner<{ id: string; status: string; patient_id: string }[]>`select id, status, patient_id from class_enrolments where session_id = ${sessionId} order by created_at`;
  const drain = (place: Studio) => drainTenantOutbox(worker, place.fixture.tenantId, createHandlers({ sink, now: () => new Date(), origin: "https://app.example.test", available: { whatsapp: true, sms: true } }));

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 4, prepare: false });
    worker = postgres(workerUrl!, { max: 4, prepare: false });
    studio = await makeStudio("class-main");
  });
  afterAll(async () => {
    await owner?.end();
    await worker?.end();
  });

  it("lets exactly two of twenty people take the last two seats and offers the other eighteen the waiting list", async () => {
    const sessionId = await oneSession(studio, dayAhead(3), "07:00");
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => take(sessionId)));
    const won = results.filter((result) => result.status === "fulfilled");
    const lost = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(won).toHaveLength(2);
    expect(lost).toHaveLength(18);
    for (const failure of lost) expect(failure.reason).toMatchObject({ status: 409, code: "class_full", details: { waitlistOpen: true } });
    expect((await enrolmentsOf(sessionId)).filter((row) => row.status === "booked")).toHaveLength(2);
    // Each of the eighteen can now join the waiting list, in an order that is kept.
    const waiting = await Promise.all(Array.from({ length: 3 }, () => take(sessionId, { joinWaitlist: true })));
    expect(waiting.every((result) => result.status === "waitlisted")).toBe(true);
    expect(new Set(waiting.map((result) => (result as { position: number }).position)).size).toBe(3);
    const timetable = await listTimetable({ clinicSlug: studio.fixture.slug });
    expect(timetable.find((entry) => entry.id === sessionId)).toMatchObject({ seatsLeft: 0, state: "full", capacity: 2 });
  }, 60_000);

  it("refuses at the database when anything tries to hold more seats than the session has", async () => {
    const sessionId = await oneSession(studio, dayAhead(4), "07:00");
    await take(sessionId);
    await take(sessionId);
    const [patient] = await owner<{ id: string }[]>`insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel) values (${studio.fixture.tenantId}, 'Direct', 'Insert', '', 'direct@example.com', 'email') returning id`;
    const attempt = owner`insert into class_enrolments (tenant_id, session_id, patient_id, status, token_hash) values (${studio.fixture.tenantId}, ${sessionId}, ${patient!.id}, 'booked', ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")})`;
    await expect(attempt).rejects.toMatchObject({ code: "23514" });
    // Raising the seats lets it through; the trigger and the count agree.
    await owner`update class_sessions set capacity = 3 where id = ${sessionId}`;
    await expect(owner`insert into class_enrolments (tenant_id, session_id, patient_id, status, token_hash) values (${studio.fixture.tenantId}, ${sessionId}, ${patient!.id}, 'booked', ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")})`).resolves.toBeDefined();
  });

  it("offers a freed seat to the first person waiting with a timed hold, then to the next when it lapses, and the hold keeps others out", async () => {
    const sessionId = await oneSession(studio, dayAhead(5), "07:00");
    const first = await take(sessionId);
    await take(sessionId);
    const waitA = await take(sessionId, { joinWaitlist: true });
    const waitB = await take(sessionId, { joinWaitlist: true });
    expect(waitA.status).toBe("waitlisted");
    // The first person cancels from their own link: the seat goes to A at once, with a hold.
    const cancelled = await actOnSeat((first as { manageToken: string }).manageToken, "cancel");
    expect(cancelled.status).toBe("cancelled");
    const [offerA] = await owner<{ status: string; offer_expires_at: Date }[]>`select status, offer_expires_at from class_enrolments where id = ${waitA.enrolmentId}`;
    expect(offerA!.offer_expires_at.getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);
    const [offerB] = await owner<{ offer_expires_at: Date | null }[]>`select offer_expires_at from class_enrolments where id = ${waitB.enrolmentId}`;
    expect(offerB!.offer_expires_at).toBeNull();
    // While A holds it, a stranger cannot take the seat.
    await expect(take(sessionId)).rejects.toMatchObject({ code: "class_full" });
    const timetable = await listTimetable({ clinicSlug: studio.fixture.slug });
    expect(timetable.find((entry) => entry.id === sessionId)!.seatsLeft).toBe(0);
    // A is told by message with a link; B is not.
    await drain(studio);
    expect(sent.some((message) => message.message.templateKey === "class.notice" && message.message.body.includes('"kind":"offer"'))).toBe(true);
    // The hold runs out: B is offered the seat and A is passed over.
    await owner`update class_enrolments set offer_expires_at = now() - interval '1 second' where id = ${waitA.enrolmentId}`;
    await owner`update outbox_events set available_at = now() where event_type = 'class.offer_expire' and aggregate_id = ${waitA.enrolmentId}`;
    await drain(studio);
    const [afterExpire] = await owner<{ offer_expires_at: Date | null }[]>`select offer_expires_at from class_enrolments where id = ${waitB.enrolmentId}`;
    expect(afterExpire!.offer_expires_at).not.toBeNull();
    // B takes the seat from their own link.
    const taken = await actOnSeat((waitB as { manageToken: string }).manageToken, "accept_offer");
    expect(taken.status).toBe("booked");
    // A's late tap is refused.
    await expect(actOnSeat((waitA as { manageToken: string }).manageToken, "accept_offer")).rejects.toMatchObject({ code: "offer_over" });
    expect((await enrolmentsOf(sessionId)).filter((row) => row.status === "booked")).toHaveLength(2);
  }, 60_000);

  it("never gives a teacher a one-to-one that overlaps their class, and never a class that overlaps a one-to-one", async () => {
    const date = dayAhead(6);
    await oneSession(studio, date, "10:00");
    const window = { from: at(date, "00:00"), to: at(addDays(date, 1), "00:00") };
    const open = await listAvailability({ clinicSlug: studio.fixture.slug, locationId: studio.fixture.locationId, serviceId: studio.fixture.serviceId, practitionerId: studio.teacherId, ...window });
    expect(open.map((slot) => slot.startsAt)).not.toContain(at(date, "10:00"));
    expect(open.map((slot) => slot.startsAt)).toContain(at(date, "11:00"));
    // The booking itself refuses the time, whether it comes from the public page or the desk.
    await expect(createAppointment({
      clinicSlug: studio.fixture.slug, patientType: "new", bookingFor: "self", locationId: studio.fixture.locationId, serviceId: studio.fixture.serviceId, practitionerId: studio.teacherId,
      slotId: "slot_x", startsAt: at(date, "10:00"), endsAt: at(date, "11:00"), firstName: "Over", lastName: "Lap", phone: "+919800000333", email: "overlap@example.com",
      preferredChannel: "email", acceptedPrivacyNotice: true, messagingConsent: false,
    }, randomUUID(), randomUUID().replaceAll("-", ""))).rejects.toMatchObject({ code: "slot_unavailable" });
    await expect(createStaffAppointment(studio.context, {
      clinicSlug: studio.fixture.slug, locationId: studio.fixture.locationId, serviceId: studio.fixture.serviceId, practitionerId: studio.teacherId, startsAt: at(date, "10:00"), source: "desk",
      newPatient: { firstName: "Desk", lastName: "Overlap", phone: "+919800000444", email: "", preferredChannel: "email", isDependent: false, messagingConsent: false },
    }, `desk-${randomUUID()}`, randomUUID())).rejects.toMatchObject({ code: "slot_unavailable" });
    // And the other way round: a class cannot be put on top of a one-to-one.
    await createStaffAppointment(studio.context, {
      clinicSlug: studio.fixture.slug, locationId: studio.fixture.locationId, serviceId: studio.fixture.serviceId, practitionerId: studio.teacherId, startsAt: at(date, "14:00"), source: "desk",
      newPatient: { firstName: "Desk", lastName: "First", phone: "+919800000555", email: "", preferredChannel: "email", isDependent: false, messagingConsent: false },
    }, `desk-${randomUUID()}`, randomUUID());
    const clash = await createSessions(studio.context, { serviceId: studio.classId, practitionerId: studio.teacherId, locationId: studio.fixture.locationId, date, time: "14:00" });
    expect(clash.created).toBe(0);
    expect(clash.clashes).toHaveLength(1);
    // Cancelling the session gives the teacher back.
    const [row] = await owner<{ id: string; version: number }[]>`select id, version from class_sessions where tenant_id = ${studio.fixture.tenantId} and starts_at = ${at(date, "10:00")}::timestamptz`;
    await cancelSession(studio.context, row!.id, { expectedVersion: row!.version });
    const after = await listAvailability({ clinicSlug: studio.fixture.slug, locationId: studio.fixture.locationId, serviceId: studio.fixture.serviceId, practitionerId: studio.teacherId, ...window });
    expect(after.map((slot) => slot.startsAt)).toContain(at(date, "10:00"));
  }, 60_000);

  it("does not let a visit be handed to a teacher who is teaching at that time, even though the visit is excluded from its own busy check", async () => {
    const [second] = await owner<{ id: string }[]>`insert into practitioners (tenant_id, name, title, initials, specialty) values (${studio.fixture.tenantId}, 'Second', 'Teacher', 'S2', 'Yoga') returning id`;
    await owner`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${studio.fixture.tenantId}, ${second!.id}, ${studio.fixture.locationId})`;
    await owner`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${studio.fixture.tenantId}, ${second!.id}, ${studio.fixture.serviceId})`;
    for (let day = 1; day <= 7; day += 1) {
      await owner`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
        values (${randomUUID()}, ${studio.fixture.tenantId}, ${studio.fixture.locationId}, ${second!.id}, ${day}, '06:00', '20:00', ${ZONE}, '2025-01-01', 60)`;
    }
    const date = dayAhead(12);
    await oneSession(studio, date, "16:00");
    const visit = await createStaffAppointment(studio.context, {
      clinicSlug: studio.fixture.slug, locationId: studio.fixture.locationId, serviceId: studio.fixture.serviceId, practitionerId: second!.id, startsAt: at(date, "16:00"), source: "desk",
      newPatient: { firstName: "Hand", lastName: "Over", phone: "+919800000666", email: "", preferredChannel: "email", isDependent: false, messagingConsent: false },
    }, `desk-${randomUUID()}`, randomUUID());
    const [row] = await owner<{ version: number }[]>`select version from appointments where id = ${visit.appointmentId}`;
    await expect(withLockedStaffAppointment(studio.context, visit.appointmentId, Number(row!.version), (transaction, current) =>
      reassignIn(transaction, current, { type: "staff", userId: studio.context.userId ?? "" }, { practitionerId: studio.teacherId }))).rejects.toMatchObject({ code: "practitioner_busy" });
  });

  it("creates a repeating timetable in one action, all or nothing", async () => {
    const start = dayAhead(8);
    const weekly = { frequency: "weekly" as const, interval: 1, weekdays: [], end: { kind: "count" as const, count: 4 } };
    const result = await createSessions(studio.context, { serviceId: studio.classId, practitionerId: studio.teacherId, locationId: studio.fixture.locationId, date: start, time: "08:00", repeat: weekly });
    expect(result.created).toBe(4);
    expect(result.seriesId).not.toBeNull();
    const rows = await owner<{ series_id: string }[]>`select series_id from class_sessions where id in ${owner(result.sessionIds)}`;
    expect(new Set(rows.map((row) => row.series_id)).size).toBe(1);
    // The same timetable again clashes on every date, so nothing more is created.
    const again = await createSessions(studio.context, { serviceId: studio.classId, practitionerId: studio.teacherId, locationId: studio.fixture.locationId, date: start, time: "08:00", repeat: weekly });
    expect(again.created).toBe(0);
    expect(again.clashes).toHaveLength(4);
  });

  it("marks attendance one tap at a time, adds a walk-in, and messages everyone once", async () => {
    const sessionId = await oneSession(studio, dayAhead(9), "07:00", 3);
    await take(sessionId);
    await take(sessionId);
    let detail = await getSession(studio.context, sessionId);
    expect(detail.roster).toHaveLength(2);
    const [first, second] = detail.roster as [typeof detail.roster[number], typeof detail.roster[number]];
    detail = await markAttendance(studio.context, sessionId, { enrolmentId: first.enrolmentId, expectedVersion: first.version, outcome: "attended" });
    detail = await markAttendance(studio.context, sessionId, { enrolmentId: second.enrolmentId, expectedVersion: second.version, outcome: "no_show" });
    expect(detail.roster.map((entry) => entry.status).sort()).toEqual(["attended", "no_show"]);
    await expect(markAttendance(studio.context, sessionId, { enrolmentId: first.enrolmentId, expectedVersion: first.version, outcome: "booked" })).rejects.toMatchObject({ code: "version_conflict" });
    detail = await addWalkIn(studio.context, sessionId, { firstName: "Walk", lastName: "In" });
    expect(detail.roster).toHaveLength(3);
    expect(detail.seatsTaken).toBe(3);
    await expect(addWalkIn(studio.context, sessionId, { firstName: "One", lastName: "More" })).rejects.toMatchObject({ code: "class_full" });
    const key = `message-${randomUUID()}`;
    expect(await messageEveryone(studio.context, sessionId, { message: "Bring a mat.", audience: "booked" }, key)).toEqual({ queued: 3 });
    expect(await messageEveryone(studio.context, sessionId, { message: "Bring a mat.", audience: "booked" }, key)).toEqual({ queued: 3 });
    const queued = await owner<{ count: string }[]>`select count(*) from outbox_events where tenant_id = ${studio.fixture.tenantId} and event_type = 'class.notice' and payload->>'kind' = 'broadcast'`;
    expect(Number(queued[0]!.count)).toBe(3);
    const [audit] = await owner<{ metadata: Record<string, unknown> }[]>`select metadata from audit_events where tenant_id = ${studio.fixture.tenantId} and action = 'class.session.messaged' order by occurred_at desc limit 1`;
    expect(JSON.stringify(audit!.metadata)).not.toContain("mat");
  }, 60_000);

  it("tells the staff when a place is booked online and when a waiting person takes an offered place (feature 56)", async () => {
    const place = await makeStudio("class-alerts", 1);
    const sessionId = await oneSession(place, dayAhead(7), "08:00");
    const seated = await enrol(sessionId, { ...customer(), clinicSlug: place.fixture.slug }, `k-${randomUUID()}`);
    const waiting = await enrol(sessionId, { ...customer({ joinWaitlist: true }), clinicSlug: place.fixture.slug }, `k-${randomUUID()}`);
    const kinds = async () => (await owner<{ kind: string }[]>`select distinct kind from staff_notifications where tenant_id = ${place.fixture.tenantId}`).map((row) => row.kind);
    expect(await kinds()).toContain("new_booking");
    expect(await kinds()).not.toContain("cancellation");
    await actOnSeat((seated as { manageToken: string }).manageToken, "cancel");
    expect(await kinds()).toContain("cancellation");
    await actOnSeat((waiting as { manageToken: string }).manageToken, "accept_offer");
    expect(await kinds()).toContain("waitlist_filled");
  }, 60_000);

  it("cancels a whole session, tells everyone with a seat or waiting, and frees the room", async () => {
    const place = await makeStudio("class-cancel", 1);
    const date = dayAhead(7);
    const sessionId = await oneSession(place, date, "07:00");
    const seated = await enrol(sessionId, { ...customer(), clinicSlug: place.fixture.slug }, `k-${randomUUID()}`);
    const waiting = await enrol(sessionId, { ...customer({ joinWaitlist: true }), clinicSlug: place.fixture.slug }, `k-${randomUUID()}`);
    expect(waiting.status).toBe("waitlisted");
    const [row] = await owner<{ version: number }[]>`select version from class_sessions where id = ${sessionId}`;
    const result = await cancelSession(place.context, sessionId, { expectedVersion: row!.version, note: "The teacher is unwell." });
    expect(result).toEqual({ cancelled: 1, notified: 2 });
    await expect(cancelSession(place.context, sessionId, { expectedVersion: row!.version + 1 })).rejects.toMatchObject({ code: "session_closed" });
    expect((await enrolmentsOf(sessionId)).every((entry) => entry.status === "cancelled")).toBe(true);
    const live = await owner<{ count: string }[]>`select count(*) from resource_reservations where class_session_id = ${sessionId} and state = 'confirmed'`;
    expect(Number(live[0]!.count)).toBe(0);
    expect((await getSeat((seated as { manageToken: string }).manageToken)).sessionStatus).toBe("cancelled");
    const before = sent.length;
    await drain(place);
    expect(sent.slice(before).filter((message) => message.message.body.includes("session_cancelled"))).toHaveLength(2);
    // A cancelled session is gone from the public timetable and refuses new seats.
    expect((await listTimetable({ clinicSlug: place.fixture.slug })).some((entry) => entry.id === sessionId)).toBe(false);
    await expect(enrol(sessionId, { ...customer(), clinicSlug: place.fixture.slug }, `k-${randomUUID()}`)).rejects.toMatchObject({ code: "session_not_found" });
  }, 60_000);

  it("changes seats with a version check and offers new seats to the waiting list", async () => {
    const sessionId = await oneSession(studio, dayAhead(10), "07:00", 1);
    await take(sessionId);
    const waiting = await take(sessionId, { joinWaitlist: true });
    const view = await getSession(studio.context, sessionId);
    await expect(updateSessionCapacity(studio.context, sessionId, { expectedVersion: view.version + 5, capacity: 2 })).rejects.toMatchObject({ code: "version_conflict" });
    await expect(updateSessionCapacity(studio.context, sessionId, { expectedVersion: view.version, capacity: 0 })).rejects.toBeDefined();
    const bigger = await updateSessionCapacity(studio.context, sessionId, { expectedVersion: view.version, capacity: 2 });
    expect(bigger.capacity).toBe(2);
    const [offered] = await owner<{ offer_expires_at: Date | null }[]>`select offer_expires_at from class_enrolments where id = ${waiting.enrolmentId}`;
    expect(offered!.offer_expires_at).not.toBeNull();
    await expect(updateSessionCapacity(studio.context, sessionId, { expectedVersion: bigger.version, capacity: 1 })).rejects.toMatchObject({ code: "capacity_below_enrolled" });
  });

  it("keeps one business's classes away from another and never exposes a token in the audit trail", async () => {
    const other = await makeStudio("class-other");
    const sessionId = await oneSession(studio, dayAhead(11), "07:00");
    await expect(getSession(other.context, sessionId)).rejects.toMatchObject({ code: "session_not_found" });
    const types = await listClassTypes(studio.context);
    expect(types).toHaveLength(1);
    expect(types[0]).toMatchObject({ serviceId: studio.classId, name: "Morning yoga", capacity: 2, durationMinutes: 60, locationIds: [studio.fixture.locationId], practitionerIds: [studio.teacherId] });
    expect((await listClassTypes(other.context)).map((entry) => entry.serviceId)).toEqual([other.classId]);
    expect(await listSessions(other.context, { from: new Date(), to: new Date(Date.now() + 90 * 86_400_000) })).toHaveLength(0);
    await expect(enrol(sessionId, { ...customer(), clinicSlug: other.fixture.slug }, `k-${randomUUID()}`)).rejects.toMatchObject({ code: "session_not_found" });
    const result = await take(sessionId);
    const token = (result as { manageToken: string }).manageToken;
    const [stored] = await owner<{ token_hash: string; token_sealed: string | null }[]>`select token_hash, token_sealed from class_enrolments where id = ${result.enrolmentId}`;
    expect(stored!.token_hash).toBe(sha256(token));
    expect(stored!.token_sealed ?? "").not.toContain(token);
    const audits = await owner<{ metadata: unknown }[]>`select metadata from audit_events where tenant_id = ${studio.fixture.tenantId}`;
    expect(JSON.stringify(audits)).not.toContain(token);
    const runtime = postgres(runtimeUrl!, { max: 1, prepare: false });
    try {
      const seen = await runtime.begin(async (transaction) => {
        await transaction`select set_config('app.tenant_id', ${other.fixture.tenantId}, true)`;
        return transaction<{ count: string }[]>`select count(*) from class_enrolments where tenant_id = ${studio.fixture.tenantId}`;
      });
      expect(Number(seen[0]!.count)).toBe(0);
      const found = await runtime`select * from kalendr_resolve_class_seat(${stored!.token_hash})`;
      expect(found).toHaveLength(1);
      expect(await runtime`select * from kalendr_resolve_class_seat(${"0".repeat(64)})`).toHaveLength(0);
    } finally {
      await runtime.end();
    }
  });
});
