/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolvePermissions, type StaffRole } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

vi.mock("server-only", () => ({}));

import { createAppointment, listAvailability } from "@/server/appointment-repository";
import { listUndeliveredMessages, retryUndeliveredMessage } from "@/server/message-retry";

import { localCaptureSink } from "./delivery";
import { createHandlers, type EventHandler, type HandlerRegistry } from "./handlers";
import { applyRetention, outboxHealth, sweepReminders } from "./jobs";
import {
  claimOutboxBatch,
  MAX_ATTEMPTS,
  processClaimedEvent,
  releaseClaims,
  runOutboxBatch,
  type ClaimedEvent,
} from "./outbox-worker";
import { retryDelayMs } from "./policy";
import { JOBS_SCHEMA, startScheduler, TIMED_JOBS } from "./schedules";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const isLocal = (url: string | undefined) => {
  if (!url) return false;
  const parsed = new URL(url);
  // nira_local: a local cluster made before the rename (see scripts/local-db.sh).
  return parsed.hostname === "127.0.0.1" && ["5544", "5545"].includes(parsed.port) && ["/kalendr_local", "/nira_local"].includes(parsed.pathname);
};
const describeLocal = isLocal(runtimeUrl) && isLocal(ownerUrl) && isLocal(workerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

/** Event types only these tests use. They are never queued by the app. */
const COUNTED = "test.worker.counted";
const FAILING = "test.worker.failing";

describeLocal("production outbox worker", () => {
  let owner: postgres.Sql;
  let workerA: postgres.Sql;
  let workerB: postgres.Sql;
  let runtime: postgres.Sql;
  const suffix = randomUUID().slice(0, 8);
  let tenantId = "";
  let otherTenantId = "";
  let appointmentId = "";
  let patientId = "";
  const calls = new Map<string, number>();

  const counted: EventHandler = async (_tenantDb, event) => {
    calls.set(event.id, (calls.get(event.id) ?? 0) + 1);
    // Long enough that both workers are inside a batch at the same time.
    await new Promise((resolve) => setTimeout(resolve, 15));
    return "delivered";
  };
  const failing: EventHandler = async () => ({ outcome: "retry", code: "test_failure" });
  const handlers: HandlerRegistry = new Map([
    ...createHandlers({ sink: localCaptureSink, now: () => new Date() }),
    [COUNTED, counted],
    [FAILING, failing],
  ]);

  const staff = (role: StaffRole, tenant = tenantId): StaffContext => ({
    tenantId: tenant,
    clinicSlug: "lotus-dental",
    clinicName: "Lotus Dental Studio",
    role,
    permissions: resolvePermissions(role, {}),
    membershipId: null,
    userId: null,
    userName: "Test",
    userEmail: "test@example.com",
    preview: false,
  });

  /** Queues test rows as the owner. `old` puts them first in claim order. */
  async function queue(eventType: string, count: number, old = true): Promise<string[]> {
    const rows = await owner<{ id: string }[]>`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, available_at)
      select ${tenantId}, 'test', ${appointmentId}, ${eventType}, '{}'::jsonb,
        ${`test:${suffix}:${eventType}:`} || gen_random_uuid()::text,
        case when ${old}::boolean then timestamptz '2000-01-01' else now() end
      from generate_series(1, ${count})
      returning id
    `;
    return rows.map((row) => row.id);
  }

  async function statusOf(ids: readonly string[]) {
    return owner<{ id: string; status: string; attempt_count: number; last_error_code: string | null; delay_ms: number; locked_by: string | null }[]>`
      select id, status::text, attempt_count, last_error_code, locked_by,
        round(extract(epoch from available_at - updated_at) * 1000)::float8 as delay_ms
      from outbox_events where id in ${owner(ids as string[])}
    `;
  }

  /** Runs worker batches until every given row has left pending/processing, or the deadline passes. */
  async function drain(database: postgres.Sql, workerId: string, ids: readonly string[], handled?: Set<string>) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await runOutboxBatch(database, { workerId, batchSize: 20, concurrency: 4, handlers, onResult: (claim) => handled?.add(claim.id) });
      const rows = await statusOf(ids);
      if (rows.every((row) => row.status !== "pending" && row.status !== "processing")) return rows;
    }
    throw new Error("Worker did not finish in time");
  }

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 1, prepare: false, onnotice: () => undefined });
    workerA = postgres(workerUrl!, { max: 4, prepare: false, onnotice: () => undefined });
    workerB = postgres(workerUrl!, { max: 4, prepare: false, onnotice: () => undefined });
    runtime = postgres(runtimeUrl!, { max: 1, prepare: false, onnotice: () => undefined });
    const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    const [other] = await owner<{ id: string }[]>`select id from tenants where slug <> 'lotus-dental' order by slug limit 1`;
    tenantId = tenant!.id;
    otherTenantId = other!.id;
    const [link] = await owner<{ location_id: string; service_id: string; practitioner_id: string }[]>`
      select location.location_id, service.service_id, service.practitioner_id
      from practitioner_services as service
      join practitioner_locations as location
        on location.tenant_id = service.tenant_id and location.practitioner_id = service.practitioner_id
      where service.tenant_id = ${tenantId} limit 1
    `;
    const day = 24 * 60 * 60 * 1_000;
    const slots = await listAvailability({
      clinicSlug: "lotus-dental",
      locationId: link!.location_id,
      serviceId: link!.service_id,
      practitionerId: link!.practitioner_id,
      from: new Date(Date.now() + 30 * day).toISOString(),
      to: new Date(Date.now() + 37 * day).toISOString(),
    });
    const slot = slots.at(-2);
    if (!slot) throw new Error("Expected an open slot");
    const created = await createAppointment({
      clinicSlug: "lotus-dental",
      patientType: "new",
      bookingFor: "self",
      locationId: link!.location_id,
      serviceId: link!.service_id,
      practitionerId: link!.practitioner_id,
      slotId: randomUUID(),
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      firstName: "Worker",
      lastName: "Test",
      phone: `+91 91${String(Date.now()).slice(-8)}`,
      email: `worker-${suffix}@example.com`,
      preferredChannel: "email",
      acceptedPrivacyNotice: true,
      messagingConsent: false,
    }, randomUUID(), randomUUID().replaceAll("-", ""));
    appointmentId = created.appointmentId;
    const [row] = await owner<{ patient_id: string }[]>`select patient_id from appointments where id = ${appointmentId}`;
    patientId = row!.patient_id;
  });

  afterAll(async () => {
    await owner.begin(async (transaction) => {
      await transaction`delete from outbox_events where tenant_id = ${tenantId} and (aggregate_id = ${appointmentId} or dedupe_key like ${`test:${suffix}:%`})`;
      await transaction`delete from notifications where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`;
      await transaction`delete from audit_events where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`;
      await transaction`delete from audit_events where tenant_id = ${tenantId} and action = 'message.retry' and occurred_at > now() - interval '10 minutes'`;
      await transaction`delete from appointments where id = ${appointmentId}`;
      await transaction`delete from idempotency_keys where tenant_id = ${tenantId} and created_at > now() - interval '10 minutes'`;
      await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id = ${patientId})`;
      await transaction`delete from patients where id = ${patientId}`;
    }).catch((error: unknown) => {
      console.error("worker test cleanup failed", error);
    });
    await Promise.all([owner.end(), workerA.end(), workerB.end(), runtime.end()]);
  });

  it("runs as a role without BYPASSRLS that sees no tenant rows until it picks a business", async () => {
    const [role] = await workerA<{ rolbypassrls: boolean; rolsuper: boolean }[]>`
      select rolbypassrls, rolsuper from pg_roles where rolname = current_user
    `;
    expect(role).toEqual({ rolbypassrls: false, rolsuper: false });
    const [unscoped] = await workerA<{ count: number }[]>`select count(*)::integer as count from appointments`;
    expect(unscoped!.count).toBe(0);
    const foreign = await workerA.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${otherTenantId}, true)`;
      return transaction<{ count: number }[]>`select count(*)::integer as count from appointments where id = ${appointmentId}`;
    });
    expect(foreign[0]!.count).toBe(0);
  });

  it("keeps the cross-business functions away from the web app's role", async () => {
    await expect(runtime`select * from kalendr_claim_outbox('intruder', 1)`).rejects.toMatchObject({ code: "42501" });
    await expect(runtime`select * from kalendr_outbox_health()`).rejects.toMatchObject({ code: "42501" });
    await expect(runtime`select * from kalendr_worker_tenants('retention')`).rejects.toMatchObject({ code: "42501" });
    const health = await outboxHealth(workerA);
    expect(Object.keys(health).sort()).toEqual(["deadLetters", "oldestPendingSeconds", "pending", "tenantsWithDeadLetters"]);
  });

  it("delivers a booking confirmation exactly once when two workers race for it", async () => {
    const [queued] = await owner<{ id: string }[]>`
      update outbox_events set available_at = timestamptz '2000-01-01'
      where tenant_id = ${tenantId} and aggregate_id = ${appointmentId} and event_type = 'appointment.created'
      returning id
    `;
    expect(queued).toBeDefined();
    const ids = [queued!.id, ...await queue(COUNTED, 40)];
    calls.clear();
    const byA = new Set<string>();
    const byB = new Set<string>();
    await Promise.all([drain(workerA, `test-a-${suffix}`, ids, byA), drain(workerB, `test-b-${suffix}`, ids, byB)]);
    // Both workers did part of the work, and no row was finished by both.
    expect(ids.filter((id) => byA.has(id)).length).toBeGreaterThan(0);
    expect(ids.filter((id) => byB.has(id)).length).toBeGreaterThan(0);
    expect(ids.filter((id) => byA.has(id) && byB.has(id))).toEqual([]);
    const rows = await statusOf(ids);
    expect(rows.every((row) => row.status === "delivered")).toBe(true);
    for (const id of ids.slice(1)) expect(calls.get(id)).toBe(1);
    const notifications = await owner<{ count: number }[]>`
      select count(*)::integer as count from notifications
      where tenant_id = ${tenantId} and appointment_id = ${appointmentId} and template_key = 'appointment.created'
    `;
    expect(notifications[0]!.count).toBe(1);
  });

  it("retries a failing handler at 5, 10 and 20 seconds and dead-letters it after eight attempts", async () => {
    const [id] = await queue(FAILING, 1);
    const delays: number[] = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const claims = await claimOutboxBatch(workerA, `test-retry-${suffix}`, 100);
      const mine = claims.find((claim) => claim.id === id);
      expect(mine, `attempt ${attempt} claimed the row`).toBeDefined();
      await releaseOthers(claims, id!);
      const result = await processClaimedEvent(workerA, mine!, { handlers });
      const [row] = await statusOf([id!]);
      expect(row!.attempt_count).toBe(attempt);
      if (attempt < MAX_ATTEMPTS) {
        expect(result.kind).toBe("retry");
        expect(row!.status).toBe("failed");
        expect(row!.last_error_code).toBe("test_failure");
        delays.push(row!.delay_ms);
        // Skip the wait: make the row due now, as if the delay had passed.
        await owner`update outbox_events set available_at = timestamptz '2000-01-01' where id = ${id!}`;
      } else {
        expect(result.kind).toBe("dead_letter");
        expect(row!.status).toBe("dead_letter");
      }
    }
    expect(delays.slice(0, 3)).toEqual([5_000, 10_000, 20_000]);
    expect(delays).toEqual(Array.from({ length: MAX_ATTEMPTS - 1 }, (_, index) => retryDelayMs(index + 1)));
    // A dead letter is never claimed again.
    const after = await claimOutboxBatch(workerA, `test-retry-${suffix}`, 100);
    expect(after.some((claim) => claim.id === id)).toBe(false);
    await releaseOthers(after, "");
  });

  it("releases a killed worker's rows once the 60-second lease runs out, and ignores the old holder", async () => {
    const [id] = await queue(COUNTED, 1);
    const killed = await claimOutboxBatch(workerA, `test-killed-${suffix}`, 100);
    const held = killed.find((claim) => claim.id === id)!;
    expect(held).toBeDefined();
    await releaseOthers(killed, id!);
    // The worker "dies" here: it never finishes or releases the row.
    const tooSoon = await claimOutboxBatch(workerB, `test-survivor-${suffix}`, 100);
    expect(tooSoon.some((claim) => claim.id === id)).toBe(false);
    await releaseOthers(tooSoon, "");
    await owner`update outbox_events set locked_at = now() - interval '59 seconds' where id = ${id!}`;
    const stillHeld = await claimOutboxBatch(workerB, `test-survivor-${suffix}`, 100);
    expect(stillHeld.some((claim) => claim.id === id)).toBe(false);
    await releaseOthers(stillHeld, "");
    await owner`update outbox_events set locked_at = now() - interval '61 seconds' where id = ${id!}`;
    const reclaimed = await claimOutboxBatch(workerB, `test-survivor-${suffix}`, 100);
    const mine = reclaimed.find((claim) => claim.id === id);
    expect(mine).toBeDefined();
    await releaseOthers(reclaimed, id!);
    // The dead worker's late write is refused because its lease token no longer matches.
    expect(await processClaimedEvent(workerA, held, { handlers })).toEqual({ kind: "lease_lost" });
    expect(await processClaimedEvent(workerB, mine!, { handlers })).toEqual({ kind: "delivered" });
    const [row] = await statusOf([id!]);
    expect(row).toMatchObject({ status: "delivered", attempt_count: 2 });
  });

  it("on shutdown hands back rows it claimed but did not start", async () => {
    const ids = await queue(COUNTED, 6);
    calls.clear();
    let started = 0;
    const claimed = await runOutboxBatch(workerA, {
      workerId: `test-stop-${suffix}`,
      batchSize: 100,
      concurrency: 1,
      handlers,
      shouldStop: () => started++ >= 2,
    });
    expect(claimed).toBeGreaterThanOrEqual(6);
    const rows = await statusOf(ids);
    expect(rows.filter((row) => row.status === "delivered").length).toBeLessThanOrEqual(2);
    expect(rows.every((row) => row.status === "delivered" || (row.status === "pending" && row.attempt_count === 0 && row.locked_by === null))).toBe(true);
    await drain(workerA, `test-stop-${suffix}`, ids);
  });

  it("drops a reminder for an appointment that moved, and sends the one for the new time", async () => {
    const [current] = await owner<{ version: number }[]>`select version from appointments where id = ${appointmentId}`;
    const version = current!.version;
    const queueReminder = async (forVersion: number) => {
      const [row] = await owner<{ id: string }[]>`
        insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, available_at)
        values (${tenantId}, 'appointment', ${appointmentId}, 'appointment.reminder',
          ${owner.json({ appointmentId, version: forVersion })},
          ${`appointment.reminder:${appointmentId}:${forVersion}`}, timestamptz '2000-01-01')
        returning id
      `;
      return row!.id;
    };
    const stale = await queueReminder(version);
    // The appointment moves: a new version, and the reminder is due again.
    await owner`update appointments set version = version + 1, reminder_status = 'queued' where id = ${appointmentId}`;
    const fresh = await queueReminder(version + 1);
    await drain(workerA, `test-reminder-${suffix}`, [stale, fresh]);
    const rows = await statusOf([stale, fresh]);
    expect(rows.every((row) => row.status === "delivered")).toBe(true);
    const reminders = await owner<{ count: number }[]>`
      select count(*)::integer as count from notifications
      where tenant_id = ${tenantId} and appointment_id = ${appointmentId} and template_key = 'appointment.reminder'
    `;
    expect(reminders[0]!.count).toBe(1);
    const [after] = await owner<{ reminder_status: string }[]>`select reminder_status::text from appointments where id = ${appointmentId}`;
    expect(after!.reminder_status).toBe("delivered");
  });

  it("runs the reminder sweep and retention through the worker's own role", async () => {
    const swept = await sweepReminders(workerA);
    expect(swept.rows).toBeGreaterThanOrEqual(0);
    const retention = await applyRetention(workerA);
    expect(retention.rows).toBeGreaterThanOrEqual(0);
  });

  it("lets staff with messages.retry try a dead letter again, once, with an audit row", async () => {
    const [id] = await queue(FAILING, 1, false);
    await owner`update outbox_events set status = 'dead_letter', attempt_count = 8, last_error_code = 'provider_not_configured', aggregate_type = 'appointment' where id = ${id!}`;

    await expect(listUndeliveredMessages(staff("receptionist"), "all")).rejects.toMatchObject({ status: 403 });
    await expect(retryUndeliveredMessage(staff("receptionist"), id!, { attemptCount: 8 }, randomUUID())).rejects.toMatchObject({ status: 403 });

    const listed = await listUndeliveredMessages(staff("admin"), "dead_letter");
    const mine = listed.find((message) => message.id === id);
    expect(mine).toMatchObject({ status: "dead_letter", attemptCount: 8, lastErrorCode: "provider_not_configured", appointmentId, patientId });
    // Another business cannot see or reset it.
    expect((await listUndeliveredMessages(staff("admin", otherTenantId), "all")).some((message) => message.id === id)).toBe(false);
    await expect(retryUndeliveredMessage(staff("admin", otherTenantId), id!, { attemptCount: 8 }, randomUUID())).rejects.toMatchObject({ status: 404 });
    // A stale screen cannot reset it.
    await expect(retryUndeliveredMessage(staff("admin"), id!, { attemptCount: 7 }, randomUUID())).rejects.toMatchObject({ status: 409 });

    const key = randomUUID();
    expect(await retryUndeliveredMessage(staff("admin"), id!, { attemptCount: 8 }, key)).toEqual({ id, status: "pending" });
    // The same click sent twice is answered from the idempotency key, not applied again.
    expect(await retryUndeliveredMessage(staff("admin"), id!, { attemptCount: 8 }, key)).toEqual({ id, status: "pending" });
    const [row] = await statusOf([id!]);
    expect(row).toMatchObject({ status: "pending", attempt_count: 0, last_error_code: null, locked_by: null });
    const audits = await owner<{ count: number }[]>`
      select count(*)::integer as count from audit_events
      where tenant_id = ${tenantId} and action = 'message.retry' and metadata->>'eventId' = ${id!}
    `;
    expect(audits[0]!.count).toBe(1);
    await owner`delete from outbox_events where id = ${id!}`;
  });

  it("installs the timed jobs in pg-boss's own schema with the worker's role", async () => {
    const errors: string[] = [];
    const scheduler = await startScheduler(workerUrl!, workerA, () => undefined, (job) => errors.push(job));
    try {
      // pg-boss made these tables as the worker role, so they belong to it, not to the migration owner.
      const schedules = await workerA<{ name: string; cron: string }[]>`
        select name, cron from ${workerA(JOBS_SCHEMA)}.schedule order by name
      `;
      expect(schedules).toEqual(expect.arrayContaining(TIMED_JOBS.map((job) => ({ name: job.name, cron: job.cron }))));
    } finally {
      await scheduler.stop();
    }
    expect(errors).toEqual([]);
  });

  /** A test claim takes every due row; hand back the ones it isn't about so they aren't held for 60 seconds. */
  async function releaseOthers(claims: readonly ClaimedEvent[], keep: string) {
    await releaseClaims(workerA, claims.filter((claim) => claim.id !== keep));
  }
});
