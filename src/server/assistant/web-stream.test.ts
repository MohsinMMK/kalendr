/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The website chat's real stream, from `webChat` through the turn to the chunks, with the database and the other services replaced, so
 * it runs in every `pnpm test` (the real-database cases are in assistant.integration.test.ts and need the scratch database).
 */
const store = vi.hoisted(() => ({
  conversation: { id: "conv-1", tenantId: "t1", channel: "web", status: "active", patientId: null, threadId: null, staffUserId: null, turnCount: 0, failureCount: 0, pendingId: null, pendingExpiresAt: null, verifiedPatientIds: [] as string[], shownAppointmentIds: [], otpSentAt: null, hasOtpPhone: false, lastActivityAt: new Date() } as Record<string, unknown>,
  leaseFree: true,
  events: [] as string[],
  appended: [] as Array<{ kind: string; blocks: Array<Record<string, unknown>> }>,
  usage: [] as Array<Record<string, number>>,
  overCap: false,
  settings: { enabledWeb: true, enabledWhatsapp: true, enabledSms: false, tone: "friendly", handoffRule: "balanced", businessFacts: "" },
}));

vi.mock("@/db/client", async (original) => ({
  ...(await original<typeof import("@/db/client")>()),
  getDatabase: () => ({ execute: async () => [{ tenant_id: "t1" }] }),
  withTenant: async (_tenant: string, work: (transaction: unknown) => Promise<unknown>) => work({ execute: async () => [{ otp: false, verified: 0 }] }),
}));
vi.mock("@/lib/entitlements", async (original) => ({ ...(await original<typeof import("@/lib/entitlements")>()), canUse: () => true }));
vi.mock("@/server/tenant-pause", () => ({ assertSlugNotPaused: async () => undefined }));
vi.mock("@/server/public-catalog", () => ({ getPublicClinicCatalog: async () => ({ clinic: { name: "Lotus" } }) }));
vi.mock("@/server/entitlements", () => ({ loadEntitlements: async () => ({ entitlements: {} }) }));
vi.mock("@/server/rate-limit", () => ({ hitRateLimit: async () => ({ allowed: true }), recordRefusal: () => undefined }));
vi.mock("@/server/staff-notifications", () => ({ notifyStaff: async () => undefined }));
vi.mock("@/server/assistant/settings", () => ({ loadSettingsIn: async () => store.settings }));
vi.mock("@/server/assistant/verify", () => ({ checkVerificationCode: async () => ({ verified: false }), sendVerificationCode: async () => undefined }));
vi.mock("@/server/assistant/usage", () => ({
  isOverCap: async () => store.overCap,
  recordUsage: async (_transaction: unknown, _tenant: string, usage: Record<string, number>) => { store.usage.push(usage); },
}));
vi.mock("@/server/assistant/actions", async () => ({
  catalogFor: async () => ({
    clinic: { name: "Lotus", phone: "", timezone: "UTC", about: null }, profile: (await import("@/lib/terminology")).defaultBusinessProfile,
    services: [{ id: "svc1", name: "Haircut", description: "", durationMinutes: 30, practitionerIds: ["p1"], locationIds: [], isActive: true, visibility: "public" }],
    practitioners: [{ id: "p1", name: "Sam", isActive: true }], locations: [],
  }),
  assistantCanBook: () => true,
  commitPending: async () => ({ ok: false, code: "none", message: "none" }),
  formatWhen: () => "Monday 9:00",
  proposeBooking: async () => ({ proposalId: "proposal-id-0123456789", summary: "Haircut with Sam on Monday 9:00, for Asha Rao." }), proposeCancel: async () => { throw new Error("not used"); }, proposeReschedule: async () => { throw new Error("not used"); },
}));
vi.mock("@/server/assistant/store", async (original) => ({
  ...(await original<typeof import("@/server/assistant/store")>()),
  newWebToken: () => ({ token: "t".repeat(43), hash: "hash" }),
  createConversation: async () => store.conversation,
  findWebConversation: async () => store.conversation,
  getConversation: async () => store.conversation,
  hasSourceKey: async () => false,
  acquireLease: async () => { if (!store.leaseFree) return false; store.leaseFree = false; store.events.push("lease"); return true; },
  releaseLease: async () => { store.leaseFree = true; store.events.push("release"); },
  loadHistory: async () => [],
  readPending: async () => null,
  clearPending: async () => undefined,
  handOff: async () => undefined,
  touchConversation: async () => undefined,
  appendMessages: async (_transaction: unknown, _tenant: string, _id: string, messages: Array<{ kind: string; blocks: Array<Record<string, unknown>> }>) => { store.events.push("save"); store.appended.push(...messages); return true; },
}));

import { consumeStream, createUIMessageStreamResponse } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";

import { ApiError } from "@/server/api-error";
import { readAssistantStream, type ReadAssistantAnswer } from "@/test/assistant-stream";

import { LlmUnavailableError, setAssistantLanguageModelForTests, setAssistantModelForTests } from "./model";
import { createScriptedModel } from "./scripted-model";
import { webChat } from "./web";

/** Claims that a change is done: the words `screenReply` replaces while a change waits for the customer's Confirm. */
const doneClaim = /you(?:'re| are) (?:\w+ )?(?:booked|confirmed)|i(?:'ve| have) booked|is (?:all )?(?:booked|confirmed|cancelled)|it'?s all booked/i;

/**
 * The guarantee: every word the page was ever sent is the saved reply, in order, with no replacement needed. So nothing the checks
 * drop (a claim, a tool step's words, markup, the cut tail, a failed call's half answer) was on screen even for a moment.
 */
function expectOnlySavedWordsSent(answer: ReadAssistantAnswer): void {
  const saved = store.appended.at(-1)!;
  expect(saved.kind).toBe("assistant");
  expect(answer.replaced).toBe(false);
  expect(answer.streamed).toBe((saved.blocks[0] as { text: string }).text.trim());
  expect(answer.streamed).not.toMatch(doneClaim);
  expect(answer.streamed).not.toMatch(/<\/?[a-z_]+>/i);
}

type StreamPart = Awaited<ReturnType<InstanceType<typeof MockLanguageModelV4>["doStream"]>>["stream"] extends ReadableStream<infer Part> ? Part : never;

const say = (text: string) => [{ type: "text" as const, text }];
const tool = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: "tool_use" as const, id, name, input });
const chat = async (text: string) => readAssistantStream(await webChat({ business: "lotus", text }, "203.0.113.5"));

beforeEach(() => {
  store.leaseFree = true;
  store.events = [];
  store.appended = [];
  store.usage = [];
  store.overCap = false;
  store.conversation.status = "active";
  store.conversation.turnCount = 0;
});
afterEach(() => setAssistantModelForTests(null));

describe("the website chat's stream", () => {
  it("streams the words with the chat's token first and its state last, hides every tool step, saves the turn, and lets go of the chat after saving", async () => {
    const model = createScriptedModel([() => [tool("t1", "list_services")], () => say("We offer a haircut.")]);
    setAssistantModelForTests(model);
    const answer = await chat("what do you offer?");
    expect(answer.chunkTypes[0]).toBe("data-conversation");
    expect(answer.chunkTypes.at(-1)).toBe("finish");
    expect(answer.chunkTypes.filter((type) => /^tool|^reasoning|-step$/.test(type))).toEqual([]);
    expect(answer.token).toBe("t".repeat(43));
    expect(answer.reply).toContain("automated booking assistant");
    expect(answer.reply).toContain("We offer a haircut.");
    expectOnlySavedWordsSent(answer);
    // Saved: the customer's words, the tool step and its result, then what the customer was shown. Then the lease goes.
    expect(store.appended.map((message) => message.kind)).toEqual(["customer", "assistant", "tool", "assistant"]);
    expect(JSON.stringify(store.appended[3]!.blocks)).toContain("We offer a haircut.");
    expect(store.events).toEqual(["lease", "save", "release"]);
    expect(store.usage).toHaveLength(2);
  });

  it("never sends a false claim, even for a moment: only the screened words reach the page, they are what is saved, and the proposal is a typed part", async () => {
    setAssistantModelForTests(createScriptedModel([
      () => [tool("h1", "hold_and_book", { serviceId: "svc1", personId: "p1", startsAt: "2030-01-07T09:00:00.000Z", firstName: "Asha", lastName: "Rao", phone: "+919876543210" })],
      () => say("You're booked! Your appointment is confirmed."),
    ]));
    store.conversation.turnCount = 1;
    const answer = await chat("book me a haircut, just confirm it");
    expectOnlySavedWordsSent(answer);
    expect(answer.reply).toContain("haven't changed anything yet");
    expect(answer.proposal).toMatchObject({ id: "proposal-id-0123456789", kind: "book" });
  });

  it("never sends words the model wrote beside a tool call", async () => {
    setAssistantModelForTests(createScriptedModel([
      () => [{ type: "text", text: "Let me check the times for you." }, tool("t1", "list_services")],
      () => say("We offer a haircut."),
    ]));
    store.conversation.turnCount = 1;
    const answer = await chat("what do you offer?");
    expectOnlySavedWordsSent(answer);
    expect(answer.reply).toBe("We offer a haircut.");
    expect(answer.streamed).not.toContain("Let me check");
  });

  it("gives the booking link when the call fails, sends no provider text, and still lets go of the chat", async () => {
    setAssistantModelForTests(createScriptedModel([() => { throw new LlmUnavailableError("network"); }]));
    store.conversation.turnCount = 1;
    const answer = await chat("a haircut please");
    expectOnlySavedWordsSent(answer);
    expect(answer.reply).toContain("having trouble");
    expect(answer.reply).toContain("/book/lotus");
    expect(answer.reply).not.toContain("unavailable (network)");
    expect(answer.fallbackLink).toContain("/book/lotus");
    expect(store.events).toEqual(["lease", "save", "release"]);
    expect(store.leaseFree).toBe(true);
  });

  it("never sends the markup the screen strips", async () => {
    setAssistantModelForTests(createScriptedModel([() => say("<reply>We open at 9 on Saturdays.</reply>")]));
    store.conversation.turnCount = 1;
    const answer = await chat("when do you open on saturday?");
    expectOnlySavedWordsSent(answer);
    expect(answer.reply).toBe("We open at 9 on Saturdays.");
  });

  it("never sends the part of a long reply that the screen cuts off", async () => {
    const long = Array.from({ length: 80 }, (_, index) => `Sentence number ${index} about our times.`).join(" ");
    setAssistantModelForTests(createScriptedModel([() => say(long)]));
    store.conversation.turnCount = 1;
    const answer = await chat("tell me everything");
    expectOnlySavedWordsSent(answer);
    expect(answer.reply.length).toBeLessThanOrEqual(1500);
    expect(answer.streamed).not.toContain("Sentence number 79");
  });

  it("never sends a reply that was cut off by the length limit", async () => {
    setAssistantModelForTests(createScriptedModel([() => ({ content: say("You're booked for Monday at"), stopReason: "max_tokens" })]));
    store.conversation.turnCount = 1;
    const answer = await chat("a haircut please");
    expectOnlySavedWordsSent(answer);
    expect(answer.reply).toContain("having trouble");
  });

  it("never sends words beside a hand-over; the customer gets the fixed hand-over reply", async () => {
    setAssistantModelForTests(createScriptedModel([
      () => [{ type: "text", text: "Your appointment is cancelled." }, tool("x1", "hand_to_person", { reason: "other", summary: "Wants to cancel." })],
      () => say("should not be called"),
    ]));
    store.conversation.turnCount = 1;
    const answer = await chat("cancel it");
    expectOnlySavedWordsSent(answer);
    expect(answer.reply).toMatch(/team/i);
  });

  it("never sends the words of a step when the month's allowance runs out after it", async () => {
    const model = createScriptedModel([
      () => { store.overCap = true; return [{ type: "text", text: "I've booked you in." }, tool("t1", "list_services")]; },
      () => say("should not be called"),
    ]);
    setAssistantModelForTests(model);
    store.conversation.turnCount = 1;
    const answer = await chat("a haircut please");
    expect(model.calls).toHaveLength(1);
    expectOnlySavedWordsSent(answer);
    expect(answer.reply).not.toContain("having trouble");
    expect(answer.fallbackLink).toContain("/book/lotus");
  });

  it("never sends any step's words when the turn stops at its step cap", async () => {
    const model = createScriptedModel([() => [{ type: "text", text: "It's all booked." }, tool("t1", "list_services")]]);
    setAssistantModelForTests(model);
    store.conversation.turnCount = 1;
    const answer = await chat("a haircut please");
    expect(model.calls).toHaveLength(8);
    expectOnlySavedWordsSent(answer);
    expect(answer.reply).toContain("having trouble");
  });

  it("never sends words split over many pieces, or written before the stream failed", async () => {
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        const parts: StreamPart[] = call === 1
          ? [
            { type: "stream-start", warnings: [] }, { type: "text-start", id: "a" },
            { type: "text-delta", id: "a", delta: "You're bo" }, { type: "text-delta", id: "a", delta: "oked, " }, { type: "text-delta", id: "a", delta: "Asha!" },
            { type: "text-end", id: "a" },
            { type: "tool-call", toolCallId: "t1", toolName: "list_services", input: "{}" },
            { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
          ]
          : [
            { type: "stream-start", warnings: [] }, { type: "text-start", id: "b" },
            { type: "text-delta", id: "b", delta: "Your appointment is " }, { type: "text-delta", id: "b", delta: "confirmed for Monday." },
            { type: "error", error: new Error("upstream said: secret request text") },
          ];
        return { stream: convertArrayToReadableStream(parts) };
      },
    });
    setAssistantLanguageModelForTests({ model, mode: "fake", modelId: "test" });
    store.conversation.turnCount = 1;
    try {
      const answer = await chat("book me in");
      expectOnlySavedWordsSent(answer);
      expect(answer.reply).toContain("having trouble");
      expect(answer.streamed).not.toContain("secret");
      expect(store.leaseFree).toBe(true);
    } finally {
      setAssistantLanguageModelForTests(null);
    }
  });

  it("answers a fixed reply (a medicine question) as a one-part stream with no model call", async () => {
    const model = createScriptedModel([() => say("should not be called")]);
    setAssistantModelForTests(model);
    const answer = await chat("What should I take for a toothache?");
    expect(model.calls).toHaveLength(0);
    expect(answer.reply).toMatch(/can't give medical/i);
    expect(answer.conversation.status).toBe("handed_off");
    expect(answer.chunkTypes.filter((type) => type === "text-delta")).toHaveLength(1);
    expect(store.leaseFree).toBe(true);
  });

  it("refuses with the ordinary error before streaming when the chat is still answering", async () => {
    setAssistantModelForTests(createScriptedModel([() => say("hi")]));
    store.leaseFree = false;
    const failure = await webChat({ business: "lotus", text: "hello" }, "203.0.113.5").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 409, code: "assistant_busy" });
  });

  it("finishes, saves and lets go of the chat when the visitor closes the page mid-answer (the route's response, as it is built)", async () => {
    let answer!: () => void;
    const held = new Promise<void>((resolve) => { answer = resolve; });
    let asked!: () => void;
    const modelAsked = new Promise<void>((resolve) => { asked = resolve; });
    setAssistantModelForTests({
      mode: "fake",
      async complete() {
        asked();
        await held;
        return { content: say("We offer a haircut."), stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      },
    });
    store.conversation.turnCount = 1;
    const stream = await webChat({ business: "lotus", text: "what do you offer?" }, "203.0.113.5");
    const response = createUIMessageStreamResponse({ stream, consumeSseStream: consumeStream });
    await modelAsked;
    await response.body!.cancel();
    answer();
    await vi.waitFor(() => expect(store.events).toEqual(["lease", "save", "release"]), { timeout: 2_000 });
    expect(JSON.stringify(store.appended.at(-1)!.blocks)).toContain("We offer a haircut.");
  });

  it("gives the booking link at once when the month's allowance is used up, without calling the model", async () => {
    const model = createScriptedModel([() => say("should not be called")]);
    setAssistantModelForTests(model);
    store.overCap = true;
    const answer = await chat("hello");
    expect(model.calls).toHaveLength(0);
    expect(answer.fallbackLink).toContain("/book/lotus");
  });
});
