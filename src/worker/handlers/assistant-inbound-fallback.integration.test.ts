/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { isolatedDatabaseReady } from "@/test/isolated-database";
import { drainTenantOutbox } from "@/test/outbox-drain";
import { createTenant, type TenantFixture } from "@/test/privacy-fixture";
import { inboundTextCallback, signedWhatsAppRequest, TEST_WHATSAPP_APP_SECRET } from "@/test/whatsapp-webhook";

vi.mock("server-only", () => ({}));

import { setAssistantModelForTests } from "@/server/assistant/model";
import { createScriptedModel } from "@/server/assistant/scripted-model";
import { createCaptureChannel } from "@/server/channels/capture";
import { contactHash } from "@/server/channels/phone";
import { localCaptureSink } from "@/worker/delivery";
import { createHandlers } from "@/worker/handlers";
import { POST as webhook } from "@/app/api/webhooks/whatsapp/route";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? process.env.KALENDR_E2E_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeIsolated = isolatedDatabaseReady(runtimeUrl, ownerUrl, workerUrl) ? describe : describe.skip;

/** When the assistant cannot really answer, a customer's WhatsApp message must still reach a person, as it did before the assistant existed. */
describeIsolated("the assistant on WhatsApp when it cannot answer", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let fixture: TenantFixture;
  const run = randomUUID().slice(0, 8);
  const phone = `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const whatsapp = createCaptureChannel("whatsapp");
  const drain = () => drainTenantOutbox(worker, fixture.tenantId, createHandlers({
    sink: localCaptureSink, now: () => new Date(), origin: "https://app.example.test", channels: { whatsapp }, databaseUrl: workerUrl!,
  }));

  beforeAll(async () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", TEST_WHATSAPP_APP_SECRET);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ASSISTANT_PROVIDER_MODE", "");
    owner = postgres(ownerUrl!, { max: 2, prepare: false });
    worker = postgres(workerUrl!, { max: 2, prepare: false });
    fixture = await createTenant(owner, "wa-fallback");
    const [staff] = await owner<{ id: string }[]>`insert into auth_users (name, email, email_verified) values ('Desk', ${`desk-${randomUUID().slice(0, 8)}@example.com`}, true) returning id`;
    await owner`insert into memberships (tenant_id, user_id, role) values (${fixture.tenantId}, ${staff!.id}, 'owner')`;
    await owner`insert into assistant_settings (tenant_id, enabled_web, enabled_whatsapp) values (${fixture.tenantId}, true, true)`;
    const [patient] = await owner<{ id: string }[]>`
      insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel, messaging_consent_at)
      values (${fixture.tenantId}, 'Fiona', 'Fallback', ${phone}, 'fiona@example.com', 'whatsapp', now()) returning id`;
    await owner`insert into message_threads (tenant_id, patient_id, channel, contact_hash) values (${fixture.tenantId}, ${patient!.id}, 'whatsapp', ${contactHash("whatsapp", phone)})`;
  });
  afterEach(() => setAssistantModelForTests(null));
  afterAll(async () => {
    vi.unstubAllEnvs();
    await owner.end();
    await worker.end();
  });

  const send = async (id: string, text: string) => {
    const request = signedWhatsAppRequest(TEST_WHATSAPP_APP_SECRET, inboundTextCallback(phone, `${run}.${id}`, text));
    const response = await webhook(new Request("http://localhost/api/webhooks/whatsapp", { method: "POST", headers: request.headers, body: request.body }));
    expect(response.status).toBe(200);
  };
  const alerts = () => owner<{ id: string }[]>`select id from staff_notifications where tenant_id = ${fixture.tenantId} and kind = 'message'`;

  it("leaves the message for staff, with their alert, and sends no automatic reply, when no model is set up", async () => {
    await send("nomodel", "Hello, are you open on Sunday?");
    await drain();
    expect(await owner`select id from outbox_events where tenant_id = ${fixture.tenantId} and event_type = 'assistant.inbound'`).toHaveLength(0);
    expect(whatsapp.sent).toHaveLength(0);
    expect(await alerts()).not.toHaveLength(0);
    expect(await owner`select id from assistant_conversations where tenant_id = ${fixture.tenantId}`).toHaveLength(0);
  });

  it("sends the booking link and still tells staff when the month's allowance is used up", async () => {
    const model = createScriptedModel([() => [{ type: "text", text: "must not run" }]]);
    setAssistantModelForTests(model);
    const month = new Date().toISOString().slice(0, 7) + "-01";
    await owner`insert into assistant_usage (tenant_id, period, input_tokens) values (${fixture.tenantId}, ${month}::date, 4000000) on conflict (tenant_id, period) do update set input_tokens = 4000000`;
    const before = (await alerts()).length;
    await send("capped", "Can I book for tomorrow?");
    await drain();
    expect(model.calls).toHaveLength(0);
    const reply = whatsapp.sent.at(-1)!.content as { kind: "text"; body: string };
    expect(reply.body).toContain(`/book/${fixture.slug}`);
    expect((await alerts()).length).toBeGreaterThan(before);
  });
});
