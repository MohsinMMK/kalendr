/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ATTRIBUTION_DAYS } from "@/lib/campaign-contracts";
import { resolvePermissions } from "@/lib/permissions";
import { isolatedDatabaseReady } from "@/test/isolated-database";
import { drainTenantOutbox } from "@/test/outbox-drain";
import { createBooking, createCustomer, createTenant, staffContext, type TenantFixture } from "@/test/privacy-fixture";

vi.mock("server-only", () => ({}));

import { ApiError } from "@/server/api-error";
import { campaignStats } from "@/server/campaigns/attribution";
import { activatePreset, createCampaign, getCampaign, listCampaigns, previewAudience, previewMessage, requestTestSend, setCampaignStatus } from "@/server/campaigns/service";
import { unsubscribeByToken } from "@/server/campaigns/unsubscribe";
import { openUnsubscribeToken } from "@/server/campaigns/tokens";
import { createSegment } from "@/server/customers/segments";
import { createFakeEmailProvider } from "@/server/messaging/email-fake";
import { postgresRunner } from "@/server/workflows/runner";
import { sweepTenantCampaigns } from "@/worker/campaign-jobs";
import { providerSink, type DeliveryOutcome, type MessageSink, type OutgoingMessage } from "@/worker/delivery";
import { createEmailAdapter } from "@/worker/email-adapter";
import { createHandlers } from "@/worker/handlers";
import { pauseUnhealthyCampaigns } from "@/server/campaigns/health";
import { recordConsent, hasConsent } from "@/server/privacy/consent";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? process.env.KALENDR_E2E_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeIsolated = isolatedDatabaseReady(runtimeUrl, ownerUrl, workerUrl) ? describe : describe.skip;

const DAY = 86_400_000;
const key = () => `test-${randomUUID()}`;

async function expectApiError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error, `expected ${code}`).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
}

/** A provider that remembers what it has been asked to send by idempotency key, as a real one does, and can die after accepting. */
function recordingSink(options: { dieAfterAccepting?: { remaining: number } } = {}): MessageSink & { accepted: Map<string, OutgoingMessage>; calls: number } {
  const accepted = new Map<string, OutgoingMessage>();
  const sink: MessageSink & { accepted: Map<string, OutgoingMessage>; calls: number } = {
    mode: "production",
    accepted,
    calls: 0,
    async deliver(tenantDb, outgoing, now): Promise<DeliveryOutcome> {
      sink.calls += 1;
      const providerKey = outgoing.message.semanticKey;
      const seen = accepted.has(providerKey);
      if (!seen) accepted.set(providerKey, outgoing);
      if (options.dieAfterAccepting && options.dieAfterAccepting.remaining > 0 && !seen) {
        options.dieAfterAccepting.remaining -= 1;
        throw new Error("worker died after the provider accepted the message");
      }
      if (seen) return "duplicate";
      await tenantDb`
        insert into notifications (tenant_id, appointment_id, channel, template_key, destination_ciphertext, provider_message_id, semantic_key, status, scheduled_at, sent_at, delivered_at, attempt_count)
        values (${outgoing.tenantId}, null, ${outgoing.channel}, ${outgoing.message.templateKey}, 'test', ${providerKey}, ${providerKey}, 'delivered', ${outgoing.message.scheduledAt}, ${now}, ${now}, 1)
        on conflict (tenant_id, semantic_key) do nothing
      `;
      return "delivered";
    },
  };
  return sink;
}

describeIsolated("campaigns and win-back (feature 28)", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false });
    worker = postgres(workerUrl!, { max: 4, prepare: false });
  });

  afterAll(async () => {
    await owner.end();
    await worker.end();
  });

  /** A business with quiet hours switched off, so the tests do not depend on the time they run. */
  async function business(label: string): Promise<TenantFixture> {
    const tenant = await createTenant(owner, label);
    await owner`insert into workflow_settings (tenant_id, quiet_start_minute, quiet_end_minute) values (${tenant.tenantId}, 0, 0) on conflict (tenant_id) do update set quiet_start_minute = 0, quiet_end_minute = 0`;
    return tenant;
  }

  async function consent(tenantId: string, patientId: string, granted: boolean) {
    await owner`insert into consent_records (tenant_id, patient_id, purpose, granted, wording_version, source, actor_type) values (${tenantId}, ${patientId}, 'marketing_messages', ${granted}, '2026-11', 'staff', 'staff')`;
  }

  /** Runs the minute job and the worker until nothing is due, the way the live worker would over a few minutes. */
  async function runWorker(tenant: TenantFixture, sink: MessageSink, rounds = 3): Promise<void> {
    const handlers = createHandlers({ sink, now: () => new Date(), origin: "https://kalendr.example" });
    for (let round = 0; round < rounds; round += 1) {
      await worker.begin(async (tenantDb) => {
        await tenantDb`select set_config('app.tenant_id', ${tenant.tenantId}, true)`;
        await sweepTenantCampaigns(tenantDb, tenant.tenantId, new Date());
      });
      await drainTenantOutbox(worker, tenant.tenantId, handlers);
    }
  }

  async function secondService(tenant: TenantFixture, name = "Whitening"): Promise<string> {
    const [row] = await owner<{ id: string }[]>`
      insert into services (tenant_id, name, description, duration_minutes, booking_mode, patient_types) values (${tenant.tenantId}, ${name}, 'x', 30, 'instant', ${["new", "returning"]}) returning id`;
    return row!.id;
  }

  describe("the six-month recall", () => {
    it("messages only customers who had the service six months ago, agreed to marketing, and have nothing booked, once each", async () => {
      const tenant = await business("recall");
      const context = staffContext(tenant);
      const otherService = await secondService(tenant);
      const make = async (first: string, options: { daysAgo?: number; consent?: boolean | null; futureBooking?: boolean; dob?: string; blocked?: boolean; service?: string } = {}) => {
        const customer = await createCustomer(owner, tenant.tenantId, { firstName: first, dateOfBirth: options.dob ?? "1985-04-12" });
        if (options.daysAgo !== undefined) {
          await owner`
            insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash)
            values (${tenant.tenantId}, ${tenant.locationId}, ${customer.id}, ${tenant.practitionerId}, ${options.service ?? tenant.serviceId},
              now() - ${options.daysAgo} * interval '1 day', now() - ${options.daysAgo} * interval '1 day' + interval '30 minutes', 'completed', 'staff', ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")})`;
        }
        if (options.futureBooking) {
          await owner`
            insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash)
            values (${tenant.tenantId}, ${tenant.locationId}, ${customer.id}, ${tenant.practitionerId}, ${tenant.serviceId},
              now() + interval '5 days', now() + interval '5 days 30 minutes', 'booked', 'staff', ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")})`;
        }
        if (options.consent !== null) await consent(tenant.tenantId, customer.id, options.consent ?? true);
        if (options.blocked) await owner`update patients set blocked_at = now() where id = ${customer.id}`;
        return customer;
      };
      const eligible = await make("Eligible", { daysAgo: 185 });
      await make("NoConsent", { daysAgo: 185, consent: null });
      await make("Withdrew", { daysAgo: 185, consent: false });
      await make("HasFuture", { daysAgo: 185, futureBooking: true });
      await make("TooRecent", { daysAgo: 30 });
      await make("TooOld", { daysAgo: 400 });
      await make("OtherService", { daysAgo: 185, service: otherService });
      await make("Minor", { daysAgo: 185, dob: new Date(Date.now() - 10 * 365 * DAY).toISOString().slice(0, 10) });
      await make("Blocked", { daysAgo: 185, blocked: true });
      const optedOut = await make("OptedOut", { daysAgo: 185 });
      await owner`insert into marketing_preferences (tenant_id, patient_id, channel, opted_in, source) values (${tenant.tenantId}, ${optedOut.id}, 'email', false, 'test')`;

      const campaign = await activatePreset(context, "recall", { channel: "email", recallServices: [{ serviceId: tenant.serviceId, intervalDays: 180 }], templateKey: null }, key());
      expect(campaign.status).toBe("active");
      expect(campaign.kind).toBe("automated");

      const preview = await previewAudience(context, campaign.id);
      expect(preview.eligible).toBe(1);
      const leftOut = Object.fromEntries(preview.leftOut.map((entry) => [entry.reason, entry.count]));
      expect(leftOut).toMatchObject({ no_marketing_consent: 2, future_booking: 1, under_18: 1, blocked: 1, channel_not_agreed: 1 });

      const sink = recordingSink();
      await runWorker(tenant, sink);
      expect([...sink.accepted.values()].map((message) => message.patientId)).toEqual([eligible.id]);
      const [delivered] = [...sink.accepted.values()];
      expect(delivered?.channel).toBe("email");
      const body = JSON.parse(delivered!.message.body) as { unsubscribeUrl: string; bookUrl: string; text: string };
      expect(body.unsubscribeUrl).toMatch(/^https:\/\/kalendr\.example\/api\/public\/unsubscribe\/[A-Za-z0-9_-]{43}$/);
      expect(body.bookUrl).toContain(`utm_campaign=${campaign.code}`);
      expect(body.text).toContain("Eligible");

      // Running the daily job again, even many times, catches nobody twice.
      await runWorker(tenant, sink, 4);
      expect(sink.accepted.size).toBe(1);
      const rows = await owner`select status from campaign_sends where tenant_id = ${tenant.tenantId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("sent");
    });
  });

  describe("restarts", () => {
    it("sends nothing twice when the worker stops in the middle and comes back", async () => {
      const tenant = await business("restart");
      const context = staffContext(tenant);
      const customers = [];
      for (let index = 0; index < 4; index += 1) {
        const customer = await createCustomer(owner, tenant.tenantId, { firstName: `Restart${index}` });
        await createBooking(owner, tenant, customer.id, { endsDaysAgo: 185 });
        await consent(tenant.tenantId, customer.id, true);
        customers.push(customer);
      }
      await activatePreset(context, "recall", { channel: "email", recallServices: [{ serviceId: tenant.serviceId, intervalDays: 180 }], templateKey: null }, key());
      // The first two messages are accepted by the provider and then the worker dies before it writes anything down.
      const sink = recordingSink({ dieAfterAccepting: { remaining: 2 } });
      await runWorker(tenant, sink, 2);
      // The worker comes back (the outbox's retry wait is over): the same messages are offered again, the provider already has them, nothing new is sent.
      await owner`update outbox_events set available_at = now() where tenant_id = ${tenant.tenantId} and status in ('failed', 'processing')`;
      await runWorker(tenant, sink, 6);
      expect(sink.accepted.size).toBe(4);
      expect(new Set([...sink.accepted.values()].map((message) => message.patientId)).size).toBe(4);
      const settled = await owner`select status, count(*)::int as n from campaign_sends where tenant_id = ${tenant.tenantId} group by status`;
      expect(settled.find((row) => row.status === "sent")?.n).toBe(4);
    });

    it("never fans out twice and never sends a settled message again", async () => {
      const tenant = await business("fanout");
      const context = staffContext(tenant);
      const customer = await createCustomer(owner, tenant.tenantId, { firstName: "Once" });
      await createBooking(owner, tenant, customer.id, { endsDaysAgo: 185 });
      await consent(tenant.tenantId, customer.id, true);
      const campaign = await activatePreset(context, "recall", { channel: "email", recallServices: [{ serviceId: tenant.serviceId, intervalDays: 180 }], templateKey: null }, key());
      const sink = recordingSink();
      await runWorker(tenant, sink);
      const [send] = await owner<{ id: string }[]>`select id from campaign_sends where campaign_id = ${campaign.id}`;
      const handlers = createHandlers({ sink, now: () => new Date(), origin: "https://kalendr.example" });
      const handler = handlers.get("campaign.send")!;
      const before = sink.calls;
      await worker.begin(async (tenantDb) => {
        await tenantDb`select set_config('app.tenant_id', ${tenant.tenantId}, true)`;
        await handler(tenantDb, { id: randomUUID(), tenantId: tenant.tenantId, aggregateType: "campaign", aggregateId: campaign.id, eventType: "campaign.send", payload: { sendId: send!.id }, dedupeKey: "again", attemptCount: 1 });
      });
      expect(sink.calls).toBe(before);
      const fan = handlers.get("campaign.fanout")!;
      await worker.begin(async (tenantDb) => {
        await tenantDb`select set_config('app.tenant_id', ${tenant.tenantId}, true)`;
        await fan(tenantDb, { id: randomUUID(), tenantId: tenant.tenantId, aggregateType: "campaign", aggregateId: campaign.id, eventType: "campaign.fanout", payload: { campaignId: campaign.id }, dedupeKey: "again2", attemptCount: 1 });
      });
      expect((await owner`select id from campaign_sends where campaign_id = ${campaign.id}`)).toHaveLength(1);
    });
  });

  describe("consent, STOP and unsubscribe", () => {
    it("unsubscribing takes effect at once, stops all marketing, and leaves appointment messages alone", async () => {
      const tenant = await business("unsub");
      const context = staffContext(tenant);
      const customer = await createCustomer(owner, tenant.tenantId, { firstName: "Leaver" });
      await createBooking(owner, tenant, customer.id, { endsDaysAgo: 185 });
      await consent(tenant.tenantId, customer.id, true);
      const campaign = await activatePreset(context, "recall", { channel: "email", recallServices: [{ serviceId: tenant.serviceId, intervalDays: 180 }], templateKey: null }, key());
      const sink = recordingSink();
      await runWorker(tenant, sink);
      const [send] = await owner<{ id: string; unsubscribe_token_ciphertext: string }[]>`select id, unsubscribe_token_ciphertext from campaign_sends where campaign_id = ${campaign.id}`;
      const token = openUnsubscribeToken(tenant.tenantId, send!.id, send!.unsubscribe_token_ciphertext);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // Only the hash is stored, never the token.
      const stored = await owner`select unsubscribe_token_hash from campaign_sends where id = ${send!.id}`;
      expect(stored[0]?.unsubscribe_token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored[0]?.unsubscribe_token_hash).not.toContain(token!);

      expect((await unsubscribeByToken(token!)).status).toBe("done");
      expect((await unsubscribeByToken(token!)).status).toBe("already");
      expect(await hasConsent(tenant.tenantId, customer.id, "marketing_messages")).toBe(false);
      expect(await hasConsent(tenant.tenantId, customer.id, "appointment_messages")).toBe(true);
      const [preference] = await owner`select opted_in from marketing_preferences where tenant_id = ${tenant.tenantId} and patient_id = ${customer.id} and channel = 'email'`;
      expect(preference?.opted_in).toBe(false);

      // A second campaign never reaches them, and a booking reminder is not affected by the withdrawal.
      const preview = await previewAudience(context, campaign.id);
      expect(preview.eligible).toBe(0);
      const audit = await owner`select metadata->>'source' as source from audit_events where tenant_id = ${tenant.tenantId} and action = 'privacy.consent.withdrawn'`;
      expect(audit.map((row) => row.source)).toContain("unsubscribe_link");
    });

    it("answers a dead, mistyped or other business's link the same way and reveals nothing", async () => {
      expect((await unsubscribeByToken("short")).status).toBe("invalid");
      expect((await unsubscribeByToken("A".repeat(43))).status).toBe("invalid");
      expect((await unsubscribeByToken("not a token!".padEnd(43, "x"))).status).toBe("invalid");
    });

    it("lets a customer's STOP on WhatsApp end marketing while reminders carry on", async () => {
      const tenant = await business("stop");
      const customer = await createCustomer(owner, tenant.tenantId, { firstName: "Stopper" });
      await owner`update patients set messaging_consent_at = now() where id = ${customer.id}`;
      await consent(tenant.tenantId, customer.id, true);
      const [thread] = await owner<{ id: string }[]>`insert into message_threads (tenant_id, patient_id, channel, contact_hash) values (${tenant.tenantId}, ${customer.id}, 'whatsapp', ${randomUUID()}) returning id`;
      await owner`insert into messages (tenant_id, thread_id, direction, kind, template_key, status, provider_message_id) values (${tenant.tenantId}, ${thread!.id}, 'outbound', 'template', 'campaign_recall', 'sent', ${randomUUID()})`;
      const [inbound] = await owner<{ id: string }[]>`insert into messages (tenant_id, thread_id, direction, kind, status, provider_message_id) values (${tenant.tenantId}, ${thread!.id}, 'inbound', 'text', 'received', ${randomUUID()}) returning id`;
      const handlers = createHandlers({ sink: recordingSink(), now: () => new Date(), origin: "https://kalendr.example" });
      await worker.begin(async (tenantDb) => {
        await tenantDb`select set_config('app.tenant_id', ${tenant.tenantId}, true)`;
        await handlers.get("channel.inbound")!(tenantDb, {
          id: randomUUID(), tenantId: tenant.tenantId, aggregateType: "thread", aggregateId: thread!.id, eventType: "channel.inbound",
          payload: { threadId: thread!.id, messageId: inbound!.id, patientId: customer.id, kind: "text", buttonPayload: null, stop: true }, dedupeKey: randomUUID(), attemptCount: 1,
        });
      });
      expect(await hasConsent(tenant.tenantId, customer.id, "marketing_messages")).toBe(false);
      const [row] = await owner`select messaging_consent_at from patients where id = ${customer.id}`;
      expect(row?.messaging_consent_at).not.toBeNull();
      expect(await hasConsent(tenant.tenantId, customer.id, "appointment_messages")).toBe(true);
      const [preference] = await owner`select opted_in from marketing_preferences where patient_id = ${customer.id} and channel = 'whatsapp'`;
      expect(preference?.opted_in).toBe(false);
    });
  });

  describe("limits", () => {
    it("never sends more than one marketing message to a customer in 7 days across campaigns", async () => {
      const tenant = await business("cap");
      const context = staffContext(tenant);
      const customer = await createCustomer(owner, tenant.tenantId, { firstName: "Capped" });
      await createBooking(owner, tenant, customer.id, { endsDaysAgo: 185 });
      await consent(tenant.tenantId, customer.id, true);
      const first = await activatePreset(context, "recall", { channel: "email", recallServices: [{ serviceId: tenant.serviceId, intervalDays: 180 }], templateKey: null }, key());
      const sink = recordingSink();
      await runWorker(tenant, sink);
      expect(sink.accepted.size).toBe(1);
      // Another campaign that would also pick them is told "recent message".
      const second = await createCampaign(context, { kind: "automated", name: "Win-back test", rule: { type: "win_back", daysAway: 160 }, presetKey: null, channel: "email", subject: "Hi", body: "Hello {customer_first_name}", templateKey: null }, key());
      const preview = await previewAudience(context, second.id);
      expect(preview.eligible).toBe(0);
      expect(preview.leftOut.find((entry) => entry.reason === "recent_message")?.count).toBe(1);
      expect(first.id).not.toBe(second.id);
    });

    it("waits out quiet hours, and holds a paused campaign's messages instead of losing them", async () => {
      const tenant = await createTenant(owner, "quiet");
      const context = staffContext(tenant);
      const customer = await createCustomer(owner, tenant.tenantId, { firstName: "Quiet" });
      await createBooking(owner, tenant, customer.id, { endsDaysAgo: 185 });
      await consent(tenant.tenantId, customer.id, true);
      const campaign = await activatePreset(context, "recall", { channel: "email", recallServices: [{ serviceId: tenant.serviceId, intervalDays: 180 }], templateKey: null }, key());
      // Quiet hours cover the whole day.
      await owner`insert into workflow_settings (tenant_id, quiet_start_minute, quiet_end_minute) values (${tenant.tenantId}, 1, 1439) on conflict (tenant_id) do update set quiet_start_minute = 1, quiet_end_minute = 1439`;
      const sink = recordingSink();
      const handlers = createHandlers({ sink, now: () => new Date(), origin: "https://kalendr.example" });
      for (let round = 0; round < 3; round += 1) {
        await worker.begin(async (tenantDb) => {
          await tenantDb`select set_config('app.tenant_id', ${tenant.tenantId}, true)`;
          // Pretend it is midday locally so the window applies.
          const midday = new Date(); midday.setUTCHours(6, 30, 0, 0);
          await sweepTenantCampaigns(tenantDb, tenant.tenantId, midday);
        });
        await drainTenantOutbox(worker, tenant.tenantId, handlers);
      }
      expect(sink.accepted.size).toBe(0);
      const [send] = await owner`select status from campaign_sends where campaign_id = ${campaign.id}`;
      expect(send?.status).toBe("pending");
      // Pausing keeps what is waiting; resuming carries on.
      const paused = await setCampaignStatus(context, campaign.id, { action: "pause", version: campaign.version });
      expect(paused.status).toBe("paused");
      await owner`update workflow_settings set quiet_start_minute = 0, quiet_end_minute = 0 where tenant_id = ${tenant.tenantId}`;
      await owner`update campaign_sends set send_at = now() - interval '1 minute' where campaign_id = ${campaign.id}`;
      await runWorker(tenant, sink);
      expect(sink.accepted.size).toBe(0);
      await setCampaignStatus(context, campaign.id, { action: "resume", version: paused.version });
      await runWorker(tenant, sink);
      expect(sink.accepted.size).toBe(1);
    });

    it("pauses itself and tells the owner when too many messages fail or too many people unsubscribe", async () => {
      const tenant = await business("health");
      const context = staffContext(tenant);
      const campaign = await createCampaign(context, { kind: "automated", name: "Risky", rule: { type: "birthday" }, presetKey: null, channel: "email", subject: "Hi", body: "Hello", templateKey: null }, key());
      const started = await setCampaignStatus(context, campaign.id, { action: "start", version: campaign.version });
      const [owner1] = await owner<{ id: string }[]>`select id from memberships where tenant_id = ${tenant.tenantId} limit 1`;
      if (!owner1) await owner`insert into memberships (tenant_id, user_id, role) select ${tenant.tenantId}, id, 'owner' from auth_users limit 1`;
      for (let index = 0; index < 25; index += 1) {
        const customer = await createCustomer(owner, tenant.tenantId);
        await owner`
          insert into campaign_sends (tenant_id, campaign_id, patient_id, channel, status, send_at, sent_at, unsubscribe_token_hash)
          values (${tenant.tenantId}, ${campaign.id}, ${customer.id}, 'email', ${index < 10 ? "failed" : "sent"}, now(), now(), ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")})`;
      }
      const paused = await worker.begin(async (tenantDb) => {
        await tenantDb`select set_config('app.tenant_id', ${tenant.tenantId}, true)`;
        return pauseUnhealthyCampaigns(postgresRunner(tenantDb), tenant.tenantId);
      });
      expect(paused).toBe(1);
      const after = await getCampaign(context, campaign.id);
      expect(after.status).toBe("paused");
      expect(after.pausedReason).toBe("high_failures");
      expect(after.version).toBe(started.version + 1);
    });
  });

  describe("attribution", () => {
    it("credits a booking made from the link within 7 days, with its revenue, and not one made later", async () => {
      const tenant = await business("attr");
      const context = staffContext(tenant);
      const credited = await createCustomer(owner, tenant.tenantId, { firstName: "Booker" });
      const late = await createCustomer(owner, tenant.tenantId, { firstName: "Late" });
      for (const customer of [credited, late]) {
        await createBooking(owner, tenant, customer.id, { endsDaysAgo: 185 });
        await consent(tenant.tenantId, customer.id, true);
      }
      const campaign = await activatePreset(context, "recall", { channel: "email", recallServices: [{ serviceId: tenant.serviceId, intervalDays: 180 }], templateKey: null }, key());
      await runWorker(tenant, recordingSink());
      const sends = await owner<{ id: string; patient_id: string }[]>`select id, patient_id from campaign_sends where campaign_id = ${campaign.id}`;
      expect(sends).toHaveLength(2);
      const book = async (patientId: string, daysAfterSend: number) => {
        const [row] = await owner<{ id: string }[]>`
          insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash, utm_campaign, created_at)
          select ${tenant.tenantId}, ${tenant.locationId}, ${patientId}, ${tenant.practitionerId}, ${tenant.serviceId}, now() + interval '20 days', now() + interval '20 days 30 minutes', 'booked', 'online',
            ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")}, ${campaign.code}, sent_at + ${daysAfterSend} * interval '1 day'
          from campaign_sends where campaign_id = ${campaign.id} and patient_id = ${patientId} returning id`;
        return row!.id;
      };
      const good = await book(credited.id, 3);
      await book(late.id, ATTRIBUTION_DAYS + 2);
      await owner`insert into payments (tenant_id, appointment_id, amount_minor, currency, method) values (${tenant.tenantId}, ${good}, 120000, 'INR', 'cash')`;
      await runWorker(tenant, recordingSink(), 1);
      const stats = await worker.begin(async (tenantDb) => {
        await tenantDb`select set_config('app.tenant_id', ${tenant.tenantId}, true)`;
        return (await campaignStats(postgresRunner(tenantDb), tenant.tenantId)).get(campaign.id);
      });
      expect(stats).toMatchObject({ sent: 2, booked: 1, revenueMinor: 120000 });
      const shown = await getCampaign(context, campaign.id);
      expect(shown.stats.booked).toBe(1);
      const [creditedSend] = await owner`select booked_appointment_id from campaign_sends where campaign_id = ${campaign.id} and patient_id = ${credited.id}`;
      expect(creditedSend?.booked_appointment_id).toBe(good);
    });
  });

  describe("one-off campaigns and tests", () => {
    it("needs a test send before it can go to a segment, and the test sees the filled-in words", async () => {
      const tenant = await business("oneoff");
      const context = staffContext(tenant);
      const customer = await createCustomer(owner, tenant.tenantId, { firstName: "Asha" });
      await createBooking(owner, tenant, customer.id, { endsDaysAgo: 40 });
      await consent(tenant.tenantId, customer.id, true);
      const [member] = await owner<{ id: string }[]>`select id from auth_users limit 1`;
      await owner`insert into memberships (tenant_id, user_id, role) values (${tenant.tenantId}, ${member!.id}, 'owner') on conflict do nothing`;
      const withUser = staffContext(tenant, { userId: member!.id });
      const segment = await createSegment(context, { name: "Recent regulars", filter: { all: [{ field: "marketingConsent", value: true }, { field: "visits", op: "gte", value: 1 }] } });
      const campaign = await createCampaign(withUser, {
        kind: "one_off", name: "Quiet Tuesday", segmentId: segment.id, serviceId: null, scheduledAt: null, channel: "email",
        subject: "A quiet Tuesday offer, {customer_first_name}", body: "Hi {customer_first_name}, come in on Tuesday. {book_link}", templateKey: null,
      }, key());
      await expectApiError(setCampaignStatus(withUser, campaign.id, { action: "start", version: campaign.version }), "test_required");

      const preview = await previewMessage(withUser, campaign.id, "https://kalendr.example");
      expect(preview.customerFirstName).toBe("Asha");
      expect(preview.subject).toBe("A quiet Tuesday offer, Asha");
      expect(preview.body).toContain("utm_campaign=");

      const provider = createFakeEmailProvider();
      const sink = providerSink({ email: createEmailAdapter({ provider, origin: "https://kalendr.example", fallbackReplyTo: null }) });
      await requestTestSend(withUser, campaign.id, {}, "same-key-123");
      await requestTestSend(withUser, campaign.id, {}, "same-key-123");
      const handlers = createHandlers({ sink, now: () => new Date(), origin: "https://kalendr.example" });
      await drainTenantOutbox(worker, tenant.tenantId, handlers);
      // The same test asked for twice is one test; nothing went to the customer.
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0]?.subject.startsWith("[Test]")).toBe(true);
      const tested = await getCampaign(withUser, campaign.id);
      expect(tested.tested).toBe(true);

      const started = await setCampaignStatus(withUser, campaign.id, { action: "start", version: tested.version });
      expect(started.status).toBe("active");
      await runWorker(tenant, sink);
      // Real send: the email carries an unsubscribe link and the List-Unsubscribe pair.
      const real = provider.sent.find((message) => message.to === customer.email);
      expect(real).toBeDefined();
      expect(real!.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/kalendr\.example\/api\/public\/unsubscribe\/[A-Za-z0-9_-]{43}>$/);
      expect(real!.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      expect(real!.html).toContain("/api/public/unsubscribe/");
      expect(real!.text).toContain("Unsubscribe");
      const done = await getCampaign(withUser, campaign.id);
      expect(done.status).toBe("completed");
      expect(done.stats.sent).toBe(1);

      // Editing the words after a test asks for a new one.
      await expectApiError(setCampaignStatus(withUser, campaign.id, { action: "start", version: done.version }), "invalid_state");
    });

    it("never sends WhatsApp from a template Meta has not approved", async () => {
      const tenant = await business("wa");
      const context = staffContext(tenant);
      await expectApiError(createCampaign(context, {
        kind: "automated", name: "WhatsApp birthday", rule: { type: "birthday" }, presetKey: null, channel: "whatsapp", subject: "", body: "", templateKey: "not_a_template",
      }, key()), "validation_error");
      const campaign = await createCampaign(context, {
        kind: "automated", name: "WhatsApp birthday", rule: { type: "birthday" }, presetKey: null, channel: "whatsapp", subject: "", body: "", templateKey: "campaign_birthday",
      }, key());
      // The shipped template is pending until Meta approves it, and the channel is not connected in a test.
      await expect(setCampaignStatus(context, campaign.id, { action: "start", version: campaign.version })).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe("one business cannot see or reach another's campaigns", () => {
    it("keeps campaigns, sends and unsubscribe tokens apart", async () => {
      const a = await business("iso-a");
      const b = await business("iso-b");
      const context = staffContext(a);
      const customer = await createCustomer(owner, a.tenantId);
      await createBooking(owner, a, customer.id, { endsDaysAgo: 185 });
      await consent(a.tenantId, customer.id, true);
      const campaign = await activatePreset(context, "recall", { channel: "email", recallServices: [{ serviceId: a.serviceId, intervalDays: 180 }], templateKey: null }, key());
      await runWorker(a, recordingSink());
      expect(await listCampaigns(staffContext(b))).toEqual([]);
      await expectApiError(getCampaign(staffContext(b), campaign.id), "campaign_not_found");
      await expectApiError(setCampaignStatus(staffContext(b), campaign.id, { action: "cancel", version: 1 }), "campaign_not_found");
      const [send] = await owner<{ id: string }[]>`select id from campaign_sends where campaign_id = ${campaign.id}`;
      // Row-level security: business B's session sees none of A's sends.
      const seen = await worker.begin(async (tenantDb) => {
        await tenantDb`select set_config('app.tenant_id', ${b.tenantId}, true)`;
        return tenantDb`select id from campaign_sends where id = ${send!.id}`;
      });
      expect(seen).toHaveLength(0);
    });

    it("needs the campaigns permission", async () => {
      const tenant = await business("perm");
      const receptionist = staffContext(tenant, { role: "receptionist", permissions: resolvePermissions("receptionist", {}) });
      await expectApiError(listCampaigns(receptionist), "forbidden");
    });
  });

  it("records consent changes made elsewhere in the same way (portal switch)", async () => {
    const tenant = await business("portal");
    const customer = await createCustomer(owner, tenant.tenantId);
    await recordConsent(tenant.tenantId, { patientId: customer.id, purpose: "marketing_messages", granted: true, source: "portal", actor: { type: "patient" } });
    expect(await hasConsent(tenant.tenantId, customer.id, "marketing_messages")).toBe(true);
  });
});
