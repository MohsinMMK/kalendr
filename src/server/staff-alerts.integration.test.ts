/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { PublicBookingInput } from "@/lib/contracts";
import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

vi.mock("server-only", () => ({}));

import { createAppointment } from "@/server/appointment-repository";
import type { LiveSignal } from "@/server/live/hub";
import { subscribeToLiveChanges } from "@/server/live/listener";
import {
  listNotifications,
  listPreferences,
  markNotificationsRead,
  savePushSubscription,
  setPreference,
} from "@/server/staff-notifications";
import { pushSendHandler } from "@/worker/handlers/push-send";
import type { OutboxEvent } from "@/worker/handlers/types";
import type { PushResult, PushSender } from "@/worker/push";
import { sealBytes } from "@/server/keys/records";
import type { FileStore } from "@/server/file-store";
import { reEncryptTenant, rotateTenantKey } from "@/worker/storage-jobs";
import type { PushMessage, StoredSubscription } from "@/lib/staff-alerts";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const isLocal = (url: string | undefined) => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5544", "5545"].includes(parsed.port) && ["/kalendr_local", "/nira_local"].includes(parsed.pathname);
};
const describeLocal = isLocal(runtimeUrl) && isLocal(ownerUrl) && isLocal(workerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const endpointOf = (label: string) => `https://push.example.com/send/${label}-${randomUUID()}`;
const keys = { p256dh: "B".repeat(87), auth: "a".repeat(22) };

describeLocal("live updates and staff alerts", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let tenantA = "";
  let tenantB = "";
  let locationId = "";
  let ownerMembership = "";
  let practitionerMembership = "";
  let memberB = "";
  const practitionerId = randomUUID();
  const serviceId = randomUUID();
  const idempotencyKeys: string[] = [];

  const context = (tenantId: string, membershipId: string, role: "owner" | "practitioner"): StaffContext => ({
    tenantId, clinicSlug: "x", clinicName: "X", role, permissions: resolvePermissions(role, {}),
    membershipId, userId: null, userName: "Desk", userEmail: "test@example.com", preview: false,
  });

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false });
    worker = postgres(workerUrl!, { max: 2, prepare: false });
    const [a] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    const [b] = await owner<{ id: string }[]>`select id from tenants where slug = 'riverbend-care'`;
    tenantA = a!.id;
    tenantB = b!.id;
    locationId = (await owner<{ id: string }[]>`select id from locations where tenant_id = ${tenantA} limit 1`)[0]!.id;
    const membersA = await owner<{ id: string; role: string }[]>`select id, role from memberships where tenant_id = ${tenantA} and is_active order by role`;
    ownerMembership = membersA.find((row) => row.role === "owner")!.id;
    practitionerMembership = membersA.find((row) => row.role === "practitioner")!.id;
    memberB = (await owner<{ id: string }[]>`select id from memberships where tenant_id = ${tenantB} and role = 'owner'`)[0]!.id;

    await owner.begin(async (transaction) => {
      await transaction`insert into practitioners (id, tenant_id, name, title, initials, specialty) values (${practitionerId}, ${tenantA}, 'Alert Test', 'Dentist', 'AT', 'Testing')`;
      await transaction`
        insert into services (id, tenant_id, name, description, duration_minutes, buffer_before_minutes, buffer_after_minutes,
          slot_interval_minutes, minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types)
        values (${serviceId}, ${tenantA}, 'Alert Test Service', 'Local integration test', 15, 0, 0, 15, 120, 90, 'instant', ${["new", "returning"]})`;
      await transaction`insert into service_locations (tenant_id, service_id, location_id) values (${tenantA}, ${serviceId}, ${locationId})`;
      await transaction`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${tenantA}, ${practitionerId}, ${serviceId})`;
      await transaction`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${tenantA}, ${practitionerId}, ${locationId})`;
      for (let day = 1; day <= 7; day += 1) {
        await transaction`
          insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
          values (${randomUUID()}, ${tenantA}, ${locationId}, ${practitionerId}, ${day}, '00:00', '23:45', 'Asia/Kolkata', '2025-01-01', 15)`;
      }
    });
  });

  afterAll(async () => {
    await owner.begin(async (transaction) => {
      const patientIds = await transaction<{ patient_id: string }[]>`select distinct patient_id from appointments where service_id = ${serviceId}`;
      await transaction`delete from staff_notifications where tenant_id = ${tenantA}`;
      await transaction`delete from push_subscriptions where tenant_id in (${tenantA}, ${tenantB})`;
      await transaction`delete from notification_preferences where tenant_id in (${tenantA}, ${tenantB})`;
      await transaction`delete from audit_events where appointment_id in (select id from appointments where service_id = ${serviceId})`;
      await transaction`delete from outbox_events where tenant_id = ${tenantA}`;
      await transaction`delete from resource_reservations where appointment_id in (select id from appointments where service_id = ${serviceId})`;
      await transaction`delete from appointments where service_id = ${serviceId}`;
      if (idempotencyKeys.length) await transaction`delete from idempotency_keys where tenant_id = ${tenantA} and key in ${transaction(idempotencyKeys)}`;
      if (patientIds.length) await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id in ${transaction(patientIds.map((row) => row.patient_id))})`;
      if (patientIds.length) await transaction`delete from patients where id in ${transaction(patientIds.map((row) => row.patient_id))}`;
      await transaction`delete from availability_rules where practitioner_id = ${practitionerId}`;
      await transaction`delete from practitioner_services where practitioner_id = ${practitionerId}`;
      await transaction`delete from practitioner_locations where practitioner_id = ${practitionerId}`;
      await transaction`delete from service_locations where service_id = ${serviceId}`;
      await transaction`delete from services where id = ${serviceId}`;
      await transaction`delete from practitioners where id = ${practitionerId}`;
    });
    await owner.end();
    await worker.end();
  });

  async function book(hour: number): Promise<{ appointmentId: string }> {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(Date.now() + 12 * 86_400_000));
    const startsAt = `${day}T${String(hour).padStart(2, "0")}:00:00.000+05:30`;
    const input: PublicBookingInput = {
      clinicSlug: "lotus-dental", patientType: "new", bookingFor: "self", locationId, serviceId, practitionerId, slotId: randomUUID(),
      startsAt, endsAt: new Date(new Date(startsAt).getTime() + 15 * 60_000).toISOString(),
      firstName: "Zorblax", lastName: "Quillfeather", phone: "+91 90000 00123", email: "zorblax@example.com", preferredChannel: "email",
      accessibilityNeed: "None", acceptedPrivacyNotice: true, messagingConsent: false,
    };
    const key = randomUUID();
    idempotencyKeys.push(key);
    return createAppointment(input, key, randomUUID().replaceAll("-", ""));
  }

  it("shows a booking to another open screen of the same business within two seconds, and never to another business", async () => {
    const heardA: LiveSignal[] = [];
    const heardB: LiveSignal[] = [];
    const stopA = await subscribeToLiveChanges(tenantA, (signal) => heardA.push(signal));
    const stopB = await subscribeToLiveChanges(tenantB, (signal) => heardB.push(signal));
    try {
      const startedAt = Date.now();
      await book(10);
      while (!heardA.some((signal) => signal.type === "change" && signal.kind === "appointment") && Date.now() - startedAt < 2_000) await sleep(25);
      expect(heardA.some((signal) => signal.type === "change" && signal.kind === "appointment")).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      // The alert written in the same transaction reaches the bell too.
      await sleep(300);
      expect(heardA.some((signal) => signal.type === "change" && signal.kind === "notification")).toBe(true);
      // Business B heard nothing: not the booking, not the alert.
      expect(heardB.filter((signal) => signal.type === "change")).toEqual([]);
    } finally {
      stopA();
      stopB();
    }
  });

  it("alerts the right people with a short title that holds no names or contact details", async () => {
    const asOwner = await listNotifications(context(tenantA, ownerMembership, "owner"));
    const mine = asOwner.items.find((item) => item.kind === "new_booking");
    expect(mine).toBeDefined();
    expect(mine!.title).toMatch(/^New booking at /);
    expect(mine!.link).toMatch(/^\/schedule\?open=/);
    for (const forbidden of ["Zorblax", "Quillfeather", "90000", "example.com"]) expect(mine!.title).not.toContain(forbidden);
    expect(asOwner.unread).toBeGreaterThan(0);

    // A practitioner hears about their own bookings only (feature 56), and this booking is with someone else ...
    const asPractitioner = await listNotifications(context(tenantA, practitionerMembership, "practitioner"));
    expect(asPractitioner.items.some((item) => item.kind === "new_booking" && item.link === mine!.link)).toBe(false);
    // ... and never about payments, which they cannot take.
    expect(asPractitioner.items.some((item) => item.kind === "payment")).toBe(false);
  });

  it("keeps each person's alerts private, and each business's apart", async () => {
    const other = await listNotifications(context(tenantB, memberB, "owner"));
    expect(other.items).toEqual([]);

    // Business B's own row-level scope cannot see A's rows at all.
    const runtime = postgres(runtimeUrl!, { max: 1, prepare: false });
    try {
      const rows = await runtime.begin(async (transaction) => {
        await transaction`select set_config('app.tenant_id', ${tenantB}, true)`;
        return transaction`select id from staff_notifications`;
      });
      expect(rows).toHaveLength(0);
    } finally {
      await runtime.end();
    }

    // Marking read is limited to your own alerts: another member's ids match nothing.
    const mine = await listNotifications(context(tenantA, ownerMembership, "owner"));
    const theirs = await listNotifications(context(tenantA, practitionerMembership, "practitioner"));
    const after = await markNotificationsRead(context(tenantA, ownerMembership, "owner"), { ids: theirs.items.map((item) => item.id) });
    expect(after.unread).toBe(mine.unread);
    const cleared = await markNotificationsRead(context(tenantA, ownerMembership, "owner"), { all: true });
    expect(cleared.unread).toBe(0);
    expect((await listNotifications(context(tenantA, practitionerMembership, "practitioner"))).unread).toBe(theirs.unread);
  });

  it("respects each person's choices", async () => {
    const asPractitioner = context(tenantA, practitionerMembership, "practitioner");
    expect((await listPreferences(asPractitioner)).find((row) => row.kind === "new_booking")).toEqual({ kind: "new_booking", inApp: true, push: true, email: false });
    expect((await listPreferences(asPractitioner)).some((row) => row.kind === "payment")).toBe(false);
    await setPreference(asPractitioner, { kind: "new_booking", inApp: false, push: false, email: false });
    const before = (await listNotifications(asPractitioner)).items.length;
    await book(11);
    expect((await listNotifications(asPractitioner)).items.length).toBe(before);
    // The owner left everything on and hears about it.
    expect((await listNotifications(context(tenantA, ownerMembership, "owner"))).unread).toBeGreaterThan(0);
  });

  it("stores a push address sealed, sends a short alert, forgets an address the push service reports gone, and retries only when nothing went out", async () => {
    const asOwner = context(tenantA, ownerMembership, "owner");
    // Owners hear by push only when they ask to (feature 56); this one does.
    await setPreference(asOwner, { kind: "new_booking", inApp: true, push: true, email: false });
    const goodEndpoint = endpointOf("good");
    const goneEndpoint = endpointOf("gone");
    await savePushSubscription(asOwner, { endpoint: goodEndpoint, keys });
    await savePushSubscription(asOwner, { endpoint: goneEndpoint, keys });

    const stored = await owner<{ subscription_ciphertext: string; key_version: number }[]>`select subscription_ciphertext, key_version from push_subscriptions where tenant_id = ${tenantA}`;
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(row.subscription_ciphertext.startsWith("s1.")).toBe(true);
      expect(row.subscription_ciphertext).not.toContain("push.example.com");
      expect(row.key_version).toBeGreaterThan(0);
    }

    await book(12);
    const [event] = await owner<{ id: string; payload: Record<string, unknown>; dedupe_key: string }[]>`
      select id, payload, dedupe_key from outbox_events
      where tenant_id = ${tenantA} and event_type = 'push.send' and payload->>'membershipId' = ${ownerMembership}
      order by created_at desc limit 1`;
    expect(event).toBeDefined();
    expect(event!.payload).toMatchObject({ kind: "new_booking" });
    // The body carries the first name, the service and the time (feature 56), and never a last name, phone or email.
    expect(String((event!.payload as { body?: string }).body)).toMatch(/^Zorblax · Alert Test Service · /);
    for (const forbidden of ["Quillfeather", "90000", "example.com"]) expect(JSON.stringify(event!.payload)).not.toContain(forbidden);

    const sent: { endpoint: string; message: PushMessage }[] = [];
    const answers = new Map<string, PushResult>([[goodEndpoint, "sent"], [goneEndpoint, "gone"]]);
    const fake: PushSender = {
      mode: "local_capture",
      async send(subscription: StoredSubscription, message: PushMessage) {
        sent.push({ endpoint: subscription.endpoint, message });
        return answers.get(subscription.endpoint) ?? "failed";
      },
    };
    const outbox: OutboxEvent = {
      id: event!.id, tenantId: tenantA, aggregateType: "push", aggregateId: ownerMembership, eventType: "push.send",
      payload: event!.payload, dedupeKey: event!.dedupe_key, attemptCount: 0,
    };
    const run = (sender: PushSender | undefined, row: OutboxEvent = outbox) => worker.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantA}, true)`;
      return pushSendHandler(sender)(tenantDb, row);
    });

    expect(await run(fake)).toBe("delivered");
    expect(sent.map((entry) => entry.endpoint).sort()).toEqual([goneEndpoint, goodEndpoint].sort());
    expect(sent[0]!.message.title).toMatch(/^New booking at /);
    expect(sent[0]!.message.link).toMatch(/^\/schedule\?open=/);
    // The gone address was forgotten; the good one was kept and marked as working.
    const remaining = await owner<{ last_success_at: Date | null }[]>`select last_success_at from push_subscriptions where tenant_id = ${tenantA}`;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.last_success_at).not.toBeNull();

    // Push service down: nothing went out, so try again later.
    answers.set(goodEndpoint, "retry");
    expect(await run(fake)).toEqual({ outcome: "retry", code: "push_unavailable" });
    // No push keys on this server: the event just finishes; the bell still has the alert.
    expect(await run(undefined)).toBe("delivered");
    // A job that is not a push job goes to dead letter rather than looping.
    expect(await run(fake, { ...outbox, payload: { nonsense: true } })).toEqual({ outcome: "dead", code: "invalid_push" });
  });

  it("moves push addresses onto the business's new key when it is rotated, and they still open", async () => {
    const asOwner = context(tenantA, ownerMembership, "owner");
    const endpoint = endpointOf("rotate");
    await savePushSubscription(asOwner, { endpoint, keys });
    const [before] = await owner<{ key_version: number }[]>`select max(key_version) as key_version from push_subscriptions where tenant_id = ${tenantA}`;
    await worker.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantA}, true)`;
      await rotateTenantKey(tenantDb, tenantA, "admin");
    });
    let moved = 0;
    for (let round = 0; round < 3 && moved === 0; round += 1) {
      moved = await worker.begin(async (tenantDb) => {
        await tenantDb`select set_config('app.tenant_id', ${tenantA}, true)`;
        // Other suites may have left pictures behind; any object reads back as a small valid sealed file.
        const store = { get: async () => sealBytes(tenantA, Buffer.from("x")), replace: async () => undefined } as unknown as FileStore;
        return reEncryptTenant(tenantDb, tenantA, { store });
      }) as number;
    }
    expect(moved).toBeGreaterThan(0);
    const [after] = await owner<{ key_version: number }[]>`select min(key_version) as key_version from push_subscriptions where tenant_id = ${tenantA}`;
    expect(after!.key_version).toBeGreaterThan(before!.key_version);
    const opened: string[] = [];
    const sender: PushSender = { mode: "local_capture", async send(subscription) { opened.push(subscription.endpoint); return "sent"; } };
    await worker.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantA}, true)`;
      await pushSendHandler(sender)(tenantDb, {
        id: randomUUID(), tenantId: tenantA, aggregateType: "push", aggregateId: ownerMembership, eventType: "push.send",
        payload: { membershipId: ownerMembership, title: "Test", kind: "payment" }, dedupeKey: randomUUID(), attemptCount: 0,
      });
    });
    expect(opened).toContain(endpoint);
  });

  it("a push address is not shared between businesses", async () => {
    const rows = await owner<{ n: string }[]>`select count(*)::text as n from push_subscriptions where tenant_id = ${tenantB}`;
    expect(rows[0]!.n).toBe("0");
  });
});
