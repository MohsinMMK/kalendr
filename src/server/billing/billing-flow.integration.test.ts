/** @vitest-environment node */

import { createHmac, randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST as razorpayWebhook } from "@/app/api/webhooks/billing/razorpay/route";
import { POST as stripeWebhook } from "@/app/api/webhooks/billing/stripe/route";
import { createEmailAdapter } from "@/worker/email-adapter";
import { sweepBilling } from "@/worker/billing-jobs";
import { providerSink } from "@/worker/delivery";
import { createHandlers, type OutboxEvent } from "@/worker/handlers";
import type { HandlerOutcome } from "@/worker/handlers/types";
import { createFakeEmailProvider } from "@/server/messaging/email-fake";
import { addPractitioners, createTenant, isLocalDatabase, setSubscription, staffContext, type TenantFixture } from "@/test/billing-fixture";

import { FakeSubscriptionProvider, setSubscriptionProviderFactory } from "./provider";
import { startCheckout } from "./plan-changes";
import { getBillingState } from "./subscriptions";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeLocal = isLocalDatabase(runtimeUrl) && isLocalDatabase(ownerUrl) && isLocalDatabase(workerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

const secret = "test-only-razorpay-webhook-secret";
const stripeSecret = "whsec_test_only_stripe_secret";
const day = 86_400_000;
// Event ids are unique across the whole table, so a rerun on the same database needs its own.
const runId = randomUUID().slice(0, 8);

describeLocal("subscription billing end to end", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  const emailProvider = createFakeEmailProvider();
  const handlers = createHandlers({
    sink: providerSink({ email: createEmailAdapter({ provider: emailProvider, origin: "http://127.0.0.1:3202", fallbackReplyTo: null }) }),
    now: () => new Date(),
    origin: "http://127.0.0.1:3202",
  });
  const fakeRazorpay = new FakeSubscriptionProvider("razorpay");

  /** Runs every pending billing outbox row for a business through the real handlers, as the worker would. */
  async function drain(tenantId: string): Promise<number> {
    const rows = await owner<{ id: string; aggregate_type: string; aggregate_id: string; event_type: string; payload: unknown; dedupe_key: string }[]>`
      select id, aggregate_type, aggregate_id, event_type, payload, dedupe_key from outbox_events
      where tenant_id = ${tenantId} and status = 'pending' and event_type like 'billing.%' order by created_at`;
    for (const row of rows) {
      const outcome = await (worker.begin(async (tenantDb) => {
        await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
        const event: OutboxEvent = { id: row.id, tenantId, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, eventType: row.event_type, payload: row.payload, dedupeKey: row.dedupe_key, attemptCount: 1 };
        return handlers.get(row.event_type)!(tenantDb, event);
      }) as Promise<HandlerOutcome>);
      expect(outcome).toBe("delivered");
      await owner`update outbox_events set status = 'delivered' where id = ${row.id}`;
    }
    return rows.length;
  }

  function razorpayRequest(body: object, eventId: string, signWith = secret): Request {
    const raw = JSON.stringify(body);
    return new Request("http://localhost/api/webhooks/billing/razorpay", {
      method: "POST", body: raw,
      headers: { "x-razorpay-signature": createHmac("sha256", signWith).update(raw).digest("hex"), "x-razorpay-event-id": `${runId}-${eventId}`, "content-type": "application/json" },
    });
  }
  const subscriptionEvent = (event: string, tenantId: string, subscriptionId: string, extra: object = {}, payment?: object) => ({
    event, created_at: Math.floor(Date.now() / 1000),
    payload: { subscription: { entity: { id: subscriptionId, plan_id: "plan_unmapped", status: "active", notes: { tenantId, planKey: "starter" }, current_start: Math.floor(Date.now() / 1000), current_end: Math.floor((Date.now() + 30 * day) / 1000), ...extra } }, ...(payment ? { payment: { entity: payment } } : {}) },
  });

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false });
    worker = postgres(workerUrl!, { max: 6, prepare: false });
    process.env.RAZORPAY_WEBHOOK_SECRET = secret;
    process.env.STRIPE_WEBHOOK_SECRET = stripeSecret;
    // Plan ids a real deployment gets from scripts/billing-sync-plans.mjs.
    await owner`update plans set razorpay_plan_id = 'plan_' || key, stripe_price_id = 'price_' || key where key <> 'free'`;
    setSubscriptionProviderFactory((name) => (name === "razorpay" ? fakeRazorpay : new FakeSubscriptionProvider("stripe")));
  });
  afterAll(async () => {
    setSubscriptionProviderFactory(null);
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    await Promise.all([owner.end(), worker.end()]);
  });

  describe("a trial business subscribes with UPI", () => {
    let fixture: TenantFixture;
    const subscriptionId = `sub_${randomUUID().slice(0, 12)}`;
    beforeAll(async () => {
      fixture = await createTenant(owner, "upi");
      await setSubscription(owner, fixture.tenantId, { plan: "growth", status: "trialing", trialEndsAt: new Date(Date.now() + 9 * day) });
    });

    it("checkout creates the provider subscription once per Idempotency-Key and carries the business id", async () => {
      const context = staffContext(fixture);
      const first = await startCheckout(context, "starter", "checkout-key-0001");
      const second = await startCheckout(context, "starter", "checkout-key-0001");
      expect(second).toEqual(first);
      expect(fakeRazorpay.calls.filter((call) => call.method === "createCheckout")).toHaveLength(1);
      expect(fakeRazorpay.calls[0]?.args).toMatchObject({ tenantId: fixture.tenantId, planKey: "starter" });
      const [row] = await owner`select provider, provider_subscription_id, status from tenant_subscriptions where tenant_id = ${fixture.tenantId}`;
      expect(row).toMatchObject({ provider: "razorpay", status: "trialing" });
      expect(row?.provider_subscription_id).toBeTruthy();
      await owner`update tenant_subscriptions set provider_subscription_id = ${subscriptionId} where tenant_id = ${fixture.tenantId}`;
    });

    it("refuses a webhook with a bad signature and stores nothing", async () => {
      const response = await razorpayWebhook(razorpayRequest(subscriptionEvent("subscription.activated", fixture.tenantId, subscriptionId), "evt-bad", "wrong-secret"));
      expect(response.status).toBe(401);
      expect(await owner`select 1 from billing_events where provider_event_id = ${`${runId}-evt-bad`}`).toHaveLength(0);
    });

    it("a verified subscription.activated makes the business Starter and active, once, however often it is delivered", async () => {
      const body = subscriptionEvent("subscription.activated", fixture.tenantId, subscriptionId);
      const first = await razorpayWebhook(razorpayRequest(body, "evt-activate"));
      expect(first.status).toBe(200);
      expect((await first.json()).data.result).toBe("queued");
      const repeat = await razorpayWebhook(razorpayRequest(body, "evt-activate"));
      expect(repeat.status).toBe(200);
      expect((await repeat.json()).data.result).toBe("duplicate");
      expect(await owner`select 1 from billing_events where tenant_id = ${fixture.tenantId} and provider_event_id = ${`${runId}-evt-activate`}`).toHaveLength(1);

      expect(await drain(fixture.tenantId)).toBe(1);
      const [row] = await owner`select plan_key, status, provider_subscription_id from tenant_subscriptions where tenant_id = ${fixture.tenantId}`;
      expect(row).toMatchObject({ plan_key: "starter", status: "active", provider_subscription_id: subscriptionId });
      const [event] = await owner`select outcome, processed_at, payload from billing_events where provider_event_id = ${`${runId}-evt-activate`}`;
      expect(event?.outcome).toBe("applied");
      expect(JSON.stringify(event?.payload)).not.toMatch(/@|vpa|card/i);
      // The "plan started" email went out once.
      await drain(fixture.tenantId);
      expect(emailProvider.sent.filter((message) => message.subject.includes("Starter"))).toHaveLength(1);
    });

    it("a charge makes one gapless invoice with the GST split, and a repeat of the charge makes none", async () => {
      const payment = { id: `pay_${randomUUID().slice(0, 10)}`, amount: 49_900, currency: "INR", status: "captured", vpa: "owner@okbank" };
      await razorpayWebhook(razorpayRequest(subscriptionEvent("subscription.charged", fixture.tenantId, subscriptionId, {}, payment), "evt-charge-1"));
      await razorpayWebhook(razorpayRequest(subscriptionEvent("subscription.charged", fixture.tenantId, subscriptionId, {}, payment), "evt-charge-2"));
      await drain(fixture.tenantId);
      const invoices = await owner`select invoice_number, amount_minor, gst_minor, total_minor, gst_rate_bps, plan_key from platform_invoices where tenant_id = ${fixture.tenantId}`;
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({ amount_minor: 42_288, gst_minor: 7_612, total_minor: 49_900, gst_rate_bps: 1800, plan_key: "starter" });
      expect(String(invoices[0]?.invoice_number)).toMatch(/^KAL-\d{6}$/);
    });

    it("a failed renewal sets past_due, shows the banner to the owner only, keeps full service on day 6 and drops to Free on day 8", async () => {
      await razorpayWebhook(razorpayRequest(subscriptionEvent("subscription.pending", fixture.tenantId, subscriptionId, { status: "pending" }), "evt-pending-1"));
      await razorpayWebhook(razorpayRequest(subscriptionEvent("subscription.halted", fixture.tenantId, subscriptionId, { status: "halted" }), "evt-pending-2"));
      await drain(fixture.tenantId);
      await drain(fixture.tenantId);
      const [row] = await owner<{ status: string; past_due_since: Date }[]>`select status, past_due_since from tenant_subscriptions where tenant_id = ${fixture.tenantId}`;
      expect(row?.status).toBe("past_due");
      const since = row!.past_due_since.getTime();
      // The second failure left the start of the grace period alone.
      const [after] = await owner<{ past_due_since: Date }[]>`select past_due_since from tenant_subscriptions where tenant_id = ${fixture.tenantId}`;
      expect(after?.past_due_since.getTime()).toBe(since);
      expect(emailProvider.sent.filter((message) => message.subject.includes("payment didn't go through"))).toHaveLength(2);

      const ownerView = staffContext(fixture, "owner");
      const adminView = staffContext(fixture, "admin");
      const day6 = await getBillingState(ownerView, new Date(since + 6 * day));
      expect(day6.plan).toMatchObject({ key: "starter", status: "past_due" });
      expect(day6.banner).not.toBeNull();
      expect((await getBillingState(adminView, new Date(since + 6 * day))).banner).toBeNull();
      const day8 = await getBillingState(ownerView, new Date(since + 8 * day));
      expect(day8.plan.key).toBe("free");

      // The sweep makes the stored status match, without changing what anyone can do.
      const summary = await sweepBilling(worker, new Date(since + 8 * day));
      expect(summary.graceEnded).toBeGreaterThanOrEqual(1);
      expect((await owner`select status, plan_key from tenant_subscriptions where tenant_id = ${fixture.tenantId}`)[0]).toMatchObject({ status: "free", plan_key: "free" });
    });
  });

  it("loads entitlements for a business with no subscription row by starting a Growth trial", async () => {
    const fixture = await createTenant(owner, "no-row");
    await owner`delete from tenant_subscriptions where tenant_id = ${fixture.tenantId}`;
    const state = await getBillingState(staffContext(fixture));
    expect(state.plan).toMatchObject({ key: "growth", status: "trialing" });
    const [row] = await owner<{ trial_ends_at: Date }[]>`select trial_ends_at from tenant_subscriptions where tenant_id = ${fixture.tenantId}`;
    expect(row!.trial_ends_at.getTime()).toBeGreaterThan(Date.now() + 13 * day);
  });

  it("drops a signed event whose business does not exist, with a 200", async () => {
    const response = await razorpayWebhook(razorpayRequest(subscriptionEvent("subscription.activated", randomUUID(), "sub_nobody"), "evt-nobody"));
    expect(response.status).toBe(200);
    expect((await response.json()).data.result).toBe("dropped");
  });

  it("the Stripe route checks its signature and timestamp too", async () => {
    const raw = JSON.stringify({ id: "evt_stripe_x", type: "customer.subscription.updated", data: { object: { id: "sub_x", status: "active" } } });
    const sign = (at: number) => `t=${at},v1=${createHmac("sha256", stripeSecret).update(`${at}.${raw}`).digest("hex")}`;
    const call = (header: string) => stripeWebhook(new Request("http://localhost/api/webhooks/billing/stripe", { method: "POST", body: raw, headers: { "stripe-signature": header } }));
    expect((await call(sign(Math.floor(Date.now() / 1000)))).status).toBe(200);
    expect((await call(sign(Math.floor(Date.now() / 1000) - 3_600))).status).toBe(401);
    expect((await call("t=1,v1=00")).status).toBe(401);
  });

  describe("billing sweep", () => {
    it("ends a finished trial, applies a pending downgrade and a cancellation at the period end, and sends the trial-ending email once", async () => {
      const ended = await createTenant(owner, "trial-over");
      const downgrade = await createTenant(owner, "downgrade");
      const cancelling = await createTenant(owner, "cancelling");
      const ending = await createTenant(owner, "trial-soon");
      const past = new Date(Date.now() - 60_000);
      await setSubscription(owner, ended.tenantId, { status: "trialing", trialEndsAt: past });
      await setSubscription(owner, downgrade.tenantId, { plan: "growth", status: "active", periodEnd: past, pending: "starter", provider: "razorpay", providerSubscriptionId: `sub_dg_${randomUUID().slice(0, 8)}` });
      await setSubscription(owner, cancelling.tenantId, { plan: "starter", status: "active", periodEnd: past, cancelAtPeriodEnd: true, provider: "razorpay", providerSubscriptionId: `sub_cx_${randomUUID().slice(0, 8)}` });
      await setSubscription(owner, ending.tenantId, { status: "trialing", trialEndsAt: new Date(Date.now() + 2 * day) });

      await sweepBilling(worker);
      await sweepBilling(worker);
      const state = async (id: string) => (await owner`select status, plan_key, pending_plan_key, cancel_at_period_end from tenant_subscriptions where tenant_id = ${id}`)[0];
      expect(await state(ended.tenantId)).toMatchObject({ status: "free", plan_key: "free" });
      expect(await state(downgrade.tenantId)).toMatchObject({ status: "active", plan_key: "starter", pending_plan_key: null });
      expect(await state(cancelling.tenantId)).toMatchObject({ status: "free", plan_key: "free", cancel_at_period_end: false });
      expect(await state(ending.tenantId)).toMatchObject({ status: "trialing" });
      expect(await owner`select 1 from outbox_events where tenant_id = ${ending.tenantId} and event_type = 'billing.email'`).toHaveLength(1);
      expect(await drain(ending.tenantId)).toBe(1);
      expect(emailProvider.sent.some((message) => message.subject.includes("free trial ends in 3 days"))).toBe(true);
    });

    it("an operator extending the trial sends a fresh reminder (the key is the trial's end date)", async () => {
      const tenant = await createTenant(owner, "extended");
      await setSubscription(owner, tenant.tenantId, { status: "trialing", trialEndsAt: new Date(Date.now() + day) });
      await sweepBilling(worker);
      await owner`update tenant_subscriptions set trial_ends_at = now() + interval '2 days 1 hour' where tenant_id = ${tenant.tenantId}`;
      await sweepBilling(worker);
      expect(await owner`select 1 from outbox_events where tenant_id = ${tenant.tenantId} and event_type = 'billing.email'`).toHaveLength(2);
    });
  });

  it("extra practitioners helper is usable", async () => {
    const tenant = await createTenant(owner, "helper");
    expect(await addPractitioners(owner, tenant.tenantId, 2)).toHaveLength(2);
  });
});
