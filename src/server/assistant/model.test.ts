/** @vitest-environment node */
import { generateText, isStepCount, streamText, tool } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));

import { aiTool, isFailureOutput } from "./ai-tools";
import {
  assistantMode, createLiveModel, hasAssistantModel, instructions, LlmUnavailableError, modelCallSettings, promptToRequest, resolveAssistantModel, setAssistantLanguageModelForTests,
  setAssistantModelForTests, unavailableReason, usageOf, wrapClient,
} from "./model";
import { createScriptedModel } from "./scripted-model";

afterEach(() => {
  setAssistantModelForTests(null);
  setAssistantLanguageModelForTests(null);
  vi.unstubAllEnvs();
});

/** The provider is pointed at a stub `fetch`: the test sees exactly what would be sent, and nothing leaves the machine. */
function stubFetch(respond: () => { status: number; body: unknown }) {
  const received: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
    received.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const answer = respond();
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, received };
}

const lookup = tool({ description: "Look up the services.", inputSchema: z.object({}), execute: async () => ({ services: [] }) });

describe("the real model, through the AI SDK, against a stub", () => {
  it("sends the cached rules first and the date after the cache breakpoint, with the fixed tools and nothing that models of this generation reject", async () => {
    const stub = stubFetch(() => ({
      status: 200,
      body: {
        id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_sequence: null,
        content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "Hello." }],
        usage: { input_tokens: 120, output_tokens: 30, cache_creation_input_tokens: 40, cache_read_input_tokens: 900 },
      },
    }));
    const live = createLiveModel("claude-sonnet-5-5", { apiKey: "test-key", fetch: stub.fetch, baseURL: "http://127.0.0.1:1" });
    const result = await generateText({
      model: live.model, instructions: instructions("RULES", "TODAY"), messages: [{ role: "user", content: "hello" }], tools: { list_services: lookup },
      maxOutputTokens: 1500, ...modelCallSettings(), timeout: 30_000,
    });
    const sent = stub.received[0]!;
    expect(sent.url).toBe("http://127.0.0.1:1/messages");
    expect(sent.body.model).toBe("claude-sonnet-5-5");
    const system = sent.body.system as Array<{ text: string; cache_control?: { type: string } }>;
    expect(system.map((block) => block.text)).toEqual(["RULES", "TODAY"]);
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(system[1]!.cache_control).toBeUndefined();
    expect((sent.body.tools as Array<{ name: string }>).map((entry) => entry.name)).toEqual(["list_services"]);
    for (const rejected of ["temperature", "top_p", "top_k", "budget_tokens"]) expect(JSON.stringify(sent.body)).not.toContain(rejected);
    // Automatic tool choice only: a forced tool is refused by models that think.
    expect(sent.body.tool_choice).toEqual({ type: "auto" });
    expect(sent.body.output_config).toEqual({ effort: "low" });
    expect(sent.headers["x-api-key"]).toBe("test-key");

    expect(result.text).toBe("Hello.");
    expect(usageOf(result.usage)).toEqual({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 900, cacheWriteTokens: 40 });
  });

  it.each([
    [429, "rate_limited"],
    [401, "not_configured"],
    [403, "not_configured"],
    [400, "rejected"],
    [404, "rejected"],
    [500, "network"],
  ] as const)("turns a %i failure into the plain reason %s, never the provider's text", async (status, reason) => {
    const stub = stubFetch(() => ({ status, body: { type: "error", error: { type: "api_error", message: "SECRET prompt text echoed back" } } }));
    const live = createLiveModel("claude-sonnet-5-5", { apiKey: "k", fetch: stub.fetch });
    const failure = await generateText({ model: live.model, instructions: instructions("RULES", "TODAY"), messages: [{ role: "user", content: "hi" }], ...modelCallSettings(), timeout: 30_000, maxRetries: 0 }).catch((error: unknown) => error);
    expect(unavailableReason(failure)).toBe(reason);
    const mapped = new LlmUnavailableError(unavailableReason(failure));
    expect(mapped.message).not.toContain("SECRET");
  });

  it("reports a refusal and a cut-off answer as the finish reasons the turn treats as failed", async () => {
    for (const [stop, finish] of [["refusal", "content-filter"], ["max_tokens", "length"]] as const) {
      const stub = stubFetch(() => ({
        status: 200,
        body: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason: stop, stop_sequence: null, content: [], usage: { input_tokens: 1, output_tokens: 0 } },
      }));
      const live = createLiveModel("claude-haiku-5-5", { apiKey: "k", fetch: stub.fetch });
      const result = await generateText({ model: live.model, instructions: instructions("S", "V"), messages: [{ role: "user", content: "hi" }], ...modelCallSettings(), timeout: 30_000 });
      expect(result.finishReason).toBe(finish);
    }
  });

  it("never keeps a network failure's own words", () => {
    expect(unavailableReason(new Error("SECRET connection reset"))).toBe("network");
    expect(unavailableReason(new LlmUnavailableError("bad_response"))).toBe("bad_response");
  });
});

describe("the instructions", () => {
  it("put the rules first with the cache breakpoint and today's date after it", () => {
    expect(instructions("RULES", "TODAY")).toEqual([
      { role: "system", content: "RULES", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
      { role: "system", content: "TODAY" },
    ]);
  });
});

describe("what state the model is in", () => {
  it("is live with a key, fake in fake mode, off otherwise, and on whenever a test installed a model", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ASSISTANT_PROVIDER_MODE", "");
    expect(assistantMode()).toBe("off");
    expect(hasAssistantModel()).toBe(false);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    expect(assistantMode()).toBe("live");
    expect(hasAssistantModel()).toBe(true);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ASSISTANT_PROVIDER_MODE", "fake");
    expect(assistantMode()).toBe("fake");
    vi.stubEnv("ASSISTANT_PROVIDER_MODE", "");
    setAssistantModelForTests(createScriptedModel([() => [{ type: "text", text: "x" }]]));
    expect(hasAssistantModel()).toBe(true);
  });
});

describe("a scripted model", () => {
  it("replays its answers in order, repeats the last one, and shows the test what it was asked", async () => {
    const scripted = createScriptedModel([() => [{ type: "text", text: "one" }], () => [{ type: "text", text: "two" }]]);
    const request = { model: "m", stableSystem: "S", volatileSystem: "V", tools: [], messages: [{ role: "user" as const, content: "hi" }], maxTokens: 10 };
    expect((await scripted.complete(request)).content).toEqual([{ type: "text", text: "one" }]);
    expect((await scripted.complete(request)).content).toEqual([{ type: "text", text: "two" }]);
    const third = await scripted.complete(request);
    expect(third.content).toEqual([{ type: "text", text: "two" }]);
    expect(third.stopReason).toBe("end_turn");
    expect(third.usage.inputTokens).toBeGreaterThan(0);
    expect(scripted.calls).toHaveLength(3);
  });
});

describe("choosing the model", () => {
  it("is off with no key, wraps a model a test installs, and runs the local rule-based model in fake mode", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ASSISTANT_PROVIDER_MODE", "");
    expect(await resolveAssistantModel("staff")).toBeNull();
    expect(await resolveAssistantModel("customer")).toBeNull();

    setAssistantModelForTests(createScriptedModel([() => [{ type: "text", text: "hi" }]]));
    const installed = await resolveAssistantModel("staff");
    expect(installed?.mode).toBe("fake");
    expect(installed?.modelId).toBe("claude-sonnet-5-5");
    setAssistantModelForTests(null);

    vi.stubEnv("ASSISTANT_PROVIDER_MODE", "fake");
    expect((await resolveAssistantModel("customer"))?.mode).toBe("fake");
    expect((await resolveAssistantModel("customer"))?.modelId).toBe("claude-haiku-5-5");
  });

  it("uses the real provider when a key is set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    vi.stubEnv("ASSISTANT_PROVIDER_MODE", "");
    const chosen = await resolveAssistantModel("staff");
    expect(chosen?.mode).toBe("live");
    expect(chosen?.modelId).toBe("claude-sonnet-5-5");
  });
});

describe("a scripted or local model, wrapped for the AI SDK", () => {
  it("streams text and tool calls, runs the tool, and hands the scripted model the plain messages it has always read", async () => {
    const scripted = createScriptedModel([
      () => [{ type: "tool_use", id: "t1", name: "echo", input: { word: "ok" } }],
      () => [{ type: "text", text: "Done." }],
    ]);
    const { model } = await wrapClient(scripted, "claude-sonnet-5-5");
    const echo = aiTool({ description: "Echo.", inputSchema: z.object({ word: z.string() }), run: async (input) => ({ text: JSON.stringify({ said: input.word }), isError: false }) });
    const result = streamText({ model, instructions: instructions("You are the staff copilot.", "Today."), messages: [{ role: "user", content: "say ok" }], tools: { echo }, stopWhen: isStepCount(4) });
    expect(await result.text).toBe("Done.");
    expect(scripted.calls).toHaveLength(2);
    const second = scripted.calls[1]!;
    expect(second.stableSystem).toBe("You are the staff copilot.");
    expect(second.volatileSystem).toBe("Today.");
    expect(second.tools.map((entry) => entry.name)).toEqual(["echo"]);
    const last = second.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toEqual([{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify({ said: "ok" }) }]);
  });

  it("answers generateText too, with the tool call and the usage", async () => {
    const scripted = createScriptedModel([() => [{ type: "tool_use", id: "t1", name: "echo", input: { word: "hi" } }]]);
    const { model } = await wrapClient(scripted, "claude-haiku-5-5");
    const result = await generateText({ model, instructions: instructions("S", "V"), messages: [{ role: "user", content: "go" }], tools: { echo: lookup }, stopWhen: isStepCount(1) });
    expect(result.toolCalls.map((entry) => entry.toolName)).toEqual(["echo"]);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it("reports a failing tool to the model as an error result", async () => {
    const scripted = createScriptedModel([() => [{ type: "tool_use", id: "t1", name: "echo", input: {} }], () => [{ type: "text", text: "Sorry." }]]);
    const { model } = await wrapClient(scripted, "claude-sonnet-5-5");
    const echo = aiTool({ description: "Echo.", inputSchema: z.object({}), run: async () => ({ text: JSON.stringify({ error: "Nope." }), isError: true }) });
    await streamText({ model, instructions: instructions("S", "V"), messages: [{ role: "user", content: "go" }], tools: { echo }, stopWhen: isStepCount(4) }).text;
    expect(scripted.calls[1]!.messages.at(-1)!.content).toEqual([{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify({ error: "Nope." }), is_error: true }]);
    expect(isFailureOutput({ error: "x" })).toBe(true);
    expect(isFailureOutput({ ok: true })).toBe(false);
  });

  it("comes out of the stream as an error the caller can reduce to a reason", async () => {
    const broken = createScriptedModel([() => { throw new LlmUnavailableError("rate_limited"); }]);
    const { model } = await wrapClient(broken, "claude-sonnet-5-5");
    const errors: unknown[] = [];
    const result = streamText({ model, instructions: instructions("S", "V"), messages: [{ role: "user", content: "go" }], onError: ({ error }) => { errors.push(error); } });
    await result.consumeStream();
    expect(unavailableReason(errors[0])).toBe("rate_limited");
  });

  it("maps the prompt back to plain messages, with tool results as user turns", async () => {
    const { model } = await wrapClient(createScriptedModel([() => [{ type: "text", text: "x" }]]), "m");
    const options = {
      prompt: [
        { role: "system" as const, content: "A" },
        { role: "system" as const, content: "B" },
        { role: "user" as const, content: [{ type: "text" as const, text: "q" }] },
        { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "find", input: { a: 1 } }] },
        { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "c1", toolName: "find", output: { type: "error-json" as const, value: { error: "bad" } } }] },
      ],
      tools: [{ type: "function" as const, name: "find", description: "d", inputSchema: { type: "object" as const } }],
    };
    expect(model.modelId).toBe("m");
    const request = promptToRequest(options as never, "m");
    expect(request.stableSystem).toBe("A");
    expect(request.volatileSystem).toBe("B");
    expect(request.messages[1]).toEqual({ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "find", input: { a: 1 } }] });
    expect(request.messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: JSON.stringify({ error: "bad" }), is_error: true }] });
    expect(request.tools).toEqual([{ name: "find", description: "d", input_schema: { type: "object" } }]);
  });
});
