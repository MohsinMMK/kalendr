/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { isolatedDatabaseReady } from "@/test/isolated-database";
import { drainTenantOutbox } from "@/test/outbox-drain";
import { createTenant, type TenantFixture } from "@/test/privacy-fixture";
import { inboundTextCallback, signedWhatsAppRequest, TEST_WHATSAPP_APP_SECRET } from "@/test/whatsapp-webhook";

vi.mock("server-only", () => ({}));

import { setAssistantModelForTests, type LlmBlock, type LlmRequest } from "@/server/assistant/model";
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

const call = (id: string, name: string, input: Record<string, unknown>): LlmBlock => ({ type: "tool_use", id, name, input });
const say = (text: string): LlmBlock[] => [{ type: "text", text }];
const resultOf = (request: LlmRequest, name: string): Record<string, unknown> => {
  const names = new Map<string, string>();
  let found: Record<string, unknown> = {};
  for (const message of request.messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "tool_use") names.set(block.id, block.name);
      if (block.type === "tool_result" && names.get(block.tool_use_id) === name) found = JSON.parse(block.content) as Record<string, unknown>;
    }
  }
  return found;
};

describeIsolated("the booking assistant on WhatsApp, run by the worker", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let fixture: TenantFixture;
  // A provider message id is unique across the database, so every run uses its own.
  const run = randomUUID().slice(0, 8);
  const phone = `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const whatsapp = createCaptureChannel("whatsapp");
  const handlers = () => createHandlers({
    sink: localCaptureSink, now: () => new Date(), origin: "https://app.example.test", channels: { whatsapp }, databaseUrl: workerUrl!,
  });
  let patientId = "";
  let threadId = "";

  beforeAll(async () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", TEST_WHATSAPP_APP_SECRET);
    owner = postgres(ownerUrl!, { max: 2, prepare: false });
    worker = postgres(workerUrl!, { max: 2, prepare: false });
    fixture = await createTenant(owner, "wa");
    await owner`update services set duration_minutes = 30, slot_interval_minutes = 30, minimum_lead_minutes = 0, maximum_advance_days = 60, slug = ${`cut-${randomUUID().slice(0, 6)}`}, name = 'Haircut' where id = ${fixture.serviceId}`;
    await owner`insert into service_locations (tenant_id, service_id, location_id) values (${fixture.tenantId}, ${fixture.serviceId}, ${fixture.locationId})`;
    await owner`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${fixture.tenantId}, ${fixture.practitionerId}, ${fixture.serviceId})`;
    await owner`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${fixture.tenantId}, ${fixture.practitionerId}, ${fixture.locationId})`;
    for (let day = 1; day <= 7; day += 1) {
      await owner`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
        values (${randomUUID()}, ${fixture.tenantId}, ${fixture.locationId}, ${fixture.practitionerId}, ${day}, '09:00', '18:00', 'Asia/Kolkata', '2025-01-01', 30)`;
    }
    const [staff] = await owner<{ id: string }[]>`insert into auth_users (name, email, email_verified) values ('Desk', ${`desk-${randomUUID().slice(0, 8)}@example.com`}, true) returning id`;
    await owner`insert into memberships (tenant_id, user_id, role) values (${fixture.tenantId}, ${staff!.id}, 'owner')`;
    await owner`insert into assistant_settings (tenant_id, enabled_web, enabled_whatsapp) values (${fixture.tenantId}, true, true)`;
    const [patient] = await owner<{ id: string }[]>`
      insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel, messaging_consent_at)
      values (${fixture.tenantId}, 'Wanda', 'Whats', ${phone}, 'wanda@example.com', 'whatsapp', now()) returning id`;
    patientId = patient!.id;
    const [thread] = await owner<{ id: string }[]>`
      insert into message_threads (tenant_id, patient_id, channel, contact_hash) values (${fixture.tenantId}, ${patientId}, 'whatsapp', ${contactHash("whatsapp", phone)}) returning id`;
    threadId = thread!.id;
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
    return (await response.json() as { data: { inbound: { stored: number } } }).data.inbound.stored;
  };
  const drain = () => drainTenantOutbox(worker, fixture.tenantId, handlers());

  it("takes a booking on WhatsApp: the webhook only queues, the worker runs the model, a yes books it, the reply goes out in the window", async () => {
    const model = createScriptedModel([
      () => [call("w1", "list_services", {})],
      (request) => [call("w2", "find_times", { serviceId: (resultOf(request, "list_services").services as Array<{ id: string }>)[0]!.id })],
      (request) => say(`Free: ${String((resultOf(request, "find_times").times as Array<{ when: string }>)[0]?.when)}. Shall I book the first?`),
      (request) => {
        const services = resultOf(request, "list_services").services as Array<{ id: string }>;
        const times = resultOf(request, "find_times").times as Array<{ startsAt: string; personId: string }>;
        return [call("w3", "hold_and_book", { serviceId: services[0]!.id, personId: times[0]!.personId, startsAt: times[0]!.startsAt, firstName: "Ignored", lastName: "Ignored", phone: "+910000000000" })];
      },
      (request) => say(`${String(resultOf(request, "hold_and_book").summary)} Reply yes to confirm.`),
      () => say("Done! See you then."),
    ]);
    setAssistantModelForTests(model);

    await send("wamid.assistant.1", "Hi, can I get a haircut this week?");
    // The webhook did no model work: nothing has run yet.
    expect(model.calls).toHaveLength(0);
    expect(await owner`select id from outbox_events where tenant_id = ${fixture.tenantId} and event_type = 'channel.inbound' and status = 'pending'`).toHaveLength(1);
    await drain();
    expect(whatsapp.sent.at(-1)?.content).toMatchObject({ kind: "text" });
    const firstReply = whatsapp.sent.at(-1)!.content as { kind: "text"; body: string };
    expect(firstReply.body).toContain("automated booking assistant");
    expect(firstReply.body).toContain("Free:");
    expect(await owner`select id from appointments where tenant_id = ${fixture.tenantId}`).toHaveLength(0);

    expect(await send("wamid.assistant.2", "yes please")).toBe(1);
    // The provider sends the same callback again: stored once, answered once.
    expect(await send("wamid.assistant.2", "yes please")).toBe(0);
    await drain();
    // "yes" to "shall I book the first?" only proposes; the booking waits for a yes to the proposal itself.
    expect(await owner`select id from appointments where tenant_id = ${fixture.tenantId}`).toHaveLength(0);
    expect((whatsapp.sent.at(-1)!.content as { body: string }).body).toContain("Reply yes to confirm");
    await send("wamid.assistant.3", "yes");
    await drain();
    const booked = await owner<{ booking_source: string; patient_id: string }[]>`select booking_source, patient_id from appointments where tenant_id = ${fixture.tenantId}`;
    // The number on the thread, not what the model typed, decided who was booked; the repeated webhook did nothing twice.
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({ booking_source: "assistant", patient_id: patientId });
    expect((await owner<{ first_name: string }[]>`select first_name from patients where id = ${patientId}`)[0]!.first_name).toBe("Wanda");
    expect((whatsapp.sent.at(-1)!.content as { body: string }).body).toContain("Done");
    expect(model.calls.length).toBe(6);
  });

  it("hands a symptom question to staff, stops replying, and tells staff about later messages without a model call", async () => {
    const model = createScriptedModel([() => say("should not run")]);
    setAssistantModelForTests(model);
    const before = whatsapp.sent.length;
    await send("wamid.assistant.5", "What medicine should I take for a headache?");
    await drain();
    expect(model.calls).toHaveLength(0);
    expect((whatsapp.sent.at(-1)!.content as { body: string }).body).toMatch(/can't give medical/i);
    expect(whatsapp.sent.length).toBe(before + 1);
    const conversation = await owner<{ status: string }[]>`select status from assistant_conversations where tenant_id = ${fixture.tenantId} and thread_id = ${threadId} order by created_at desc limit 1`;
    expect(conversation[0]!.status).toBe("handed_off");
    await send("wamid.assistant.6", "Hello? Anyone there?");
    await drain();
    // A person has the chat: no automatic reply, but staff are told.
    expect(whatsapp.sent.length).toBe(before + 1);
    expect(model.calls).toHaveLength(0);
    expect(await owner`select id from staff_notifications where tenant_id = ${fixture.tenantId} and kind = 'needs_person'`).not.toHaveLength(0);
  });
});
