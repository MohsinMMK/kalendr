/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createAppointment } from "@/server/appointment-repository";
import { getMyNotificationSettings, listNotifications, markNotificationsRead, saveMyNotificationSettings, setPreference } from "@/server/staff-notifications";
import { describeScratch } from "@/server/testing/scratch-database";
import { createSchedulingFixture, plusMinutes, startIn, type SchedulingFixture } from "@/server/testing/scheduling-fixture";
import { resolvePermissions, type StaffRole } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";
import { sendStaffDigests } from "@/worker/staff-digest-jobs";
import { staffDigestHandler, staffEmailHandler } from "@/worker/handlers/staff-notify";
import { notifyStaffFromWorker } from "@/worker/staff-alerts";
import type { MessageSink } from "@/worker/delivery";
import { STAFF_DIGEST_EVENT } from "@/lib/staff-alerts";

const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? "";
const workerUrl = process.env.WORKER_DATABASE_URL ?? "";

interface Member { id: string; userId: string; email: string }

describeScratch("staff notifications against a real database (feature 56)", () => {
  let fixture: SchedulingFixture;
  let worker: postgres.Sql;
  let doctor: Member;
  let desk: Member;
  let boss: Member;
  let stranger: Member;
  const bookingIds: string[] = [];
  let deskUserId = "";

  const as = (member: Member, role: StaffRole, tenantId = fixture.tenantId): StaffContext => ({
    tenantId, clinicSlug: "lotus-dental", clinicName: "Lotus", role, permissions: resolvePermissions(role, {}),
    membershipId: member.id, userId: member.userId, userName: "Staff", userEmail: member.email, preview: false,
  });
  const member = async (role: string, tenantId = fixture.tenantId): Promise<Member> => {
    const [row] = await fixture.owner<{ id: string; user_id: string; email: string }[]>`
      select m.id, m.user_id, u.email from memberships m join auth_users u on u.id = m.user_id where m.tenant_id = ${tenantId} and m.role = ${role} and m.is_active order by m.created_at limit 1`;
    return { id: row!.id, userId: row!.user_id, email: row!.email };
  };
  const book = async (startsAt: string, email: string, practitionerId = fixture.practitionerId) => {
    const made = await createAppointment({ ...fixture.bookingInput(startsAt, plusMinutes(startsAt, 30), email), practitionerId, slotId: `${practitionerId}:${startsAt}`, firstName: "Zorblax", lastName: "Quillfeather" }, randomUUID(), randomUUID().replaceAll("-", ""));
    bookingIds.push(made.appointmentId);
    return made;
  };
  const pushes = (membershipId: string) => fixture.owner<{ available_at: Date; payload: { title: string; body?: string; kind: string } }[]>`
    select available_at, payload from outbox_events where tenant_id = ${fixture.tenantId} and event_type = 'push.send' and aggregate_id = ${membershipId} order by created_at`;

  beforeAll(async () => {
    fixture = await createSchedulingFixture(ownerUrl, { name: "Staff notify", durationMinutes: 30 });
    worker = postgres(workerUrl, { max: 2, prepare: false });
    doctor = await member("practitioner");
    // The seeded businesses have no receptionist, so this test adds one (and removes them afterwards).
    deskUserId = randomUUID();
    await fixture.owner`insert into auth_users (id, name, email, email_verified) values (${deskUserId}, 'Desk Person', ${`desk.${deskUserId}@example.com`}, true)`;
    await fixture.owner`insert into memberships (tenant_id, user_id, role) values (${fixture.tenantId}, ${deskUserId}, 'receptionist')`;
    desk = await member("receptionist");
    boss = await member("owner");
    stranger = await member("owner", fixture.otherTenantId);
    // The test practitioner is the seeded doctor's own calendar.
    await fixture.owner`update practitioners set auth_user_id = ${doctor.userId} where id = ${fixture.practitionerId}`;
    await fixture.owner`delete from staff_notifications where tenant_id = ${fixture.tenantId}`;
  });

  afterAll(async () => {
    await fixture.owner`update memberships set quiet_start_minute = null, quiet_end_minute = null, digest_enabled = null, digest_minute = null, digest_sent_on = null where tenant_id in (${fixture.tenantId}, ${fixture.otherTenantId})`;
    await fixture.owner`delete from notification_preferences where tenant_id = ${fixture.tenantId}`;
    await fixture.owner`delete from push_subscriptions where tenant_id = ${fixture.tenantId}`;
    await fixture.owner`delete from staff_notifications where tenant_id = ${fixture.tenantId}`;
    await fixture.owner`delete from outbox_events where tenant_id = ${fixture.tenantId}`;
    await fixture.owner`delete from audit_events where tenant_id = ${fixture.tenantId} and action = 'staff.notification_settings.updated'`;
    if (bookingIds.length) {
      await fixture.owner`delete from audit_events where appointment_id in ${fixture.owner(bookingIds)}`;
      await fixture.owner`delete from appointments where id in ${fixture.owner(bookingIds)}`;
    }
    await fixture.owner`delete from memberships where tenant_id = ${fixture.tenantId} and user_id = ${deskUserId}`;
    await fixture.owner`delete from auth_users where id = ${deskUserId}`;
    await fixture.cleanup();
    await worker.end();
  });

  async function addDevice(membershipId: string) {
    await fixture.owner`
      insert into push_subscriptions (tenant_id, owner_type, membership_id, endpoint_hash, subscription_ciphertext, key_version)
      values (${fixture.tenantId}, 'staff', ${membershipId}, ${randomUUID().replaceAll("-", "")}, 's1.test', 1)`;
  }

  it("alerts a practitioner by push when a customer books with them, with a first name and no contact details, and tells nobody it is not for", async () => {
    await addDevice(doctor.id);
    await addDevice(boss.id);
    await book(startIn(5, 10), "first@acme-corp.in");
    const [alert] = await pushes(doctor.id);
    expect(alert).toBeDefined();
    expect(alert!.payload.kind).toBe("new_booking");
    expect(alert!.payload.body).toMatch(/^Zorblax · Staff notify Service · /);
    expect(JSON.stringify(alert!.payload)).not.toMatch(/Quillfeather|acme-corp|\+91/);
    // It was queued for now, not held.
    expect(alert!.available_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    // The owner has a device but defaults to the bell, so no push; the receptionist and owner still get the bell.
    expect(await pushes(boss.id)).toHaveLength(0);
    expect((await listNotifications(as(desk, "receptionist"))).items.some((item) => item.kind === "new_booking")).toBe(true);
    expect((await listNotifications(as(boss, "owner"))).items.some((item) => item.kind === "new_booking")).toBe(true);
    expect((await listNotifications(as(doctor, "practitioner"))).items.some((item) => item.kind === "new_booking")).toBe(true);
    // Another business's staff see nothing.
    expect((await listNotifications(as(stranger, "owner", fixture.otherTenantId))).items).toEqual([]);
  });

  it("holds push and email during quiet hours until they end, while the bell shows at once", async () => {
    await setPreference(as(doctor, "practitioner"), { kind: "new_booking", inApp: true, push: true, email: true });
    // Quiet for the whole day except one minute, so the test never depends on the hour it runs in: from 00:00 to 23:59.
    await saveMyNotificationSettings(as(doctor, "practitioner"), { quietHours: { start: 0, end: 1439 }, digest: { enabled: false, minute: 420 } });
    await fixture.owner`delete from outbox_events where tenant_id = ${fixture.tenantId}`;
    await fixture.owner`delete from staff_notifications where tenant_id = ${fixture.tenantId} and membership_id = ${doctor.id}`;
    await book(startIn(5, 11), "quiet@acme-corp.in");
    const [held] = await pushes(doctor.id);
    expect(held!.available_at.getTime()).toBeGreaterThan(Date.now() + 1000);
    const [email] = await fixture.owner<{ available_at: Date }[]>`select available_at from outbox_events where tenant_id = ${fixture.tenantId} and event_type = 'staff.email' and aggregate_id = ${doctor.id}`;
    expect(email!.available_at.getTime()).toBe(held!.available_at.getTime());
    const [tenant] = await fixture.owner<{ timezone: string }[]>`select timezone from tenants where id = ${fixture.tenantId}`;
    const endsAt = new Intl.DateTimeFormat("en-GB", { timeZone: tenant!.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(held!.available_at);
    expect(endsAt).toBe("23:59");
    expect((await listNotifications(as(doctor, "practitioner"))).items.some((item) => item.kind === "new_booking")).toBe(true);
    // Quiet hours off again: the next alert goes at once.
    await saveMyNotificationSettings(as(doctor, "practitioner"), { quietHours: null, digest: { enabled: false, minute: 420 } });
    await fixture.owner`delete from outbox_events where tenant_id = ${fixture.tenantId}`;
    await book(startIn(5, 12), "free@acme-corp.in");
    const [now] = await pushes(doctor.id);
    expect(now!.available_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("sends an alert email to the person's own address, with the first name and nothing private", async () => {
    await fixture.owner`delete from outbox_events where tenant_id = ${fixture.tenantId}`;
    const delivered: { recipient: { email: string }; body: string; templateKey: string }[] = [];
    const sink = { async deliver(_db: unknown, outgoing: { recipient?: { email: string }; message: { body: string; templateKey: string } }) {
      delivered.push({ recipient: outgoing.recipient!, body: outgoing.message.body, templateKey: outgoing.message.templateKey });
      return "delivered" as const;
    } } as unknown as MessageSink;
    await book(startIn(6, 10), "mail@acme-corp.in");
    const [job] = await fixture.owner<{ id: string; tenant_id: string; payload: unknown; dedupe_key: string }[]>`
      select id, tenant_id, payload, dedupe_key from outbox_events where tenant_id = ${fixture.tenantId} and event_type = 'staff.email' and aggregate_id = ${doctor.id}`;
    expect(job).toBeDefined();
    await fixture.owner.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${fixture.tenantId}, true)`;
      const outcome = await staffEmailHandler({ sink, now: () => new Date() })(transaction, {
        id: job!.id, tenantId: job!.tenant_id, aggregateType: "staff_email", aggregateId: doctor.id, eventType: "staff.email", payload: job!.payload, dedupeKey: job!.dedupe_key, attemptCount: 0,
      });
      expect(outcome).toBe("delivered");
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.recipient.email).toBe(doctor.email);
    expect(delivered[0]!.templateKey).toBe("staff.alert");
    expect(delivered[0]!.body).toContain("Zorblax");
    expect(delivered[0]!.body).not.toMatch(/Quillfeather|acme-corp|\+91/);
  });

  it("emails an owner their day at the chosen time, once, listing bookings, requests waiting and yesterday's cancellations, and skips an empty day", async () => {
    const [tenant] = await fixture.owner<{ timezone: string }[]>`select timezone from tenants where id = ${fixture.tenantId}`;
    await fixture.owner`delete from outbox_events where tenant_id = ${fixture.tenantId}`;
    await fixture.owner`update memberships set digest_sent_on = null, digest_minute = 0, digest_enabled = null where tenant_id in (${fixture.tenantId}, ${fixture.otherTenantId})`;
    // The day under test is a few days ahead, with two bookings on it and one booking cancelled the day before.
    const dayStart = startIn(9, 0);
    const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: tenant!.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(dayStart));
    const made = [await book(startIn(9, 9), "d1@acme-corp.in"), await book(startIn(9, 15), "d2@acme-corp.in"), await book(startIn(9, 16), "d3@acme-corp.in")];
    await fixture.owner`update appointments set status = 'cancelled', cancelled_at = ${plusMinutes(dayStart, -12 * 60)}::timestamptz where id = ${made[2]!.appointmentId}`;
    const sevenThirty = new Date(new Date(dayStart).getTime() + 7.5 * 3_600_000 - 5.5 * 3_600_000 * 0);
    // 07:30 local on that day, whatever the zone: the day start (00:00 local) plus 7.5 hours.
    expect(sevenThirty.getTime()).toBe(new Date(dayStart).getTime() + 27_000_000);

    const queued = await sendStaffDigests(worker, () => sevenThirty);
    expect(queued.tenants).toBeGreaterThan(0);
    const rows = await fixture.owner<{ aggregate_id: string; payload: { today: { firstName: string; service: string; time: string }[]; todayCount: number; cancelled: unknown[]; day: string }; dedupe_key: string }[]>`
      select aggregate_id, payload, dedupe_key from outbox_events where tenant_id = ${fixture.tenantId} and event_type = ${STAFF_DIGEST_EVENT}`;
    const owners = rows.filter((row) => row.aggregate_id === boss.id);
    expect(owners).toHaveLength(1);
    expect(owners[0]!.payload.day).toBe(dayKey);
    expect(owners[0]!.payload.todayCount).toBe(2);
    expect(owners[0]!.payload.today.map((line) => line.firstName)).toEqual(["Zorblax", "Zorblax"]);
    expect(owners[0]!.payload.cancelled).toHaveLength(1);
    expect(JSON.stringify(owners[0]!.payload)).not.toMatch(/Quillfeather|acme-corp|\+91/);
    // Practitioners and receptionists are off by default; the doctor chose not to, so only owner-level people are in it.
    expect(rows.some((row) => row.aggregate_id === desk.id || row.aggregate_id === doctor.id)).toBe(false);
    // Once only: a second pass the same day adds nothing.
    await sendStaffDigests(worker, () => sevenThirty);
    expect((await fixture.owner`select 1 from outbox_events where tenant_id = ${fixture.tenantId} and event_type = ${STAFF_DIGEST_EVENT} and aggregate_id = ${boss.id}`)).toHaveLength(1);

    // The email names the day and the list, goes to the owner's own address and carries nothing private.
    const sent: { recipient: { email: string }; body: string }[] = [];
    const sink = { async deliver(_db: unknown, outgoing: { recipient?: { email: string }; message: { body: string } }) {
      sent.push({ recipient: outgoing.recipient!, body: outgoing.message.body });
      return "delivered" as const;
    } } as unknown as MessageSink;
    await fixture.owner.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${fixture.tenantId}, true)`;
      await staffDigestHandler({ sink, now: () => sevenThirty })(transaction, {
        id: randomUUID(), tenantId: fixture.tenantId, aggregateType: "staff_digest", aggregateId: boss.id, eventType: STAFF_DIGEST_EVENT, payload: owners[0]!.payload, dedupeKey: owners[0]!.dedupe_key, attemptCount: 0,
      });
    });
    expect(sent[0]!.recipient.email).toBe(boss.email);
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ todayCount: 2, dayLabel: expect.stringMatching(/\d/) });

    // A day with nothing on it sends nothing, and the day is still marked looked at.
    await fixture.owner`delete from outbox_events where tenant_id = ${fixture.tenantId}`;
    await fixture.owner`update memberships set digest_sent_on = null where tenant_id = ${fixture.tenantId}`;
    await sendStaffDigests(worker, () => new Date(new Date(dayStart).getTime() + 40 * 86_400_000 + 27_000_000));
    expect((await fixture.owner`select 1 from outbox_events where tenant_id = ${fixture.tenantId} and event_type = ${STAFF_DIGEST_EVENT}`)).toHaveLength(0);
    const [stamp] = await fixture.owner<{ digest_sent_on: string | null }[]>`select digest_sent_on::text from memberships where id = ${boss.id}`;
    expect(stamp!.digest_sent_on).not.toBeNull();
  });

  it("waits for the chosen time, and honours turning the digest off or on", async () => {
    await fixture.owner`delete from outbox_events where tenant_id = ${fixture.tenantId}`;
    const dayStart = startIn(9, 0);
    await fixture.owner`update memberships set digest_sent_on = null, digest_minute = 480, digest_enabled = null where tenant_id = ${fixture.tenantId}`;
    // 07:30 is before an 08:00 digest.
    await sendStaffDigests(worker, () => new Date(new Date(dayStart).getTime() + 27_000_000));
    expect((await fixture.owner`select 1 from outbox_events where tenant_id = ${fixture.tenantId} and event_type = ${STAFF_DIGEST_EVENT}`)).toHaveLength(0);
    // The owner turns theirs off.
    await saveMyNotificationSettings(as(boss, "owner"), { quietHours: null, digest: { enabled: false, minute: 0 } });
    await sendStaffDigests(worker, () => new Date(new Date(dayStart).getTime() + 27_000_000));
    expect((await fixture.owner`select 1 from outbox_events where tenant_id = ${fixture.tenantId} and event_type = ${STAFF_DIGEST_EVENT} and aggregate_id = ${boss.id}`)).toHaveLength(0);
    // A receptionist turns it on.
    await saveMyNotificationSettings(as(desk, "receptionist"), { quietHours: null, digest: { enabled: true, minute: 0 } });
    await fixture.owner`update memberships set digest_sent_on = null where tenant_id = ${fixture.tenantId}`;
    await sendStaffDigests(worker, () => new Date(new Date(dayStart).getTime() + 27_000_000));
    expect((await fixture.owner`select 1 from outbox_events where tenant_id = ${fixture.tenantId} and event_type = ${STAFF_DIGEST_EVENT} and aggregate_id = ${desk.id}`)).toHaveLength(1);
  });

  it("shows a receptionist's bell unread items and marks them read, and refuses to mark someone else's", async () => {
    const asDesk = as(desk, "receptionist");
    const before = await listNotifications(asDesk);
    expect(before.unread).toBeGreaterThan(0);
    const mineIds = before.items.slice(0, 1).map((item) => item.id);
    const after = await markNotificationsRead(asDesk, { ids: mineIds });
    expect(after.unread).toBe(before.unread - 1);
    // Someone else's id matches nothing.
    const bossItems = (await listNotifications(as(boss, "owner"))).items.map((item) => item.id);
    const unchanged = await markNotificationsRead(asDesk, { ids: bossItems });
    expect(unchanged.unread).toBe(after.unread);
    expect((await markNotificationsRead(asDesk, { all: true })).unread).toBe(0);
    expect((await listNotifications(as(boss, "owner"))).unread).toBeGreaterThan(0);
  });

  it("stores quiet hours and the digest choice, refuses nonsense, and tells a customer's message to the right people with a first name only", async () => {
    const saved = await saveMyNotificationSettings(as(desk, "receptionist"), { quietHours: { start: 22 * 60, end: 7 * 60 }, digest: { enabled: false, minute: 450 } });
    expect(saved.quietHours).toEqual({ start: 1320, end: 420 });
    expect(saved.digest).toEqual({ enabled: false, minute: 450 });
    expect((await getMyNotificationSettings(as(boss, "owner"))).digestOnByDefault).toBe(true);
    await expect(fixture.owner`update memberships set quiet_start_minute = 600, quiet_end_minute = 600 where id = ${desk.id}`).rejects.toThrow();
    await expect(fixture.owner`update memberships set digest_minute = 2000 where id = ${desk.id}`).rejects.toThrow();
    await saveMyNotificationSettings(as(desk, "receptionist"), { quietHours: null, digest: { enabled: false, minute: 450 } });

    // A message from a customer reaches the people who may reply to it, with a first name and a link, never its text.
    const [patient] = await fixture.owner<{ patient_id: string }[]>`select patient_id from appointments where id = ${bookingIds[0]!}`;
    await fixture.owner`delete from staff_notifications where tenant_id = ${fixture.tenantId}`;
    await fixture.owner.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${fixture.tenantId}, true)`;
      await notifyStaffFromWorker(transaction, fixture.tenantId, { kind: "message", dedupeKey: `message:${randomUUID()}`, link: "/messages", patientId: patient!.patient_id });
    });
    const items = (await listNotifications(as(desk, "receptionist"))).items;
    expect(items.find((item) => item.kind === "message")).toMatchObject({ title: "New message", link: "/messages" });
    expect(JSON.stringify(items)).not.toMatch(/Quillfeather|acme-corp/);
  });
});
