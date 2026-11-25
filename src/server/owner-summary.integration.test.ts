/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createAppointment } from "@/server/appointment-repository";
import { getMyNotificationSettings, saveMyNotificationSettings } from "@/server/staff-notifications";
import { describeScratch } from "@/server/testing/scratch-database";
import { createSchedulingFixture, plusMinutes, startIn, type SchedulingFixture } from "@/server/testing/scheduling-fixture";
import { OWNER_SUMMARY_EVENT } from "@/lib/owner-summary";
import { resolvePermissions, type StaffRole } from "@/lib/permissions";
import { localParts } from "@/lib/quiet-hours";
import type { StaffContext } from "@/server/staff-context";
import type { MessageSink } from "@/worker/delivery";
import { ownerSummaryHandler } from "@/worker/handlers/staff-notify";
import { sendOwnerSummaries } from "@/worker/owner-summary-jobs";

const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? "";
const workerUrl = process.env.WORKER_DATABASE_URL ?? "";

describeScratch("owner summary email against a real database", () => {
  let fixture: SchedulingFixture;
  let worker: postgres.Sql;
  let ownerId = "";
  let ownerUserId = "";
  let ownerEmail = "";
  let otherOwnerId = "";
  const bookingIds: string[] = [];
  /** A Monday noon, local time, in the week after the bookings below: the summary then covers the week they are in. */
  let sendAt: Date;
  let revenueBefore = 0;

  const as = (role: StaffRole): StaffContext => ({
    tenantId: fixture.tenantId, clinicSlug: "lotus-dental", clinicName: "Lotus", role, permissions: resolvePermissions(role, {}),
    membershipId: ownerId, userId: ownerUserId, userName: "Owner", userEmail: ownerEmail, preview: false,
  });
  const rows = (tenantId = fixture.tenantId) => fixture.owner<{ aggregate_id: string; payload: Record<string, unknown> & { current: Record<string, number>; previous: Record<string, number> }; dedupe_key: string }[]>`
    select aggregate_id, payload, dedupe_key from outbox_events where tenant_id = ${tenantId} and event_type = ${OWNER_SUMMARY_EVENT}`;
  const reset = async () => {
    await fixture.owner`delete from outbox_events where tenant_id in (${fixture.tenantId}, ${fixture.otherTenantId}) and event_type = ${OWNER_SUMMARY_EVENT}`;
    await fixture.owner`update memberships set summary_frequency = null, summary_sent_for = null where tenant_id in (${fixture.tenantId}, ${fixture.otherTenantId})`;
  };

  beforeAll(async () => {
    fixture = await createSchedulingFixture(ownerUrl, { name: "Owner summary", durationMinutes: 30 });
    worker = postgres(workerUrl, { max: 2, prepare: false });
    const [boss] = await fixture.owner<{ id: string; user_id: string; email: string }[]>`
      select m.id, m.user_id, u.email from memberships m join auth_users u on u.id = m.user_id where m.tenant_id = ${fixture.tenantId} and m.role = 'owner' and m.is_active order by m.created_at limit 1`;
    ownerId = boss!.id; ownerUserId = boss!.user_id; ownerEmail = boss!.email;
    const [other] = await fixture.owner<{ id: string }[]>`select id from memberships where tenant_id = ${fixture.otherTenantId} and role = 'owner' and is_active limit 1`;
    otherOwnerId = other!.id;
    await reset();

    // Three bookings on one day: one stays booked, one is cancelled, one is a no-show. One customer is new that day.
    const first = startIn(3, 10);
    const make = async (startsAt: string, email: string) => {
      const made = await createAppointment({ ...fixture.bookingInput(startsAt, plusMinutes(startsAt, 30), email), practitionerId: fixture.practitionerId, slotId: `${fixture.practitionerId}:${startsAt}`, firstName: "Zorblax", lastName: "Quillfeather" }, randomUUID(), randomUUID().replaceAll("-", ""));
      bookingIds.push(made.appointmentId);
      return made;
    };
    const kept = await make(first, "kept@acme-corp.in");
    const cancelled = await make(startIn(3, 11), "cancelled@acme-corp.in");
    const missed = await make(startIn(3, 12), "missed@acme-corp.in");
    await fixture.owner`update appointments set status = 'cancelled', cancelled_at = ${first}::timestamptz where id = ${cancelled.appointmentId}`;
    await fixture.owner`update appointments set status = 'no_show' where id = ${missed.appointmentId}`;

    // The Monday after that day: find it in the business's own calendar.
    const [tenant] = await fixture.owner<{ timezone: string }[]>`select timezone from tenants where id = ${fixture.tenantId}`;
    expect(tenant!.timezone).toBe("Asia/Kolkata");
    let probe = new Date(first);
    for (;;) {
      probe = new Date(probe.getTime() + 86_400_000);
      const { day } = localParts(probe, "Asia/Kolkata");
      if (new Date(`${day}T12:00:00+05:30`).getUTCDay() === 1) { sendAt = new Date(`${day}T12:00:00+05:30`); break; }
    }
    // Money rows can never be removed, so this test adds one and compares against what the week already held.
    const weekStart = new Date(sendAt.getTime() - 7 * 86_400_000 - 12 * 3_600_000);
    const weekEnd = new Date(sendAt.getTime() - 12 * 3_600_000);
    const [before] = await fixture.owner<{ total: string }[]>`select coalesce(sum(amount_minor), 0)::text as total from payments where tenant_id = ${fixture.tenantId} and not is_test and created_at >= ${weekStart} and created_at < ${weekEnd}`;
    revenueBefore = Number(before!.total);
    await fixture.owner`insert into payments (id, tenant_id, appointment_id, amount_minor, currency, method, created_at) values (${randomUUID()}, ${fixture.tenantId}, ${kept.appointmentId}, 150000, 'INR', 'cash', ${first}::timestamptz)`;
  });

  afterAll(async () => {
    await reset();
    await fixture.owner`delete from audit_events where tenant_id = ${fixture.tenantId} and action = 'staff.notification_settings.updated'`;
    // The appointment that took money stays (money rows are never removed); the other two go.
    const removable = bookingIds.slice(1);
    await fixture.owner`delete from audit_events where appointment_id in ${fixture.owner(bookingIds)}`;
    await fixture.owner`delete from appointments where id in ${fixture.owner(removable)}`;
    await fixture.cleanup().catch(() => undefined);
    await worker.end();
  });

  it("queues one weekly summary for each owner with real counts, nothing private, and only once", async () => {
    await sendOwnerSummaries(worker, () => sendAt);
    const mine = (await rows()).filter((row) => row.aggregate_id === ownerId);
    expect(mine).toHaveLength(1);
    const { current } = mine[0]!.payload;
    expect(current).toMatchObject({ bookings: 1, cancellations: 1, noShows: 1, revenueMinor: revenueBefore + 150_000 });
    expect(JSON.stringify(mine[0]!.payload)).not.toMatch(/Quillfeather|acme-corp|\+91|Zorblax/);
    // Each business gets its own: the other business's owner is a different row, in a different business.
    expect((await rows(fixture.otherTenantId)).every((row) => row.aggregate_id === otherOwnerId)).toBe(true);
    // The same week is never sent twice.
    await sendOwnerSummaries(worker, () => sendAt);
    expect((await rows()).filter((row) => row.aggregate_id === ownerId)).toHaveLength(1);
  });

  it("writes the email with the business's numbers and the change from the week before", async () => {
    const [row] = (await rows()).filter((entry) => entry.aggregate_id === ownerId);
    const sent: { recipient: { email: string }; templateKey: string; body: string }[] = [];
    const sink = { async deliver(_db: unknown, outgoing: { recipient?: { email: string }; message: { body: string; templateKey: string } }) {
      sent.push({ recipient: outgoing.recipient!, templateKey: outgoing.message.templateKey, body: outgoing.message.body });
      return "delivered" as const;
    } } as unknown as MessageSink;
    await fixture.owner.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${fixture.tenantId}, true)`;
      const outcome = await ownerSummaryHandler({ sink, now: () => sendAt })(transaction, {
        id: randomUUID(), tenantId: fixture.tenantId, aggregateType: "owner_summary", aggregateId: ownerId, eventType: OWNER_SUMMARY_EVENT, payload: row!.payload, dedupeKey: row!.dedupe_key, attemptCount: 0,
      });
      expect(outcome).toBe("delivered");
    });
    expect(sent[0]!.recipient.email).toBe(ownerEmail);
    expect(sent[0]!.templateKey).toBe("staff.summary");
    const body = JSON.parse(sent[0]!.body) as { periodWord: string; rows: { label: string; value: string; change: string }[] };
    expect(body.periodWord).toBe("week");
    expect(body.rows.find((line) => line.label === "Bookings")).toMatchObject({ value: "1", change: "up from none" });
    expect(body.rows.find((line) => line.label === "Revenue")?.value).toBeDefined();
  });

  it("stops when the owner opts out, and sends monthly only on the 1st to the 3rd", async () => {
    await reset();
    await saveMyNotificationSettings(as("owner"), { quietHours: null, digest: { enabled: false, minute: 420 }, summaryFrequency: "off" });
    expect((await getMyNotificationSettings(as("owner"))).summary).toEqual({ frequency: "off", available: true });
    await sendOwnerSummaries(worker, () => sendAt);
    expect((await rows()).filter((row) => row.aggregate_id === ownerId)).toHaveLength(0);

    await saveMyNotificationSettings(as("owner"), { quietHours: null, digest: { enabled: false, minute: 420 }, summaryFrequency: "monthly" });
    // Mid-month: nothing, and the period is not stamped as sent.
    await sendOwnerSummaries(worker, () => new Date("2026-12-15T12:00:00+05:30"));
    expect((await rows()).filter((row) => row.aggregate_id === ownerId)).toHaveLength(0);
    // The 1st: the month before.
    await fixture.owner`update appointments set starts_at = '2026-11-10T10:00:00+05:30', ends_at = '2026-11-10T10:30:00+05:30' where id = ${bookingIds[0]!}`;
    await sendOwnerSummaries(worker, () => new Date("2026-12-01T12:00:00+05:30"));
    const [monthly] = (await rows()).filter((row) => row.aggregate_id === ownerId);
    expect(monthly).toBeDefined();
    expect(monthly!.payload).toMatchObject({ frequency: "monthly", start: "2026-11-01", last: "2026-11-30" });
  });

  it("lets only an owner choose a summary", async () => {
    await reset();
    await saveMyNotificationSettings(as("admin"), { quietHours: null, digest: { enabled: false, minute: 420 }, summaryFrequency: "monthly" });
    const [row] = await fixture.owner<{ summary_frequency: string | null }[]>`select summary_frequency from memberships where id = ${ownerId}`;
    expect(row!.summary_frequency).toBeNull();
    expect((await getMyNotificationSettings(as("admin"))).summary.available).toBe(false);
  });
});
