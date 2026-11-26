/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { PublicBookingInput } from "@/lib/contracts";
import { isolatedDatabaseReady } from "@/test/isolated-database";
import { drainTenantOutbox } from "@/test/outbox-drain";
import { createTenant, staffContext, type TenantFixture } from "@/test/privacy-fixture";

vi.mock("server-only", () => ({}));

import { createAppointment, listAvailability, manageAppointment } from "@/server/appointment-repository";
import { deleteStaffScheduleBlock } from "@/server/staff-operations";
import { GET as offerRead, POST as offerAnswer } from "@/app/api/public/offers/[token]/route";
import { POST as waitlistJoin } from "@/app/api/public/waitlist/route";
import { acceptOffer, cancelLaterAppointment, declineOffer, readOffer } from "@/server/waitlist-accept";
import { endOffer, offerSlot } from "@/server/waitlist-offers";
import { postgresRunner } from "@/server/workflows/runner";
import { localCaptureSink, type MessageSink, type OutgoingMessage } from "@/worker/delivery";
import { createHandlers } from "@/worker/handlers";
import { sweepWaitlist } from "@/worker/jobs";
import { waitlistMatchHandler } from "@/worker/handlers/waitlist";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? process.env.KALENDR_E2E_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeIsolated = isolatedDatabaseReady(runtimeUrl, ownerUrl, workerUrl) ? describe : describe.skip;

const DAY = 86_400_000;
const ZONE = "+05:30";
const dayKey = (offsetDays: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * DAY));
const at = (offsetDays: number, hour: number, minute = 0) => new Date(`${dayKey(offsetDays)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000${ZONE}`);

describeIsolated("smart waitlist (feature 21) against a real database", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let runtime: postgres.Sql;
  let fixture: TenantFixture;
  let other: TenantFixture;
  const sent: OutgoingMessage[] = [];
  const capture: MessageSink = {
    mode: "local_capture",
    async deliver(tenantDb, message, now) {
      // The outbox is shared by every business in the database, so only this test's business is kept.
      if (message.tenantId === fixture.tenantId) sent.push(message);
      return localCaptureSink.deliver(tenantDb, message, now);
    },
  };
  const handlers = () => createHandlers({ sink: capture, now: () => new Date(), origin: "https://app.example.test" });
  const drain = () => drainTenantOutbox(worker, fixture.tenantId, handlers());
  /** The raw token of the offer that was just messaged, read from the link the handler sent. */
  const lastToken = () => {
    const message = [...sent].reverse().find((item) => item.message.templateKey === "waitlist.offer");
    const url = (JSON.parse(message!.message.body) as { url: string }).url;
    return decodeURIComponent(url.split("/offer/")[1]!);
  };
  const emails: string[] = [];

  async function person(label: string): Promise<string> {
    const email = `${label}-${randomUUID().slice(0, 6)}@example.com`;
    emails.push(email);
    const [row] = await owner<{ id: string }[]>`
      insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel, messaging_consent_at)
      values (${fixture.tenantId}, ${label}, 'Waiter', ${`+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`}, ${email}, 'email', now()) returning id`;
    return row!.id;
  }
  async function wait(patientId: string, options: { time?: string; from?: number; to?: number; createdMinutesAgo?: number; people?: string[]; serviceId?: string } = {}): Promise<string> {
    const [row] = await owner<{ id: string }[]>`
      insert into waitlist_entries (tenant_id, patient_id, service_id, location_id, preferred_practitioner_ids, date_from, date_to, time_preference, created_at)
      values (${fixture.tenantId}, ${patientId}, ${options.serviceId ?? fixture.serviceId}, ${fixture.locationId}, ${options.people ?? []},
        ${dayKey(options.from ?? 1)}, ${dayKey(options.to ?? 20)}, ${options.time ?? "any"}, now() - ${options.createdMinutesAgo ?? 0} * interval '1 minute') returning id`;
    return row!.id;
  }
  async function book(patientEmail: string, start: Date, name = "Bookie"): Promise<{ appointmentId: string; manageToken: string }> {
    const input: PublicBookingInput = {
      clinicSlug: fixture.slug, patientType: "new", bookingFor: "self", locationId: fixture.locationId, serviceId: fixture.serviceId, practitionerId: fixture.practitionerId,
      slotId: randomUUID(), startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 60 * 60_000).toISOString(),
      firstName: name, lastName: "Booker", phone: `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, email: patientEmail,
      preferredChannel: "email", acceptedPrivacyNotice: true, messagingConsent: false,
    };
    const created = await createAppointment(input, randomUUID(), randomUUID().replaceAll("-", ""));
    return { appointmentId: created.appointmentId, manageToken: created.manageToken };
  }
  /** A booking for a waiting person, made as the table owner (the booking page would make a new customer record). */
  async function seedAppointment(patientId: string, start: Date): Promise<string> {
    const end = new Date(start.getTime() + 3_600_000);
    const [row] = await owner<{ id: string }[]>`
      insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash)
      values (${fixture.tenantId}, ${fixture.locationId}, ${patientId}, ${fixture.practitionerId}, ${fixture.serviceId}, ${start.toISOString()}, ${end.toISOString()}, 'booked', 'staff', ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")})
      returning id`;
    await owner`insert into resource_reservations (tenant_id, appointment_id, practitioner_id, starts_at, ends_at, state)
      values (${fixture.tenantId}, ${row!.id}, ${fixture.practitionerId}, ${start.toISOString()}, ${end.toISOString()}, 'confirmed')`;
    return row!.id;
  }
  const cancel = (token: string) => manageAppointment(token, { action: "cancel", expectedVersion: 1 });
  const visible = async (start: Date) => (await listAvailability({
    clinicSlug: fixture.slug, locationId: fixture.locationId, serviceId: fixture.serviceId, practitionerId: fixture.practitionerId,
    from: new Date(start.getTime() - 60_000).toISOString(), to: new Date(start.getTime() + 61 * 60_000).toISOString(),
  })).some((slot) => slot.startsAt === start.toISOString());
  const offersFor = (entryId: string) => owner<{ id: string; status: string; hold_id: string | null; position: number; chain_id: string }[]>`
    select id, status, hold_id, position, chain_id from slot_offers where tenant_id = ${fixture.tenantId} and entry_id = ${entryId} order by created_at`;
  const holdRows = (start: Date) => owner<{ id: string; purpose: string }[]>`
    select id, purpose from slot_holds where tenant_id = ${fixture.tenantId} and starts_at = ${start.toISOString()}::timestamptz`;
  const expireNow = (offerId: string) => owner`update slot_offers set expires_at = now() - interval '1 second' where id = ${offerId}`;
  const reset = async () => {
    sent.length = 0;
    await owner`delete from slot_offers where tenant_id = ${fixture.tenantId}`;
    await owner`delete from waitlist_entries where tenant_id = ${fixture.tenantId}`;
    await owner`delete from slot_holds where tenant_id = ${fixture.tenantId}`;
    await owner`delete from schedule_blocks where tenant_id = ${fixture.tenantId}`;
    await owner`delete from waitlist_service_switches where tenant_id = ${fixture.tenantId}`;
    await owner`delete from waitlist_settings where tenant_id = ${fixture.tenantId}`;
    await owner`update outbox_events set status = 'delivered' where tenant_id = ${fixture.tenantId} and status <> 'delivered'`;
  };

  async function seedBusiness(tenant: TenantFixture) {
    await owner`update services set duration_minutes = 60, slot_interval_minutes = 60, minimum_lead_minutes = 0, maximum_advance_days = 60, buffer_before_minutes = 0, buffer_after_minutes = 0 where id = ${tenant.serviceId}`;
    await owner`insert into service_locations (tenant_id, service_id, location_id) values (${tenant.tenantId}, ${tenant.serviceId}, ${tenant.locationId})`;
    await owner`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${tenant.tenantId}, ${tenant.practitionerId}, ${tenant.locationId})`;
    await owner`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${tenant.tenantId}, ${tenant.practitionerId}, ${tenant.serviceId})`;
    for (let day = 1; day <= 7; day += 1) {
      await owner`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
        values (${randomUUID()}, ${tenant.tenantId}, ${tenant.locationId}, ${tenant.practitionerId}, ${day}, '00:00', '23:59', 'Asia/Kolkata', '2025-01-01', 60)`;
    }
    // No quiet hours for most tests (start = end); the quiet-hours test sets its own.
    await owner`insert into workflow_settings (tenant_id, quiet_start_minute, quiet_end_minute) values (${tenant.tenantId}, 0, 0) on conflict (tenant_id) do update set quiet_start_minute = 0, quiet_end_minute = 0`;
  }

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false });
    worker = postgres(workerUrl!, { max: 4, prepare: false });
    runtime = postgres(runtimeUrl!, { max: 2, prepare: false });
    fixture = await createTenant(owner, "waitlist");
    other = await createTenant(owner, "waitlist-other");
    await seedBusiness(fixture);
    await seedBusiness(other);
  });
  afterAll(async () => {
    await owner?.end();
    await worker?.end();
    await runtime?.end();
  });

  it("offers a cancelled 4 pm time to the first matching person, hides it from the public page, passes it on when ignored, and the second person takes it in one tap", async () => {
    await reset();
    const slot = at(5, 16);
    const [first, second, third, wrongTime, wrongDates] = await Promise.all([person("First"), person("Second"), person("Third"), person("Morning"), person("Later")]);
    const firstEntry = await wait(first, { time: "afternoon", createdMinutesAgo: 500 });
    const secondEntry = await wait(second, { createdMinutesAgo: 400 });
    const thirdEntry = await wait(third, { createdMinutesAgo: 300 });
    const morningEntry = await wait(wrongTime, { time: "morning", createdMinutesAgo: 900 });
    const laterEntry = await wait(wrongDates, { from: 10, to: 12, createdMinutesAgo: 900 });

    const booked = await book("cancels-" + randomUUID().slice(0, 6) + "@example.com", slot);
    expect(await visible(slot)).toBe(false);
    await cancel(booked.manageToken);

    // Inside the cancel itself: the first person (longest waiting among those who fit) has a held, scheduled offer.
    const [offer] = await offersFor(firstEntry);
    expect(offer).toMatchObject({ status: "scheduled", position: 1 });
    expect(offer?.hold_id).toBeTruthy();
    const holds = await holdRows(slot);
    expect(holds).toEqual([{ id: offer!.hold_id, purpose: "waitlist" }]);
    // The slot never showed publicly between the cancel and the offer.
    expect(await visible(slot)).toBe(false);
    expect(await offersFor(morningEntry)).toHaveLength(0);
    expect(await offersFor(laterEntry)).toHaveLength(0);
    const [entryRow] = await owner<{ status: string }[]>`select status from waitlist_entries where id = ${firstEntry}`;
    expect(entryRow?.status).toBe("offered");

    // The worker sends the message. Only now is the offer `sent`.
    await drain();
    const [sentOffer] = await offersFor(firstEntry);
    expect(sentOffer?.status).toBe("sent");
    expect(sent.filter((item) => item.message.templateKey === "waitlist.offer")).toHaveLength(1);
    const firstToken = lastToken();
    const [stored] = await owner<{ token_hash: string; token_sealed: string | null }[]>`select token_hash, token_sealed from slot_offers where id = ${offer!.id}`;
    expect(stored?.token_hash).not.toContain(firstToken);
    expect(stored?.token_sealed).toBeNull();
    await expect(readOffer(firstToken)).resolves.toMatchObject({ state: "open", serviceName: "Check-up" });
    expect(await visible(slot)).toBe(false);

    // Ignored: after the answer time the sweep passes the same hold to the second person. The hold row never goes away.
    await expireNow(offer!.id);
    const summary = await sweepWaitlist(worker);
    expect(summary.rows).toBeGreaterThan(0);
    const [expired] = await offersFor(firstEntry);
    expect(expired?.status).toBe("expired");
    expect((await owner<{ status: string }[]>`select status from waitlist_entries where id = ${firstEntry}`)[0]?.status).toBe("active");
    const [next] = await offersFor(secondEntry);
    expect(next).toMatchObject({ status: "scheduled", position: 2, hold_id: offer!.hold_id });
    expect(await holdRows(slot)).toEqual([{ id: offer!.hold_id, purpose: "waitlist" }]);
    expect(await visible(slot)).toBe(false);
    await drain();
    const secondToken = lastToken();

    // The old link can no longer take it, and neither can both links at once.
    await expect(acceptOffer(firstToken)).rejects.toMatchObject({ code: "offer_closed" });
    const [late, current] = await Promise.allSettled([acceptOffer(firstToken), acceptOffer(secondToken), acceptOffer(secondToken)]);
    expect(late.status).toBe("rejected");
    expect(current.status).toBe("fulfilled");
    const count = await owner<{ count: string }[]>`select count(*) from appointments where tenant_id = ${fixture.tenantId} and starts_at = ${slot.toISOString()}::timestamptz and status in ('booked', 'requested')`;
    expect(Number(count[0]?.count)).toBe(1);

    const [taken] = await owner<{ id: string; booking_source: string; status: string; patient_id: string }[]>`
      select id, booking_source, status, patient_id from appointments where tenant_id = ${fixture.tenantId} and starts_at = ${slot.toISOString()}::timestamptz and status in ('booked', 'requested')`;
    expect(taken).toMatchObject({ booking_source: "waitlist", status: "booked", patient_id: second });
    expect((await owner<{ status: string }[]>`select status from waitlist_entries where id = ${secondEntry}`)[0]?.status).toBe("fulfilled");
    expect((await offersFor(secondEntry))[0]?.status).toBe("accepted");
    expect(await holdRows(slot)).toHaveLength(0);
    expect(await visible(slot)).toBe(false);
    // The normal confirmation is queued for the booking.
    const created = await owner<{ count: string }[]>`select count(*) from outbox_events where tenant_id = ${fixture.tenantId} and event_type = 'appointment.created' and aggregate_id = ${taken!.id}`;
    expect(Number(created[0]?.count)).toBe(1);
    // The third person was never asked.
    expect(await offersFor(thirdEntry)).toHaveLength(0);
    // A tapped link that is already done answers the same way again, and a stranger's token is simply not found.
    await expect(acceptOffer(secondToken)).resolves.toMatchObject({ appointmentId: taken!.id, manageToken: null });
    await expect(acceptOffer("x".repeat(43))).rejects.toMatchObject({ code: "offer_not_found" });
  });

  it("releases a time to public booking after three people, and when it is under two hours away, and when the service's switch is off", async () => {
    await reset();
    const slot = at(6, 15);
    const people = await Promise.all([person("A"), person("B"), person("C"), person("D")]);
    const entries: string[] = [];
    for (const [index, id] of people.entries()) entries.push(await wait(id, { createdMinutesAgo: 1000 - index * 100 }));
    const booked = await book("three-" + randomUUID().slice(0, 6) + "@example.com", slot);
    await cancel(booked.manageToken);
    for (let round = 0; round < 3; round += 1) {
      await drain();
      const [live] = await owner<{ id: string }[]>`select id from slot_offers where tenant_id = ${fixture.tenantId} and status = 'sent'`;
      expect(live, `round ${round}`).toBeTruthy();
      await expireNow(live!.id);
      await sweepWaitlist(worker);
    }
    // Three people were asked and ignored it: the fourth is never asked, the hold is gone and the time is public again.
    expect(await offersFor(entries[3]!)).toHaveLength(0);
    expect(await holdRows(slot)).toHaveLength(0);
    expect(await visible(slot)).toBe(true);
    const released = await owner<{ metadata: { reason: string } }[]>`select metadata from audit_events where tenant_id = ${fixture.tenantId} and action = 'waitlist.slot.released'`;
    expect(released.map((row) => row.metadata.reason)).toContain("after_three_people");

    // Under two hours away: nothing is held and nothing is offered.
    await reset();
    // The next local hour boundary (India is half an hour off UTC) at least a minute away (bookings need no lead time), so under two hours away.
    // The day closes at 23:59 and a visit is an hour, so 23:00 can never be booked; take the hour after it instead.
    // In the last minute before 22:00 that hour is over two hours away, so wait out the minute (it then is under two).
    const localHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hourCycle: "h23" });
    const nextBookableHour = () => {
      const lastBoundary = Math.floor((Date.now() - 30 * 60_000) / 3_600_000) * 3_600_000 + 30 * 60_000;
      return [1, 2, 3].map((hours) => new Date(lastBoundary + hours * 3_600_000))
        .find((time) => time.getTime() - Date.now() >= 60_000 && time.getTime() - Date.now() < 2 * 3_600_000 && localHour.format(time) !== "23");
    };
    let soon = nextBookableHour();
    while (!soon) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      soon = nextBookableHour();
    }
    const entry = await wait(await person("Soon"), { from: 0, to: 2 });
    const closeBooking = await book("soon-" + randomUUID().slice(0, 6) + "@example.com", soon);
    await cancel(closeBooking.manageToken);
    expect(await offersFor(entry)).toHaveLength(0);
    expect(await visible(soon)).toBe(true);

    // The switch for the service turns automatic offers off for that service only.
    await reset();
    await owner`insert into waitlist_service_switches (tenant_id, service_id, automatic_offers) values (${fixture.tenantId}, ${fixture.serviceId}, false)`;
    const offSlot = at(7, 11);
    const offEntry = await wait(await person("Off"));
    const offBooking = await book("off-" + randomUUID().slice(0, 6) + "@example.com", offSlot);
    await cancel(offBooking.manageToken);
    expect(await offersFor(offEntry)).toHaveLength(0);
    expect(await visible(offSlot)).toBe(true);
    // Room for the one-minute wait above, on the one night minute it is needed.
  }, 90_000);

  it("never sends at night: an offer made at 2 am waits for opening time, keeps the hold meanwhile, and the cascade starts when it opens", async () => {
    await reset();
    await owner`update workflow_settings set quiet_start_minute = 1260, quiet_end_minute = 480 where tenant_id = ${fixture.tenantId}`;
    try {
      const slot = at(9, 14);
      const nightWaiter = await wait(await person("Night"));
      const nextWaiter = await wait(await person("Next"), { createdMinutesAgo: -5 });
      // 2 am local on the day before the slot: a future moment, so the hold's real expiry is in the future too.
      const twoAm = at(8, 2);
      const outcome = await worker.begin(async (transaction) => {
        await transaction`select set_config('app.tenant_id', ${fixture.tenantId}, true)`;
        return offerSlot(postgresRunner(transaction), fixture.tenantId, { locationId: fixture.locationId, serviceId: fixture.serviceId, practitionerId: fixture.practitionerId, startsAt: slot, endsAt: new Date(slot.getTime() + 3_600_000) }, { now: twoAm });
      });
      expect(outcome.offered).toBe(true);
      const [offer] = await owner<{ id: string; status: string; send_at: Date; expires_at: Date; hold_id: string }[]>`select id, status, send_at, expires_at, hold_id from slot_offers where entry_id = ${nightWaiter}`;
      // Opening time is 8 am; the offer is scheduled for then, the answer time runs from then, and the hold covers it all.
      expect(offer?.status).toBe("scheduled");
      expect(offer?.send_at.toISOString()).toBe(at(8, 8).toISOString());
      expect(offer!.expires_at.getTime() - offer!.send_at.getTime()).toBe(15 * 60_000);
      expect(await visible(slot)).toBe(false);
      const [event] = await owner<{ available_at: Date }[]>`select available_at from outbox_events where tenant_id = ${fixture.tenantId} and event_type = 'waitlist-match' and aggregate_id = ${offer!.id}`;
      expect(event?.available_at.toISOString()).toBe(at(8, 8).toISOString());

      // The handler runs at 2 am (a clock the test pins) and sends nothing; it moves nothing either, as quiet hours are on.
      const before = sent.length;
      const tick = (clock: Date) => worker.begin(async (transaction) => {
        await transaction`select set_config('app.tenant_id', ${fixture.tenantId}, true)`;
        return waitlistMatchHandler({ sink: capture, now: () => clock, origin: "https://app.example.test" })(transaction, {
          id: randomUUID(), tenantId: fixture.tenantId, aggregateType: "slot_offer", aggregateId: offer!.id, eventType: "waitlist-match", payload: {}, dedupeKey: "x", attemptCount: 1,
        });
      });
      await expect(tick(at(8, 2, 30))).resolves.toBe("delivered");
      expect(sent.length).toBe(before);
      expect((await owner<{ status: string }[]>`select status from slot_offers where id = ${offer!.id}`)[0]?.status).toBe("scheduled");

      // At opening time it is sent, with the answer clock starting then.
      await expect(tick(at(8, 8))).resolves.toBe("delivered");
      expect(sent.length).toBe(before + 1);
      const [sentRow] = await owner<{ status: string; expires_at: Date }[]>`select status, expires_at from slot_offers where id = ${offer!.id}`;
      expect(sentRow?.status).toBe("sent");
      expect(sentRow?.expires_at.toISOString()).toBe(at(8, 8, 15).toISOString());

      // The cascade also waits for opening time when an answer runs out at night.
      await owner`update waitlist_settings set order_rule = 'longest_waiting' where tenant_id = ${fixture.tenantId}`;
      await worker.begin(async (transaction) => {
        await transaction`select set_config('app.tenant_id', ${fixture.tenantId}, true)`;
        await endOffer(postgresRunner(transaction), fixture.tenantId, offer!.id, "expired", { now: at(8, 23, 30) });
      });
      const [secondOffer] = await owner<{ send_at: Date; hold_id: string; status: string }[]>`select send_at, hold_id, status from slot_offers where entry_id = ${nextWaiter}`;
      expect(secondOffer?.status).toBe("scheduled");
      expect(secondOffer?.send_at.toISOString()).toBe(at(9, 8).toISOString());
      expect(secondOffer?.hold_id).toBe(offer!.hold_id);
    } finally {
      await owner`update workflow_settings set quiet_start_minute = 0, quiet_end_minute = 0 where tenant_id = ${fixture.tenantId}`;
    }
  });

  it("offers the times a removed closed time opened, and asks the person with the soonest booking first when the business chooses that order", async () => {
    await reset();
    const slot = at(11, 11);
    const early = await person("Early");
    const waiting = await person("Waiting");
    // `soonest_existing`: the person who already holds a later booking is asked before someone with none, even though they joined later.
    await owner`insert into waitlist_settings (tenant_id, order_rule) values (${fixture.tenantId}, 'soonest_existing') on conflict (tenant_id) do update set order_rule = 'soonest_existing'`;
    const waitingEntry = await wait(waiting, { createdMinutesAgo: 900 });
    const earlyEntry = await wait(early, { createdMinutesAgo: 10 });
    await seedAppointment(early, at(14, 9));
    const [block] = await owner<{ id: string }[]>`
      insert into schedule_blocks (tenant_id, practitioner_id, location_id, starts_at, ends_at, reason)
      values (${fixture.tenantId}, ${fixture.practitionerId}, ${fixture.locationId}, ${at(11, 10).toISOString()}, ${at(11, 13).toISOString()}, 'Training') returning id`;
    expect(await visible(slot)).toBe(false);
    await deleteStaffScheduleBlock(staffContext(fixture), block!.id);
    // The three hours the block covered are each offered, the earliest to the person with the soonest booking.
    const startOf = async (entry: string) => (await owner<{ starts_at: Date }[]>`select starts_at from slot_offers where entry_id = ${entry}`)[0]?.starts_at.toISOString();
    expect((await offersFor(earlyEntry))[0]).toMatchObject({ status: "scheduled", position: 1 });
    expect(await startOf(earlyEntry)).toBe(at(11, 10).toISOString());
    expect(await startOf(waitingEntry)).toBe(at(11, 11).toISOString());
    expect(await holdRows(slot)).toHaveLength(1);
    expect(await visible(slot)).toBe(false);
    expect(await visible(at(11, 12))).toBe(true);
  });

  it("lets a person decline to pass the time on, and offers to cancel a later booking of the same service after taking the earlier time", async () => {
    await reset();
    const slot = at(12, 10);
    const declining = await person("Decliner");
    const mover = await person("Mover");
    const declineEntry = await wait(declining, { createdMinutesAgo: 600 });
    const moverEntry = await wait(mover, { createdMinutesAgo: 300 });
    const laterId = await seedAppointment(mover, at(16, 10));
    const booked = await book("decline-" + randomUUID().slice(0, 6) + "@example.com", slot);
    await cancel(booked.manageToken);
    await drain();
    await expect(declineOffer(lastToken())).resolves.toEqual({ state: "declined" });
    expect((await offersFor(declineEntry))[0]?.status).toBe("declined");
    expect((await owner<{ status: string }[]>`select status from waitlist_entries where id = ${declineEntry}`)[0]?.status).toBe("active");
    expect((await offersFor(moverEntry))[0]).toMatchObject({ status: "scheduled", position: 2 });
    await drain();
    const token = lastToken();
    const taken = await acceptOffer(token);
    expect(taken.laterAppointmentAt).toBe(at(16, 10).toISOString());
    await expect(readOffer(token)).resolves.toMatchObject({ state: "booked", laterAppointmentAt: at(16, 10).toISOString() });
    // The later booking is found by the server from the offer, then cancelled by the normal cancel, which frees its own time.
    await expect(cancelLaterAppointment(token)).resolves.toEqual({ cancelled: true });
    const [laterRow] = await owner<{ status: string }[]>`select status from appointments where id = ${laterId}`;
    expect(laterRow?.status).toBe("cancelled");
    await expect(cancelLaterAppointment(token)).rejects.toMatchObject({ code: "no_later_appointment" });
  });

  it("keeps each business's offers, settings and switches to itself", async () => {
    await reset();
    const slot = at(13, 10);
    const waiter = await wait(await person("Scoped"));
    await owner`insert into waitlist_service_switches (tenant_id, service_id, automatic_offers) values (${fixture.tenantId}, ${fixture.serviceId}, true)`;
    await owner`insert into waitlist_settings (tenant_id, order_rule) values (${fixture.tenantId}, 'longest_waiting') on conflict (tenant_id) do nothing`;
    const booking = await book("scoped-" + randomUUID().slice(0, 6) + "@example.com", slot);
    await cancel(booking.manageToken);
    expect(await offersFor(waiter)).toHaveLength(1);
    const [offerRow] = await owner<{ token_hash: string }[]>`select token_hash from slot_offers where entry_id = ${waiter}`;
    const counts = await runtime.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${other.tenantId}, true)`;
      return {
        offers: (await transaction<{ count: string }[]>`select count(*) from slot_offers`)[0]?.count,
        settings: (await transaction<{ count: string }[]>`select count(*) from waitlist_settings`)[0]?.count,
        switches: (await transaction<{ count: string }[]>`select count(*) from waitlist_service_switches`)[0]?.count,
        // Even a write that names the other business's row finds nothing and cannot insert into it.
        updated: (await transaction`update slot_offers set status = 'withdrawn' where tenant_id = ${fixture.tenantId}`).count,
      };
    });
    expect(counts).toEqual({ offers: "0", settings: "0", switches: "0", updated: 0 });
    await expect(runtime.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${other.tenantId}, true)`;
      await transaction`insert into slot_offers (tenant_id, entry_id, service_id, location_id, practitioner_id, starts_at, ends_at, chain_id, token_hash, expires_at)
        values (${fixture.tenantId}, ${waiter}, ${fixture.serviceId}, ${fixture.locationId}, ${fixture.practitionerId}, now(), now() + interval '1 hour', 'x', ${randomUUID()}, now())`;
    })).rejects.toThrow();
    // The token lookup returns ids only and nothing for a hash that is not an offer.
    const found = await runtime`select * from kalendr_resolve_slot_offer(${offerRow!.token_hash})`;
    expect(Object.keys(found[0] ?? {}).sort()).toEqual(["offer_id", "tenant_id"]);
    expect(await runtime`select * from kalendr_resolve_slot_offer(${"0".repeat(64)})`).toHaveLength(0);
    // One live offer per time: a second live offer for the same person and start is refused by the database.
    await expect(owner`
      insert into slot_offers (tenant_id, entry_id, service_id, location_id, practitioner_id, starts_at, ends_at, chain_id, token_hash, expires_at, status)
      select tenant_id, entry_id, service_id, location_id, practitioner_id, starts_at, ends_at, ${randomUUID()}, ${randomUUID()}, expires_at, 'sent' from slot_offers where entry_id = ${waiter}`,
    ).rejects.toThrow(/slot_offers_live_slot_uq/);
  });

  it("serves the public offer link: details without private data, one tap to take it, limits per link, and a 404 for a link that never existed", async () => {
    await reset();
    const slot = at(14, 11);
    const waiter = await wait(await person("Route"));
    const booking = await book("route-" + randomUUID().slice(0, 6) + "@example.com", slot);
    await cancel(booking.manageToken);
    await drain();
    const token = lastToken();
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 20}`;
    const request = (init: RequestInit = {}) => new Request("https://app.example.test/api/public/offers/x", { ...init, headers: { "x-forwarded-for": ip, ...(init.headers as Record<string, string> | undefined) } });
    const context = (value: string) => ({ params: Promise.resolve({ token: value }) });

    const read = await offerRead(request(), context(token));
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    const { data } = (await read.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ state: "open", serviceName: "Check-up", practitionerName: "Dr Test" });
    // Nothing private: no patient, no contact, no ids of bookings or entries.
    // (The business's own public phone is shown; the customer's is not.)
    const text = JSON.stringify(data);
    expect(text).not.toMatch(/@example|Route|Waiter|entry|patient|appointmentId|token/i);

    const missing = await offerRead(request(), context("z".repeat(43)));
    expect(missing.status).toBe(404);
    expect((await offerRead(request(), context("short"))).status).toBe(404);

    const json = (body: unknown) => request({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await offerAnswer(json({ action: "accept", appointmentId: "someone-elses" }), context(token))).status).toBe(400);
    expect((await offerAnswer(json({ action: "cancel_later" }), context(token))).status).toBe(410);
    const accepted = await offerAnswer(json({ action: "accept" }), context(token));
    expect(accepted.status).toBe(201);
    const taken = ((await accepted.json()) as { data: { status: string; manageToken: string | null } }).data;
    expect(taken).toMatchObject({ status: "booked" });
    expect(taken.manageToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect((await owner<{ status: string }[]>`select status from waitlist_entries where id = ${waiter}`)[0]?.status).toBe("fulfilled");
    // Taking it again answers with the same booking and no second link.
    const again = (await (await offerAnswer(json({ action: "accept" }), context(token))).json()) as { data: { manageToken: string | null } };
    expect(again.data.manageToken).toBeNull();

    // One link is limited to 30 requests an hour.
    let refused: Response | undefined;
    for (let attempt = 0; attempt < 35 && !refused; attempt += 1) {
      const response = await offerRead(request({ headers: { "x-forwarded-for": `198.51.100.${attempt % 250}` } }), context(token));
      if (response.status === 429) refused = response;
    }
    expect(refused?.status).toBe(429);
    expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("takes sign-ups on the public waitlist route with the same bot filters as booking", async () => {
    await reset();
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 20}`;
    const post = (body: unknown, headers: Record<string, string> = {}) => waitlistJoin(new Request("https://app.example.test/api/public/waitlist", {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers }, body: JSON.stringify(body),
    }));
    const body = (over: Record<string, unknown> = {}) => ({
      clinicSlug: fixture.slug, serviceId: fixture.serviceId, locationId: fixture.locationId, practitionerIds: [], dateFrom: dayKey(1), dateTo: dayKey(9), timePreference: "afternoon",
      firstName: "Pubby", lastName: "Joiner", phone: "", email: `pub-${randomUUID().slice(0, 6)}@example.com`, preferredChannel: "email", messagingConsent: false, acceptedPrivacyNotice: true, ...over,
    });
    // A bot that fills the hidden field or sends the form at once is refused without saying why.
    expect((await post(body({ companyWebsite: "http://spam.example" }))).status).toBe(400);
    expect((await post(body({ fillMs: 100 }))).status).toBe(400);
    expect((await post(body({ acceptedPrivacyNotice: false }))).status).toBe(400);
    expect((await post(body({ email: "", phone: "" }))).status).toBe(400);
    const ok = await post(body({ fillMs: 20_000 }));
    expect(ok.status).toBe(201);
    const entryId = ((await ok.json()) as { data: { entryId: string } }).data.entryId;
    expect((await owner<{ time_preference: string; status: string }[]>`select time_preference, status from waitlist_entries where id = ${entryId}`)[0]).toEqual({ time_preference: "afternoon", status: "active" });
  });

  it("does not let the booking allowance stop someone moving to the earlier time they were offered, but still stops a customer already at it", async () => {
    await reset();
    await owner`update services set max_active_per_customer = 1 where id = ${fixture.serviceId}`;
    try {
      const slot = at(16, 10);
      const mover = await person("Capped");
      const holder = await person("Holder");
      const moverEntry = await wait(mover, { createdMinutesAgo: 600 });
      const holderEntry = await wait(holder, { createdMinutesAgo: 300 });
      // One has a later booking (the one they would let go of); the other has an earlier one that stays.
      await seedAppointment(mover, at(19, 10));
      await seedAppointment(holder, at(15, 9));
      const booked = await book("cap-" + randomUUID().slice(0, 6) + "@example.com", slot);
      await cancel(booked.manageToken);
      await drain();
      const moverTaken = await acceptOffer(lastToken());
      expect(moverTaken.status).toBe("booked");
      expect(moverTaken.laterAppointmentAt).toBe(at(19, 10).toISOString());
      expect((await owner<{ status: string }[]>`select status from waitlist_entries where id = ${moverEntry}`)[0]?.status).toBe("fulfilled");

      // The same rule for someone else, from another freed time: their earlier booking counts, so the offer is refused and stays open for the next person.
      const other = at(17, 10);
      const second = await book("cap2-" + randomUUID().slice(0, 6) + "@example.com", other);
      await cancel(second.manageToken);
      await drain();
      await expect(acceptOffer(lastToken())).rejects.toMatchObject({ code: "customer_cap_reached" });
      expect((await offersFor(holderEntry)).at(-1)?.status).toBe("sent");
    } finally {
      await owner`update services set max_active_per_customer = null where id = ${fixture.serviceId}`;
    }
  });

  it("lets two customers in one business cancel at the same moment, each freeing a time for the waitlist", async () => {
    for (let round = 0; round < 3; round += 1) {
      await reset();
      const first = at(18 + round, 9);
      const second = at(18 + round, 12);
      const waitingOne = await wait(await person(`Race${round}a`), { createdMinutesAgo: 400 });
      const waitingTwo = await wait(await person(`Race${round}b`), { createdMinutesAgo: 300 });
      const [one, two] = await Promise.all([
        book("race-a-" + randomUUID().slice(0, 6) + "@example.com", first),
        book("race-b-" + randomUUID().slice(0, 6) + "@example.com", second),
      ]);
      const results = await Promise.allSettled([cancel(one.manageToken), cancel(two.manageToken)]);
      expect(results.map((result) => result.status), `round ${round}`).toEqual(["fulfilled", "fulfilled"]);
      // Both cancellations stand, and between them the two waiting people were each offered one of the freed times.
      const cancelled = await owner<{ count: string }[]>`select count(*) from appointments where id in (${one.appointmentId}, ${two.appointmentId}) and status = 'cancelled'`;
      expect(cancelled[0]?.count).toBe("2");
      const offered = await owner<{ entry_id: string }[]>`select entry_id from slot_offers where tenant_id = ${fixture.tenantId} and status in ('scheduled', 'sent')`;
      expect(offered.map((row) => row.entry_id).sort()).toEqual([waitingOne, waitingTwo].sort());
    }
  });

  it("settles a race between taking an offer and its answer time running out: exactly one wins and everything agrees", async () => {
    for (let round = 0; round < 4; round += 1) {
      await reset();
      const slot = at(20 + round, 14);
      const first = await wait(await person(`Racer${round}`), { createdMinutesAgo: 500, to: 40 });
      const backup = await wait(await person(`Backup${round}`), { createdMinutesAgo: 100, to: 40 });
      const booking = await book("race-" + randomUUID().slice(0, 6) + "@example.com", slot);
      await cancel(booking.manageToken);
      await drain();
      const token = lastToken();
      const [offer] = await offersFor(first);
      expect(offer?.status).toBe("sent");
      await expireNow(offer!.id);
      // The tap and the expiry arrive together (the expiry is what the worker's event or sweep does).
      const [tap] = await Promise.allSettled([
        acceptOffer(token),
        worker.begin(async (transaction) => {
          await transaction`select set_config('app.tenant_id', ${fixture.tenantId}, true)`;
          return endOffer(postgresRunner(transaction), fixture.tenantId, offer!.id, "expired");
        }),
      ]);
      const booked = await owner<{ count: string }[]>`select count(*) from appointments where tenant_id = ${fixture.tenantId} and starts_at = ${slot.toISOString()}::timestamptz and status in ('booked', 'requested')`;
      const [after] = await offersFor(first);
      // The offer's answer time had already passed, so the tap loses; if the database were to let it win, the rest would still agree.
      if (tap.status === "fulfilled") {
        expect(after?.status).toBe("accepted");
        expect(booked[0]?.count).toBe("1");
        expect(await offersFor(backup)).toHaveLength(0);
      } else {
        expect(after?.status).toBe("expired");
        expect(booked[0]?.count).toBe("0");
        expect((await offersFor(backup))[0]?.status).toBe("scheduled");
        expect(await holdRows(slot)).toHaveLength(1);
      }
    }
  });
});
