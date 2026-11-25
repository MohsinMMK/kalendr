/** @vitest-environment node */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { withTenant } from "@/db/client";
import { isolatedDatabaseReady } from "@/test/isolated-database";
import { createCustomer, createTenant, type TenantFixture } from "@/test/privacy-fixture";

vi.mock("server-only", () => ({}));

import { appendMessages, createConversation, loadHistory, loadUiHistory, visibleLines } from "@/server/assistant/store";
import { collectCustomerExport } from "@/server/privacy/export";
import { eraseCustomer } from "@/server/privacy/erasure";
import { applyRetention } from "@/worker/jobs";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? process.env.KALENDR_E2E_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeIsolated = isolatedDatabaseReady(runtimeUrl, ownerUrl, workerUrl) ? describe : describe.skip;

describeIsolated("assistant chats follow the privacy rules (export, erasure, retention)", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let fixture: TenantFixture;

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    worker = postgres(workerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    fixture = await createTenant(owner, "assistant-privacy");
  });
  afterAll(async () => {
    await Promise.all([owner.end(), worker.end()]);
  });

  async function chatFor(patientId: string, words: string): Promise<string> {
    return withTenant(fixture.tenantId, async (transaction) => {
      const conversation = await createConversation(transaction, fixture.tenantId, { channel: "whatsapp", patientId });
      await appendMessages(transaction, fixture.tenantId, conversation.id, [
        { kind: "customer", blocks: [{ type: "text", text: words }] },
        { kind: "tool", blocks: [{ type: "tool_result", tool_use_id: "x", content: "{\"secret\":\"tool traffic\"}" }] },
        { kind: "assistant", blocks: [{ type: "text", text: "Noted." }] },
      ]);
      return conversation.id;
    });
  }
  const inTenant = <T>(work: (tenantDb: postgres.TransactionSql) => Promise<T>): Promise<T> => worker.begin(async (tenantDb) => {
    await tenantDb`select set_config('app.tenant_id', ${fixture.tenantId}, true)`;
    return work(tenantDb);
  }) as Promise<T>;

  it("puts what each side wrote in the customer's export, and nothing of the tool traffic", async () => {
    const customer = await createCustomer(owner, fixture.tenantId);
    await chatFor(customer.id, "I need a root canal consult, please");
    const data = await inTenant((tenantDb) => collectCustomerExport(tenantDb, fixture.tenantId, customer.id, new Date()));
    const chats = JSON.stringify(data.assistantChats);
    expect(chats).toContain("root canal consult");
    expect(chats).toContain("Noted.");
    expect(chats).not.toContain("tool traffic");
  });

  it("reads a chat that holds both the old block format and the AI SDK format, in the export and in the visible lines", async () => {
    const customer = await createCustomer(owner, fixture.tenantId);
    const chatId = await chatFor(customer.id, "an old question about braces");
    await withTenant(fixture.tenantId, (transaction) => appendMessages(transaction, fixture.tenantId, chatId, [
      { kind: "customer", blocks: [], ui: { id: "q1", role: "user", parts: [{ type: "text", text: "a new question about aligners" }] } },
      { kind: "assistant", blocks: [], ui: { id: "a1", role: "assistant", parts: [{ type: "step-start" }, { type: "tool-find_times", toolCallId: "c1", state: "output-available", input: {}, output: { secret: "tool traffic" } }, { type: "text", text: "Aligners take about a year." }] } },
    ]));
    const lines = await withTenant(fixture.tenantId, async (transaction) => visibleLines(await loadHistory(transaction, fixture.tenantId, chatId)));
    expect(lines.map((line) => line.text)).toEqual(["an old question about braces", "Noted.", "a new question about aligners", "Aligners take about a year."]);
    const ui = await withTenant(fixture.tenantId, (transaction) => loadUiHistory(transaction, fixture.tenantId, chatId));
    expect(ui.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(ui[3]!.parts.map((part) => part.type)).toEqual(["step-start", "tool-find_times", "text"]);
    const data = await inTenant((tenantDb) => collectCustomerExport(tenantDb, fixture.tenantId, customer.id, new Date()));
    const chats = JSON.stringify(data.assistantChats);
    expect(chats).toContain("old question about braces");
    expect(chats).toContain("new question about aligners");
    expect(chats).toContain("Aligners take about a year.");
    expect(chats).not.toContain("tool traffic");
  });

  it("removes a customer's chats when they are erased, and leaves other customers' chats", async () => {
    const gone = await createCustomer(owner, fixture.tenantId);
    const kept = await createCustomer(owner, fixture.tenantId);
    await chatFor(gone.id, "erase this chat");
    const keptChat = await chatFor(kept.id, "keep this chat");
    const [request] = await owner<{ id: string }[]>`insert into data_requests (tenant_id, patient_id, type, status, note) values (${fixture.tenantId}, ${gone.id}, 'erasure', 'approved', 'test') returning id`;
    await inTenant((tenantDb) => eraseCustomer(tenantDb, fixture.tenantId, request!.id, new Date()));
    expect(await owner`select id from assistant_conversations where tenant_id = ${fixture.tenantId} and patient_id = ${gone.id}`).toHaveLength(0);
    expect(await owner`select id from assistant_conversations where id = ${keptChat}`).toHaveLength(1);
  });

  it("deletes chats older than the owner's retention, and keeps newer ones", async () => {
    const customer = await createCustomer(owner, fixture.tenantId);
    const old = await chatFor(customer.id, "an old chat");
    const recent = await chatFor(customer.id, "a recent chat");
    await owner`insert into assistant_settings (tenant_id, retention_days) values (${fixture.tenantId}, 30) on conflict (tenant_id) do update set retention_days = 30`;
    await owner`update assistant_conversations set last_activity_at = now() - interval '45 days' where id = ${old}`;
    await applyRetention(worker);
    expect(await owner`select id from assistant_conversations where id = ${old}`).toHaveLength(0);
    expect(await owner`select id from assistant_conversations where id = ${recent}`).toHaveLength(1);
    // The messages went with the chat.
    expect(await owner`select id from assistant_messages where conversation_id = ${old}`).toHaveLength(0);
  });
});
