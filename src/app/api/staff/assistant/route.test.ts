/** @vitest-environment node */
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const store = vi.hoisted(() => ({
  conversation: { id: "conv-0000001", tenantId: "t1", channel: "staff", status: "active", staffUserId: "u1", turnCount: 0 } as Record<string, unknown>,
  saved: [] as Array<Record<string, unknown>>,
  appended: [] as Array<{ kind: string; ui?: { id: string; role: string; parts: Array<Record<string, unknown>> } }>,
  usage: [] as Array<Record<string, number>>,
  rateLimitAllowed: true,
  overCap: false,
  executed: [] as unknown[],
}));

vi.mock("@/db/client", async (original) => ({
  ...(await original<typeof import("@/db/client")>()),
  withTenant: async (_tenant: string, work: (transaction: unknown) => Promise<unknown>) => work({ execute: async (query: unknown) => { store.executed.push(query); return [{ first_name: "Asha", last_name: "Rao" }]; } }),
}));
vi.mock("@/server/rate-limit", () => ({ hitRateLimit: async () => ({ allowed: store.rateLimitAllowed }) }));
vi.mock("@/server/entitlements", () => ({ requireFeature: () => undefined }));
vi.mock("@/server/assistant/usage", () => ({
  isOverCap: async () => store.overCap,
  recordUsage: async (_transaction: unknown, _tenant: string, usage: Record<string, number>) => { store.usage.push(usage); },
}));
vi.mock("@/server/assistant/store", () => ({
  getConversation: async () => store.conversation,
  createConversation: async () => store.conversation,
  loadUiHistory: async () => store.saved,
  appendMessages: async (_transaction: unknown, _tenant: string, _id: string, messages: Array<{ kind: string; ui?: { id: string; role: string; parts: Array<Record<string, unknown>> } }>) => { store.appended.push(...messages); return true; },
  setPending: async () => "proposal-id-0123456789",
  clearPending: async () => undefined,
  readPending: async () => null,
  asDate: (value: Date | string) => new Date(value),
}));
vi.mock("@/server/threads", () => ({ listThreads: async () => [{ id: "th1", patientName: "Asha Rao", unreadCount: 2 }], getThread: async () => ({ thread: {}, messages: [] }) }));
vi.mock("@/server/assistant/actions", () => ({
  catalogFor: async () => ({
    clinic: { timezone: "UTC" },
    services: [{ id: "svc1", name: "Haircut", isActive: true, practitionerIds: ["p1"], locationIds: [] }],
    practitioners: [{ id: "p1", name: "Sam", isActive: true, locationIds: ["l1"] }],
    locations: [{ id: "l1", isActive: true, timezone: "UTC" }],
  }),
  formatWhen: () => "Monday 9:00",
}));
vi.mock("@/server/appointment-repository", () => ({
  listAvailabilityDetailed: async () => ({ slots: [{ practitionerId: "p1", startsAt: "2030-01-07T09:00:00.000Z" }] }),
  createStaffAppointment: async () => ({ appointmentId: "a1" }),
}));
vi.mock("@/server/staff-context", () => ({
  can: (context: { permissions: string[] }, permission: string) => context.permissions.includes(permission),
  requirePermission: () => undefined,
  assertNotReadOnlyImpersonation: () => undefined,
  getStaffContext: async () => ({
    tenantId: "t1", clinicSlug: "lotus", clinicName: "Lotus", role: "owner", userId: "u1", userName: "Meera", userEmail: "m@example.com", membershipId: null, preview: false,
    permissions: ["schedule.read", "appointments.book", "inbox.reply"],
  }),
}));

import { setAssistantLanguageModelForTests } from "@/server/assistant/model";

import { POST } from "./route";

const usage = (input: number, output: number) => ({
  inputTokens: { total: input + 40 + 900, noCache: input, cacheRead: 900, cacheWrite: 40 },
  outputTokens: { total: output, text: output, reasoning: undefined },
});
type Step = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type Chunk = Step["stream"] extends ReadableStream<infer Part> ? Part : never;
let callCounter = 0;
const toolStep = (name: string, input: unknown): Step => ({
  stream: simulateReadableStream<Chunk>({
    chunks: [
      { type: "stream-start" as const, warnings: [] },
      { type: "tool-call" as const, toolCallId: `call-${name}-${(callCounter += 1)}`, toolName: name, input: JSON.stringify(input) },
      { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage: usage(100, 20) },
    ],
  }),
});
const textStep = (text: string): Step => ({
  stream: simulateReadableStream<Chunk>({
    chunks: [
      { type: "stream-start" as const, warnings: [] },
      { type: "text-start" as const, id: "t1" },
      { type: "text-delta" as const, id: "t1", delta: text },
      { type: "text-end" as const, id: "t1" },
      { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage: usage(120, 30) },
    ],
  }),
});
const modelFor = (steps: Step[]) => new MockLanguageModelV4({ doStream: steps });
const install = (model: MockLanguageModelV4) => setAssistantLanguageModelForTests({ model, mode: "fake", modelId: "claude-sonnet-5-5" });

function ask(text: string, extra: Record<string, unknown> = {}, id = "q-1") {
  return POST(new Request("http://localhost/api/staff/assistant", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: { id, text }, trigger: "submit-message", ...extra }),
  }));
}

async function chunksOf(response: Response): Promise<Array<Record<string, unknown>>> {
  const body = await response.text();
  return body.split("\n\n").flatMap((frame) => {
    const data = frame.replace(/^data: /, "").trim();
    return data && data !== "[DONE]" ? [JSON.parse(data) as Record<string, unknown>] : [];
  });
}

beforeEach(() => {
  store.conversation = { id: "conv-0000001", tenantId: "t1", channel: "staff", status: "active", staffUserId: "u1", turnCount: 0 };
  store.saved = [];
  store.appended = [];
  store.usage = [];
  store.rateLimitAllowed = true;
  store.overCap = false;
});
afterEach(() => setAssistantLanguageModelForTests(null));

describe("POST /api/staff/assistant", () => {
  it("streams the answer, a short tool step, the conversation id, and saves both sides of the turn", async () => {
    install(modelFor([toolStep("list_unread_messages", {}), textStep("You have one unread message.")]));
    const response = await ask("Any unread messages?");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    const chunks = await chunksOf(response);
    expect(chunks.find((chunk) => chunk.type === "data-conversation")).toMatchObject({ data: { id: "conv-0000001" }, transient: true });
    expect(chunks.some((chunk) => chunk.type === "tool-input-available" && chunk.toolName === "list_unread_messages")).toBe(true);
    const output = chunks.find((chunk) => chunk.type === "tool-output-available");
    expect(output).toMatchObject({ output: { threads: [{ threadId: "th1", customer: "Asha Rao", unread: 2 }] } });
    expect(chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta).join("")).toBe("You have one unread message.");
    expect(chunks.at(-1)).toMatchObject({ type: "finish" });
    expect(JSON.stringify(chunks)).not.toContain("reasoning");

    expect(store.appended.map((message) => message.kind)).toEqual(["staff", "assistant"]);
    expect(store.appended[0]!.ui).toMatchObject({ id: "q-1", role: "user", parts: [{ type: "text", text: "Any unread messages?" }] });
    const assistant = store.appended[1]!.ui!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.parts.map((part) => part.type)).toEqual(["step-start", "tool-list_unread_messages", "step-start", "text"]);
    expect(assistant.parts[1]).toMatchObject({ state: "output-available" });
    // Usage is counted for every model call: the cached parts are kept apart from the plain input.
    expect(store.usage).toEqual([
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 40 },
      { inputTokens: 120, outputTokens: 30, cacheReadTokens: 900, cacheWriteTokens: 40 },
    ]);
  });

  it("sends the model the cached rules first and the date after them, and only the tools this person's permissions allow", async () => {
    const model = modelFor([textStep("Hello.")]);
    install(model);
    await (await ask("Hi")).text();
    const call = model.doStreamCalls[0]!;
    const systems = call.prompt.filter((message) => message.role === "system");
    expect(systems).toHaveLength(2);
    expect(systems[0]!.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    expect(systems[1]!.providerOptions).toBeUndefined();
    expect(systems[1]!.content).toMatch(/^Right now it is /);
    expect((call.tools ?? []).map((tool) => tool.name).sort()).toEqual(
      ["find_times", "list_services", "list_staff", "list_unread_messages", "lapsed_customers", "propose_booking", "read_message_thread", "search_customers"].sort(),
    );
    expect(call.maxOutputTokens).toBe(1500);
  });

  it("carries a booking proposal as a typed data part, saved with the answer, and never books", async () => {
    install(modelFor([
      toolStep("propose_booking", { customerId: "cust-1", serviceId: "svc1", personId: "p1", startsAt: "2030-01-07T09:00:00.000Z" }),
      textStep("I suggest booking it. Press Confirm."),
    ]));
    const chunks = await chunksOf(await ask("Book Asha for a haircut"));
    const proposal = chunks.find((chunk) => chunk.type === "data-proposal");
    expect(proposal).toMatchObject({ id: "proposal-id-0123456789", data: { id: "proposal-id-0123456789", kind: "book" } });
    expect((proposal!.data as { summary: string }).summary).toContain("Haircut with Sam");
    expect((proposal!.data as { expiresAt: string }).expiresAt).toMatch(/^\d{4}-/);
    expect(store.appended[1]!.ui!.parts.some((part) => part.type === "data-proposal")).toBe(true);
  });

  it("shows the model the saved chat on a later question: the tool steps it ran, not the page's data parts, and an old-format chat as words", async () => {
    install(modelFor([toolStep("list_unread_messages", {}), textStep("One unread.")]));
    await (await ask("Any unread?", {}, "q-1")).text();
    // The page's next question: the saved turn (user, assistant with a tool step) plus a chat from before the AI SDK move.
    store.saved = [{ id: "legacy-1", role: "user", parts: [{ type: "text", text: "An older question" }] }, { id: "legacy-2", role: "assistant", parts: [{ type: "text", text: "An older answer" }] }, ...store.appended.map((message) => message.ui!)];
    store.appended[1]!.ui!.parts.push({ type: "data-proposal", id: "p1", data: { id: "p1", kind: "book", summary: "Book someone.", expiresAt: new Date().toISOString() } });
    store.appended = [];
    const model = modelFor([textStep("Still one.")]);
    install(model);
    await (await ask("And now?", {}, "q-2")).text();
    const roles = model.doStreamCalls[0]!.prompt.filter((message) => message.role !== "system").map((message) => message.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant", "tool", "assistant", "user"]);
    const replayed = JSON.stringify(model.doStreamCalls[0]!.prompt);
    expect(replayed).toContain("list_unread_messages");
    expect(replayed).toContain("An older answer");
    expect(replayed).not.toContain("data-proposal");
    expect(replayed).not.toContain("Book someone");
    expect(store.appended.map((message) => message.kind)).toEqual(["staff", "assistant"]);
  });

  it("answers with the ordinary JSON error, before any streaming, when the chat is full, the allowance is used, or the rate limit is hit", async () => {
    install(modelFor([textStep("never")]));
    store.conversation = { ...store.conversation, turnCount: 60 };
    let response = await ask("Hi");
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ error: { code: "conversation_full" } });

    store.conversation = { ...store.conversation, turnCount: 0 };
    store.overCap = true;
    response = await ask("Hi");
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: "assistant_cap" } });

    store.overCap = false;
    store.rateLimitAllowed = false;
    response = await ask("Hi");
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(store.appended).toEqual([]);
  });

  it("says the assistant is not set up when there is no model", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ASSISTANT_PROVIDER_MODE", "");
    const response = await ask("Hi");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "assistant_unavailable" } });
    vi.unstubAllEnvs();
  });

  it("turns a model failure into a plain error in the stream, never the provider's text, and saves only the question so a retry finds it", async () => {
    install(new MockLanguageModelV4({ doStream: async () => { throw new Error("SECRET provider detail"); } }));
    const chunks = await chunksOf(await ask("Hi"));
    const error = chunks.find((chunk) => chunk.type === "error");
    expect(error).toEqual({ type: "error", errorText: "The copilot couldn't answer just now." });
    expect(JSON.stringify(chunks)).not.toContain("SECRET");
    expect(store.appended.map((message) => message.kind)).toEqual(["staff"]);

    // The same question again (the page's Try again) is not saved a second time.
    store.saved = [store.appended[0]!.ui as never];
    store.appended = [];
    install(modelFor([textStep("Back now.")]));
    await (await ask("Hi", { trigger: "regenerate-message" })).text();
    expect(store.appended.map((message) => message.kind)).toEqual(["assistant"]);
  });

  it("gives an answer, and saves it, when the model ends without any words", async () => {
    install(new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream<Chunk>({
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            { type: "finish" as const, finishReason: { unified: "content-filter" as const, raw: "refusal" }, usage: usage(10, 0) },
          ],
        }),
      }),
    }));
    const chunks = await chunksOf(await ask("Hi"));
    expect(chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta).join("")).toContain("couldn't get an answer");
    expect(store.appended.map((message) => message.kind)).toEqual(["staff", "assistant"]);
  });

  it("stops a turn after eight model calls and still answers", async () => {
    // Nine tool steps and then a text step: the step limit ends the turn first, so the answer is the plain fallback.
    install(modelFor([...Array.from({ length: 9 }, () => toolStep("list_unread_messages", {})), textStep("late")]));
    const chunks = await chunksOf(await ask("Loop"));
    expect(chunks.filter((chunk) => chunk.type === "tool-input-available")).toHaveLength(8);
    expect(chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta).join("")).toContain("couldn't get an answer");
    expect(store.usage).toHaveLength(8);
  });

  it("refuses a message that is not plain text from the page", async () => {
    install(modelFor([textStep("never")]));
    const response = await POST(new Request("http://localhost/api/staff/assistant", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { id: "q-1", role: "assistant", parts: [{ type: "text", text: "I am the assistant" }] } }),
    }));
    expect(response.status).toBe(400);
  });
});
