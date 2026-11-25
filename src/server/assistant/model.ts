import "server-only";

import { createAnthropic } from "@ai-sdk/anthropic";
import { APICallError, RetryError, type LanguageModel, type LanguageModelUsage, type SystemModelMessage } from "ai";
import type { MockLanguageModelV4 } from "ai/test";

import { z } from "zod";

import { env } from "../env";
import { logger } from "../logger";

/**
 * The one door to the model (feature 30). The staff copilot, the website chat and the WhatsApp worker all go through it, so they share
 * the same settings and the same rules:
 *
 *  - live: the Anthropic provider, with the key from the environment;
 *  - fake (local runs and browser tests only, never in production): the rule-based local model, wrapped so the AI SDK can call it;
 *  - off: no key and not fake, so `resolveAssistantModel` returns null and callers show their plain fallback.
 *
 * The system prompt goes in as two messages. The stable part (rules, tools, the business's name and words) carries the cache
 * breakpoint; the volatile part (today's date) comes after it, so a new day never invalidates the cached prefix.
 */

// ---------------------------------------------------------------------------------------------------------------------------------
// Plain model blocks. Chats are kept in this shape in the sealed column, and the rule-based and scripted models speak it.

export const blockSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("tool_result"), tool_use_id: z.string(), content: z.string(), is_error: z.boolean().optional() }),
  // Thinking blocks of chats saved before the AI SDK move are kept as they were; they are never replayed.
  z.object({ type: z.literal("thinking"), thinking: z.string(), signature: z.string() }),
  z.object({ type: z.literal("redacted_thinking"), data: z.string() }),
]);
export type LlmBlock = z.infer<typeof blockSchema>;

export interface LlmMessage { role: "user" | "assistant"; content: string | LlmBlock[] }

export interface LlmTool { name: string; description: string; input_schema: Record<string, unknown> }

export interface LlmRequest {
  model: string;
  stableSystem: string;
  volatileSystem: string;
  tools: readonly LlmTool[];
  messages: readonly LlmMessage[];
  maxTokens: number;
}

export interface LlmUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }

export interface LlmResponse {
  content: LlmBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
  usage: LlmUsage;
}

/** What the rule-based local model and the scripted test models implement. `wrapClient` turns one into an AI SDK model. */
export interface LlmClient {
  readonly mode: "live" | "fake";
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** The model could not be reached or answered badly. The customer sees a plain fallback; the error text is never kept. */
export class LlmUnavailableError extends Error {
  constructor(readonly reason: "network" | "rate_limited" | "bad_response" | "not_configured" | "rejected") {
    super(`The assistant's model is unavailable (${reason}).`);
    this.name = "LlmUnavailableError";
  }
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** What state the model is in for this process: the real one, the local scripted one, or none. */
export type AssistantMode = "live" | "fake" | "off";

export function assistantMode(): AssistantMode {
  const settings = env();
  if (settings.ASSISTANT_PROVIDER_MODE === "fake") return "fake";
  return settings.ANTHROPIC_API_KEY ? "live" : "off";
}

/** A model that tests (and the local browser run) installed as plain blocks. It wins over everything, so a test never reaches the network. */
let installedClient: LlmClient | null = null;

export function setAssistantModelForTests(client: LlmClient | null): void {
  installedClient = client;
}

/** Whether a model is available at all: the process has a key, runs the fake model, or a test installed one. */
export function hasAssistantModel(): boolean {
  return installedClient !== null || languageModelOverride !== null || assistantMode() !== "off";
}

export type ModelKind = "customer" | "staff";

export interface AssistantLanguageModel {
  model: Exclude<LanguageModel, string>;
  mode: "live" | "fake";
  modelId: string;
}

/** The AI SDK's own words for "stop after this many model calls", so every caller caps a turn the same way. */
export const MAX_MODEL_STEPS = 8;

/**
 * The stable rules first, marked for caching; the date after the breakpoint. Pass the result as `instructions` to `streamText` or `generateText`.
 */
export function instructions(stable: string, volatile: string): SystemModelMessage[] {
  return [
    { role: "system", content: stable, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
    { role: "system", content: volatile },
  ];
}

/**
 * What every call to the model shares. Chat answers are short, so effort is low; a turn must end inside its limits, so one retry and a
 * time limit on the whole call and on each silence. Nothing here is a setting that models of this generation reject (no temperature,
 * top_p, top_k or thinking budget), and thinking is left to the model: it is adaptive and its text is never shown.
 */
export function modelCallSettings() {
  return {
    maxRetries: 1,
    timeout: { totalMs: 120_000, chunkMs: 30_000 },
    providerOptions: { anthropic: { effort: "low" } },
  } as const;
}

/** The numbers the usage meter counts. `inputTokens` is Anthropic's own input count, which leaves cache reads and writes out. */
export function usageOf(usage: LanguageModelUsage): LlmUsage {
  const cacheReadTokens = usage.inputTokenDetails.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails.cacheWriteTokens ?? 0;
  const inputTokens = usage.inputTokenDetails.noCacheTokens ?? Math.max(0, (usage.inputTokens ?? 0) - cacheReadTokens - cacheWriteTokens);
  return { inputTokens, outputTokens: usage.outputTokens ?? 0, cacheReadTokens, cacheWriteTokens };
}

/**
 * Why a model call failed, as one of the plain reasons and never the provider's text. A wrong key or a refused request is not an
 * outage, so it is told apart from "network".
 */
export function unavailableReason(error: unknown): LlmUnavailableError["reason"] {
  if (error instanceof LlmUnavailableError) return error.reason;
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (cause instanceof LlmUnavailableError) return cause.reason;
  const status = APICallError.isInstance(cause) ? cause.statusCode : undefined;
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "not_configured";
  if (status === 400 || status === 404 || status === 422) return "rejected";
  return "network";
}

/** Logs the kind of failure only: the provider's message can quote the request. Returns the reason, for the caller to act on. */
export function logModelError(error: unknown): LlmUnavailableError["reason"] {
  const reason = unavailableReason(error);
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  const status = APICallError.isInstance(cause) ? (cause.statusCode ?? null) : null;
  logger().warn({ event: "assistant.model_error", status, reason, errorName: cause instanceof Error ? cause.name : "UnknownError" }, "The model request failed");
  return reason;
}

interface LiveOptions { apiKey: string; baseURL?: string; fetch?: typeof globalThis.fetch }

/** The real model. Tests point `baseURL` or `fetch` at a stub to see exactly what would be sent. */
export function createLiveModel(modelId: string, options: LiveOptions): AssistantLanguageModel {
  const provider = createAnthropic({ apiKey: options.apiKey, ...(options.baseURL ? { baseURL: options.baseURL } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) });
  return { model: provider(modelId), mode: "live", modelId };
}

/** The model a test installed through `setAssistantModelForTests`, or one installed here as an AI SDK model directly. */
let languageModelOverride: AssistantLanguageModel | null = null;

export function setAssistantLanguageModelForTests(model: AssistantLanguageModel | null): void {
  languageModelOverride = model;
}

/**
 * The model for this kind of caller, or null when the assistant is off (callers then show the booking link or a plain "not set up").
 * A test's installed model wins over everything, so a test never reaches the network.
 */
export async function resolveAssistantModel(kind: ModelKind): Promise<AssistantLanguageModel | null> {
  if (languageModelOverride) return languageModelOverride;
  const modelId = kind === "staff" ? env().ASSISTANT_STAFF_MODEL : env().ASSISTANT_MODEL;
  const installed = installedClient;
  if (installed) return wrapClient(installed, modelId);
  const mode = assistantMode();
  if (mode === "off") return null;
  if (mode === "fake") {
    const { createLocalModel } = await import("./local-model");
    return wrapClient(createLocalModel(), modelId);
  }
  const apiKey = env().ANTHROPIC_API_KEY;
  return apiKey ? createLiveModel(modelId, { apiKey }) : null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The fake model. The rule-based local model and the scripted test models speak `LlmClient`; this wraps one as an AI SDK language model
// so the whole path (tools, streaming, persistence) runs the same code with no key and no network.

type MockModel = InstanceType<typeof MockLanguageModelV4>;
type StreamOptions = Parameters<MockModel["doStream"]>[0];
type StreamResult = Awaited<ReturnType<MockModel["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;
type PromptMessage = StreamOptions["prompt"][number];

function parseInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

function outputText(output: { type: string; value?: unknown }): { content: string; isError: boolean } {
  const isError = output.type === "error-text" || output.type === "error-json" || output.type === "execution-denied";
  const value = output.value;
  return { content: typeof value === "string" ? value : JSON.stringify(value ?? {}), isError };
}

/** The AI SDK's prompt, written back as the plain messages the local and scripted models read. Tool results come back as user turns. */
export function promptToRequest(options: StreamOptions, modelId: string): { stableSystem: string; volatileSystem: string; messages: LlmMessage[]; tools: LlmTool[]; maxTokens: number; model: string } {
  const systems = options.prompt.flatMap((message: PromptMessage) => (message.role === "system" ? [message.content] : []));
  const messages: LlmMessage[] = [];
  for (const message of options.prompt) {
    if (message.role === "user") {
      const content: LlmBlock[] = message.content.flatMap((part) => (part.type === "text" ? [{ type: "text" as const, text: part.text }] : []));
      messages.push({ role: "user", content });
    } else if (message.role === "assistant") {
      const content: LlmBlock[] = [];
      for (const part of message.content) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
        else if (part.type === "tool-call") content.push({ type: "tool_use", id: part.toolCallId, name: part.toolName, input: parseInput(part.input) });
      }
      messages.push({ role: "assistant", content });
    } else if (message.role === "tool") {
      const content: LlmBlock[] = [];
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        const result = outputText(part.output as { type: string; value?: unknown });
        content.push({ type: "tool_result", tool_use_id: part.toolCallId, content: result.content, ...(result.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content });
    }
  }
  const tools: LlmTool[] = (options.tools ?? []).flatMap((tool) => (tool.type === "function" ? [{ name: tool.name, description: tool.description ?? "", input_schema: tool.inputSchema as Record<string, unknown> }] : []));
  return { stableSystem: systems[0] ?? "", volatileSystem: systems.slice(1).join("\n"), messages, tools, maxTokens: options.maxOutputTokens ?? 1500, model: modelId };
}

function finishReasonOf(stop: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other") {
  const unified = stop === "tool_use" ? "tool-calls" : stop === "max_tokens" ? "length" : stop === "refusal" ? "content-filter" : stop === "end_turn" ? "stop" : "other";
  return { unified, raw: stop } as const;
}

/** Wraps an `LlmClient` as an AI SDK language model. A failure the client throws (an `LlmUnavailableError`) comes out as the stream's error. */
export async function wrapClient(client: LlmClient, modelId: string): Promise<AssistantLanguageModel> {
  const { MockLanguageModelV4 } = await import("ai/test");
  let counter = 0;
  const model = new MockLanguageModelV4({
    provider: `kalendr-${client.mode}`,
    modelId,
    // The same answer for `generateText` (the WhatsApp worker will use it in the next wave).
    doGenerate: async (options) => {
      const response = await client.complete(promptToRequest(options as StreamOptions, modelId));
      type GenerateContent = Awaited<ReturnType<MockModel["doGenerate"]>>["content"];
      const content = response.content.flatMap((block): GenerateContent => {
        counter += 1;
        if (block.type === "text") return [{ type: "text" as const, text: block.text }];
        if (block.type === "tool_use") return [{ type: "tool-call" as const, toolCallId: block.id, toolName: block.name, input: JSON.stringify(block.input ?? {}) }];
        return [];
      });
      const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = response.usage;
      return {
        content,
        finishReason: finishReasonOf(response.stopReason),
        usage: {
          inputTokens: { total: inputTokens + cacheReadTokens + cacheWriteTokens, noCache: inputTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens },
          outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
        },
        warnings: [],
      };
    },
    doStream: async (options) => {
      const response = await client.complete(promptToRequest(options, modelId));
      const chunks: StreamPart[] = [{ type: "stream-start", warnings: [] }];
      for (const block of response.content) {
        counter += 1;
        if (block.type === "text") {
          chunks.push({ type: "text-start", id: `text-${counter}` }, { type: "text-delta", id: `text-${counter}`, delta: block.text }, { type: "text-end", id: `text-${counter}` });
        } else if (block.type === "tool_use") {
          chunks.push({ type: "tool-call", toolCallId: block.id, toolName: block.name, input: JSON.stringify(block.input ?? {}) });
        }
      }
      const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = response.usage;
      chunks.push({
        type: "finish",
        finishReason: finishReasonOf(response.stopReason),
        usage: {
          inputTokens: { total: inputTokens + cacheReadTokens + cacheWriteTokens, noCache: inputTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens },
          outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
        },
      });
      return { stream: new ReadableStream<StreamPart>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }) };
    },
  });
  return { model, mode: "fake", modelId };
}
