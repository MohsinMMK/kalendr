/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { isolatedDatabaseReady } from "@/test/isolated-database";
import { createCustomer, createTenant, type TenantFixture } from "@/test/privacy-fixture";
import { staffContext } from "@/test/billing-fixture";

vi.mock("server-only", () => ({}));

import { withTenant } from "@/db/client";
import { getRatingState, saveRating } from "@/server/ratings";
import { ensureRatingLink } from "@/server/rating-requests";
import { listAppointmentRatings, listPublicReviews, loadRatingSummariesIn } from "@/server/reviews";
import { runReport } from "@/server/reports/service";
import { planAppointment } from "@/server/workflows/engine";
import { postgresRunner } from "@/server/workflows/runner";
import { workflowMessageHandler } from "@/worker/handlers/workflow-message";
import type { MessageSink } from "@/worker/delivery";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const describeDb = isolatedDatabaseReady(runtimeUrl, ownerUrl) ? describe : describe.skip;

const DAY = 86_400_000;

describeDb("ratings and feedback (feature 51)", () => {
  let owner: postgres.Sql;
  let a: TenantFixture;
  let b: TenantFixture;

  const visit = async (fixture: TenantFixture, patientId: string, options: { status?: string; endedAgoMs?: number } = {}): Promise<string> => {
    const endsAt = new Date(Date.now() - (options.endedAgoMs ?? 3 * 3_600_000));
    const [row] = await owner<{ id: string }[]>`
      insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash, price_minor, completed_at)
      values (${fixture.tenantId}, ${fixture.locationId}, ${patientId}, ${fixture.practitionerId}, ${fixture.serviceId}, ${new Date(endsAt.getTime() - 1_800_000)}, ${endsAt},
        ${options.status ?? "completed"}, 'staff', ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")}, 50000, ${endsAt})
      returning id`;
    return row!.id;
  };
  const ask = (fixture: TenantFixture, appointmentId: string, now = new Date()) => owner.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${fixture.tenantId}, true)`;
    return ensureRatingLink(postgresRunner(tx), { tenantId: fixture.tenantId, appointmentId, now });
  });
  const tokenOf = (result: Awaited<ReturnType<typeof ask>>): string => {
    if (!result.ok) throw new Error(`Expected a link, got ${result.reason}`);
    return result.token;
  };

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false });
    a = await createTenant(owner, "rating-a");
    b = await createTenant(owner, "rating-b");
    const userId = randomUUID();
    await owner`insert into auth_users (id, name, email, email_verified) values (${userId}, 'Manager', ${`manager-${userId}@example.com`}, true)`;
    await owner`insert into memberships (tenant_id, user_id, role) values (${a.tenantId}, ${userId}, 'owner')`;
  }, 30_000);
  afterAll(async () => { await owner?.end(); });

  it("makes one link per visit, the same one on a retry, and never for a no-show or cancellation", async () => {
    const patient = (await createCustomer(owner, a.tenantId)).id;
    const done = await visit(a, patient);
    const first = tokenOf(await ask(a, done));
    expect(first.length).toBeGreaterThanOrEqual(43); // 256 bits, base64url
    expect(tokenOf(await ask(a, done))).toBe(first);
    const [stored] = await owner<{ token_hash: string; token_ciphertext: string }[]>`select token_hash, token_ciphertext from rating_requests where appointment_id = ${done}`;
    expect(stored!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored!.token_hash).not.toContain(first);
    expect(stored!.token_ciphertext).not.toContain(first);

    const other = (await createCustomer(owner, a.tenantId)).id;
    expect(await ask(a, await visit(a, other, { status: "no_show" }))).toEqual({ ok: false, reason: "not_finished" });
    expect(await ask(a, await visit(a, other, { status: "cancelled" }))).toEqual({ ok: false, reason: "not_finished" });
  });

  it("asks a customer at most once a month", async () => {
    const patient = (await createCustomer(owner, a.tenantId)).id;
    expect((await ask(a, await visit(a, patient))).ok).toBe(true);
    expect(await ask(a, await visit(a, patient))).toEqual({ ok: false, reason: "asked_recently" });
    // 31 days on, the next visit is asked about.
    expect((await ask(a, await visit(a, patient), new Date(Date.now() + 31 * DAY))).ok).toBe(true);
  });

  it("records 4 stars in one tap, shows it on the appointment and the business page", async () => {
    const patient = (await createCustomer(owner, a.tenantId, { firstName: "Asha", lastName: "Rao" })).id;
    const appointmentId = await visit(a, patient);
    const token = tokenOf(await ask(a, appointmentId));
    expect((await getRatingState(token)).phase).toBe("open");
    const state = await saveRating(token, { rating: 4 });
    expect(state.review).toMatchObject({ rating: 4, visibility: "public" });
    const [review] = await owner<{ source: string; visibility: string }[]>`select source, visibility from reviews where appointment_id = ${appointmentId}`;
    expect(review).toEqual({ source: "rating_link", visibility: "public" });
    const staff = staffContext(a, "owner");
    expect((await listAppointmentRatings(staff, { appointmentId }))[0]).toMatchObject({ rating: 4, source: "rating_link" });
    expect((await listPublicReviews(a.tenantId)).some((item) => item.displayName === "Asha R.")).toBe(true);
  });

  it("keeps a private 1-star review off the business page and alerts the manager", async () => {
    const patient = (await createCustomer(owner, a.tenantId, { firstName: "Grumpy", lastName: "Customer" })).id;
    const appointmentId = await visit(a, patient);
    const token = tokenOf(await ask(a, appointmentId));
    const state = await saveRating(token, { rating: 1 });
    expect(state.review?.visibility).toBe("private");
    await saveRating(token, { rating: 1, comment: "Waited an hour", visibility: "private" });

    const publicNow = await listPublicReviews(a.tenantId);
    expect(publicNow.some((item) => item.displayName === "Grumpy C.")).toBe(false);
    const summaries = await withTenant(a.tenantId, (tx) => loadRatingSummariesIn(tx, a.tenantId));
    expect(summaries.business.count).toBe(publicNow.length);
    const alerts = await owner<{ n: number }[]>`select count(*)::int as n from staff_notifications where tenant_id = ${a.tenantId} and kind = 'low_rating'`;
    expect(alerts[0]!.n).toBeGreaterThanOrEqual(1);
    const audits = await owner<{ metadata: Record<string, unknown> }[]>`select metadata from audit_events where appointment_id = ${appointmentId} and action = 'review.saved'`;
    expect(JSON.stringify(audits)).not.toContain("Waited an hour");
    // The customer may choose to share it.
    expect((await saveRating(token, { rating: 1, visibility: "public" })).review?.visibility).toBe("public");
    expect((await listPublicReviews(a.tenantId)).some((item) => item.displayName === "Grumpy C.")).toBe(true);
  });

  it("says thanks on reopening, lets the comment change for 7 days, and then closes", async () => {
    const patient = (await createCustomer(owner, a.tenantId)).id;
    const token = tokenOf(await ask(a, await visit(a, patient)));
    await saveRating(token, { rating: 5 });
    const reopened = await getRatingState(token);
    expect(reopened).toMatchObject({ phase: "answered", review: { rating: 5 } });
    expect((await saveRating(token, { comment: "Lovely" })).review).toMatchObject({ rating: 5, comment: "Lovely" });
    await expect(saveRating(token, { rating: 2 })).rejects.toMatchObject({ code: "rating_locked" });
    const later = new Date(Date.now() + 8 * DAY);
    expect((await getRatingState(token, later)).phase).toBe("closed");
    await expect(saveRating(token, { comment: "Changed my mind" }, later)).rejects.toMatchObject({ code: "rating_closed" });
  });

  it("expires with the review window and answers an unknown token with not found", async () => {
    const patient = (await createCustomer(owner, a.tenantId)).id;
    const token = tokenOf(await ask(a, await visit(a, patient)));
    expect((await getRatingState(token, new Date(Date.now() + 61 * DAY))).phase).toBe("expired");
    await expect(saveRating(token, { rating: 5 }, new Date(Date.now() + 61 * DAY))).rejects.toMatchObject({ code: "review_not_open" });
    await expect(getRatingState("x".repeat(43))).rejects.toMatchObject({ status: 404 });
  });

  it("keeps each business's requests to itself", async () => {
    const patient = (await createCustomer(owner, a.tenantId)).id;
    await ask(a, await visit(a, patient, { endedAgoMs: 5 * 3_600_000 }));
    const rows = await withTenant(b.tenantId, (tx) => tx.execute<{ n: number }>(`select count(*)::int as n from rating_requests` as never));
    expect(Number(Array.from(rows)[0]?.n)).toBe(0);
  });

  it("sends the rating message 2 hours after the visit ends, with the one-tap link, once a month", async () => {
    const t = await createTenant(owner, "rating-workflow");
    const patient = (await createCustomer(owner, t.tenantId)).id;
    const [workflow] = await owner<{ id: string }[]>`
      insert into workflows (tenant_id, name, trigger, offset_minutes, preset_key) values (${t.tenantId}, 'Ask for a review', 'after_end', 120, 'review_request') returning id`;
    const [step] = await owner<{ id: string }[]>`
      insert into workflow_steps (tenant_id, workflow_id, position, channel, subject, body, ignore_quiet_hours)
      values (${t.tenantId}, ${workflow!.id}, 0, 'email', 'How was your visit?', 'Hi {customer_first_name}, rate it: {rating_link}', true) returning id`;
    const appointmentId = await visit(t, patient, { endedAgoMs: 30 * 60_000 });
    const [visitRow] = await owner<{ ends_at: Date; version: number }[]>`select ends_at, version from appointments where id = ${appointmentId}`;

    await owner.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${t.tenantId}, true)`;
      await planAppointment(postgresRunner(tx), t.tenantId, appointmentId, { action: "appointment.status.completed", version: visitRow!.version }, new Date());
    });
    const [planned] = await owner<{ id: string; send_at: Date }[]>`select id, send_at from scheduled_messages where appointment_id = ${appointmentId} and step_id = ${step!.id}`;
    expect(planned!.send_at.getTime()).toBe(visitRow!.ends_at.getTime() + 2 * 3_600_000);

    const bodies: string[] = [];
    const sink: MessageSink = { mode: "local_capture", deliver: async (_tx, outgoing) => { bodies.push(outgoing.message.body); return "delivered"; } };
    const handler = workflowMessageHandler({ sink, now: () => new Date(visitRow!.ends_at.getTime() + 2 * 3_600_000), origin: "https://example.test" });
    const run = (messageId: string) => owner.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${t.tenantId}, true)`;
      await tx`update scheduled_messages set status = 'queued' where id = ${messageId}`;
      return handler(tx, { id: "e", tenantId: t.tenantId, aggregateType: "workflow", aggregateId: messageId, eventType: "workflow.message", payload: { scheduledMessageId: messageId }, dedupeKey: "k", attemptCount: 0 });
    });
    expect(await run(planned!.id)).toBe("delivered");
    expect(bodies[0]).toMatch(/rate it: https:\/\/example\.test\/r\/[A-Za-z0-9_-]{43}/);

    // A second finished visit a few days later is not asked about: the customer was asked this month.
    const second = await visit(t, patient, { endedAgoMs: 20 * 60_000 });
    const [secondMessage] = await owner<{ id: string }[]>`
      insert into scheduled_messages (tenant_id, appointment_id, workflow_id, step_id, slot_key, appointment_version, send_at, status)
      values (${t.tenantId}, ${second}, ${workflow!.id}, ${step!.id}, 't:1', 1, now(), 'queued') returning id`;
    await run(secondMessage!.id);
    expect(bodies).toHaveLength(1);
    const [skipped] = await owner<{ status: string; reason: string }[]>`select status, reason from scheduled_messages where id = ${secondMessage!.id}`;
    expect(skipped).toEqual({ status: "skipped", reason: "rating_asked_recently" });
  });

  it("shows each person's average and satisfaction for the month", async () => {
    const t = await createTenant(owner, "rating-report");
    const scores = [5, 4, 2];
    for (const score of scores) {
      const patient = (await createCustomer(owner, t.tenantId)).id;
      const token = tokenOf(await ask(t, await visit(t, patient)));
      await saveRating(token, { rating: score });
    }
    const today = new Date().toISOString().slice(0, 10);
    const result = await runReport(staffContext(t, "owner"), "satisfaction", { from: `${today.slice(0, 7)}-01`, to: today });
    const metric = (key: string) => result.metrics.find((item) => item.key === key)?.value;
    expect(metric("ratings")).toBe(3);
    expect(metric("average")).toBe(3.7);
    expect(metric("satisfaction")).toBeCloseTo(66.7, 1);
    expect(metric("low")).toBe(1);
    const person = result.tables.find((table) => table.key === "by_person")!.rows[0]!;
    expect(person).toMatchObject({ name: "Dr Test", total: 3, average: 3.7 });
  });
});
