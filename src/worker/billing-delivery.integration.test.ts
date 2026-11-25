/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createCustomer, createTenant, isLocalDatabase, setSubscription, type TenantFixture } from "@/test/billing-fixture";

import { providerSink, type DeliveryOutcome, type ProviderAdapter, type ProviderSendRequest, type ProviderSendResult } from "./delivery";
import { planGatedSink } from "./plan-gate";

const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeLocal = isLocalDatabase(ownerUrl) && isLocalDatabase(workerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

function recordingAdapter(result: (request: ProviderSendRequest) => ProviderSendResult) {
  const calls: ProviderSendRequest[] = [];
  const adapter: ProviderAdapter = { async send(request) { calls.push(request); return result(request); } };
  return { adapter, calls };
}

describeLocal("plan gate and message meter in the worker delivery path", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  beforeAll(() => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false });
    worker = postgres(workerUrl!, { max: 4, prepare: false });
  });
  afterAll(async () => { await Promise.all([owner.end(), worker.end()]); });

  const whatsappSent = (category = "utility") => recordingAdapter(() => ({ status: "sent", providerMessageId: `wamid.${randomUUID()}`, costCategory: category }));
  const emailSent = () => recordingAdapter(() => ({ status: "sent", providerMessageId: `email.${randomUUID()}` }));

  async function setup(plan: string, options: { email?: boolean; overage?: string } = {}) {
    const fixture = await createTenant(owner, `meter-${plan}`);
    await setSubscription(owner, fixture.tenantId, { plan, status: plan === "free" ? "free" : "active", provider: plan === "free" ? null : "razorpay", providerSubscriptionId: plan === "free" ? null : `sub_${randomUUID().slice(0, 8)}`, overage: options.overage });
    const customer = await createCustomer(owner, fixture.tenantId);
    if (options.email === false) await owner`update patients set email = '' where id = ${customer.id}`;
    return { fixture, customer };
  }

  function send(fixture: TenantFixture, customerId: string, sink: ReturnType<typeof planGatedSink>, key: string, templateKey = "appointment.reminder", channel: "whatsapp" | "sms" | "email" = "whatsapp"): Promise<DeliveryOutcome> {
    return worker.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${fixture.tenantId}, true)`;
      return sink.deliver(tx, {
        tenantId: fixture.tenantId, appointmentId: null, patientId: customerId, channel,
        message: { semanticKey: `local:${key}`, templateKey, body: "hello", scheduledAt: new Date() },
      }, new Date());
    }) as Promise<DeliveryOutcome>;
  }

  const counter = async (tenantId: string, metric: string) =>
    Number((await owner`select count from usage_counters where tenant_id = ${tenantId} and metric = ${metric} and period = date_trunc('month', now() at time zone 'utc')::date`)[0]?.count ?? 0);

  it("the message meter equals the number of WhatsApp messages sent, and a duplicate or a retry never double counts", async () => {
    const { fixture, customer } = await setup("starter");
    const whatsapp = whatsappSent();
    const sink = planGatedSink(providerSink({ whatsapp: whatsapp.adapter }));
    const N = 7;
    for (let index = 0; index < N; index += 1) expect(await send(fixture, customer.id, sink, `rem-${index}`)).toBe("delivered");
    expect(whatsapp.calls).toHaveLength(N);
    expect(await counter(fixture.tenantId, "message:whatsapp")).toBe(N);
    expect(await counter(fixture.tenantId, "message:whatsapp:utility")).toBe(N);

    // The same message delivered again (a duplicate outbox row) sends nothing and counts nothing.
    expect(await send(fixture, customer.id, sink, "rem-0")).toBe("duplicate");
    expect(whatsapp.calls).toHaveLength(N);
    expect(await counter(fixture.tenantId, "message:whatsapp")).toBe(N);

    // A provider that asks for a retry has not sent anything yet; the message counts once, when it finally goes.
    let attempts = 0;
    const flaky = recordingAdapter(() => (++attempts === 1 ? { status: "retry", code: "rate_limited" } : { status: "sent", providerMessageId: `wamid.${randomUUID()}` }));
    const flakySink = planGatedSink(providerSink({ whatsapp: flaky.adapter }));
    expect(await send(fixture, customer.id, flakySink, "flaky")).toEqual({ outcome: "retry", code: "rate_limited" });
    expect(await counter(fixture.tenantId, "message:whatsapp")).toBe(N);
    expect(await send(fixture, customer.id, flakySink, "flaky")).toBe("delivered");
    expect(await counter(fixture.tenantId, "message:whatsapp")).toBe(N + 1);
  });

  it("queues the 80% and 100% alerts once each", async () => {
    const { fixture, customer } = await setup("starter");
    await owner`insert into usage_counters (tenant_id, period, metric, count) values (${fixture.tenantId}, date_trunc('month', now() at time zone 'utc')::date, 'message:whatsapp', 158)`;
    const sink = planGatedSink(providerSink({ whatsapp: whatsappSent().adapter }));
    for (let index = 0; index < 5; index += 1) await send(fixture, customer.id, sink, `alert-${index}`); // 159 .. 163
    const alerts = async () => (await owner<{ payload: { threshold: number } }[]>`select payload from outbox_events where tenant_id = ${fixture.tenantId} and event_type = 'billing.email'`).map((row) => row.payload.threshold);
    expect(await alerts()).toEqual([80]);
    await owner`update usage_counters set count = 199 where tenant_id = ${fixture.tenantId} and metric = 'message:whatsapp'`;
    await send(fixture, customer.id, sink, "alert-full");
    await send(fixture, customer.id, sink, "alert-over");
    expect((await alerts()).sort()).toEqual([100, 80]);
  });

  it("Free: a reminder goes by email instead, a review request is stopped with plan_channel_locked, and nothing is silently lost", async () => {
    const { fixture, customer } = await setup("free");
    const whatsapp = whatsappSent();
    const email = emailSent();
    const sink = planGatedSink(providerSink({ whatsapp: whatsapp.adapter, email: email.adapter }));
    expect(await send(fixture, customer.id, sink, "free-rem")).toBe("delivered");
    expect(whatsapp.calls).toHaveLength(0);
    expect(email.calls).toHaveLength(1);
    expect((await owner`select channel::text from notifications where tenant_id = ${fixture.tenantId} and template_key = 'appointment.reminder'`)[0]?.channel).toBe("email");

    expect(await send(fixture, customer.id, sink, "free-review", "appointment.review_request")).toEqual({ outcome: "dead", code: "plan_channel_locked" });
    expect(whatsapp.calls).toHaveLength(0);
    expect((await owner`select status::text, failure_code from notifications where tenant_id = ${fixture.tenantId} and template_key = 'appointment.review_request'`)[0]).toMatchObject({ status: "failed", failure_code: "plan_channel_locked" });
    expect(await counter(fixture.tenantId, "message:whatsapp")).toBe(0);
  });

  it("Free with no email on file: the confirmation is still sent on WhatsApp, and a usage alert is logged", async () => {
    const { fixture, customer } = await setup("free", { email: false });
    const whatsapp = whatsappSent();
    const sink = planGatedSink(providerSink({ whatsapp: whatsapp.adapter, email: emailSent().adapter }));
    expect(await send(fixture, customer.id, sink, "no-email", "appointment.created")).toBe("delivered");
    expect(whatsapp.calls).toHaveLength(1);
    expect(await owner`select 1 from audit_events where tenant_id = ${fixture.tenantId} and action = 'billing.protected_message_sent_without_allowance'`).toHaveLength(1);
    expect(await counter(fixture.tenantId, "message:whatsapp")).toBe(1);
  });

  it("past the allowance, marketing stops for stop_marketing and is sent and counted for bill_overage; reminders always go", async () => {
    await owner`update message_templates set cost_category = 'marketing' where channel = 'whatsapp' and key = 'review_request'`;
    try {
      for (const overage of ["stop_marketing", "bill_overage"] as const) {
        const { fixture, customer } = await setup("starter", { overage });
        await owner`insert into usage_counters (tenant_id, period, metric, count) values (${fixture.tenantId}, date_trunc('month', now() at time zone 'utc')::date, 'message:whatsapp', 200)`;
        const whatsapp = whatsappSent("marketing");
        const sink = planGatedSink(providerSink({ whatsapp: whatsapp.adapter }));
        const outcome = await send(fixture, customer.id, sink, "mkt", "appointment.review_request");
        if (overage === "stop_marketing") {
          expect(outcome).toEqual({ outcome: "dead", code: "plan_overage_stopped" });
          expect(await counter(fixture.tenantId, "message:whatsapp")).toBe(200);
        } else {
          expect(outcome).toBe("delivered");
          expect(await counter(fixture.tenantId, "message:whatsapp")).toBe(201);
          expect(await counter(fixture.tenantId, "message:whatsapp:marketing")).toBe(1);
        }
        expect(await send(fixture, customer.id, sink, "still-rem")).toBe("delivered");
      }
    } finally {
      await owner`update message_templates set cost_category = 'utility' where channel = 'whatsapp' and key = 'review_request'`;
    }
  });
});
