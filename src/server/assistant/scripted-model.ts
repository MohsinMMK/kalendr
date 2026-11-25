import { estimateTokens, LlmUnavailableError, type LlmBlock, type LlmClient, type LlmRequest, type LlmResponse } from "./model";

/**
 * A model that replays prepared answers, for tests. It can also be told to misbehave, to check the code around it holds. It speaks plain
 * model blocks; `setAssistantModelForTests` installs it and `wrapClient` (model.ts) lets the AI SDK call it.
 */
export function createScriptedModel(script: ReadonlyArray<(request: LlmRequest) => LlmBlock[] | { content: LlmBlock[]; stopReason?: LlmResponse["stopReason"] }>): LlmClient & { calls: LlmRequest[] } {
  let index = 0;
  const calls: LlmRequest[] = [];
  return {
    mode: "fake",
    calls,
    async complete(request) {
      // A copy: the caller keeps adding to its own list after the call, and a test reads what the model saw.
      calls.push({ ...request, messages: [...request.messages] });
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      if (!step) throw new LlmUnavailableError("bad_response");
      const produced = step(request);
      const content = Array.isArray(produced) ? produced : produced.content;
      const stopReason = Array.isArray(produced) ? (content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn") : (produced.stopReason ?? "end_turn");
      return { content, stopReason, usage: { inputTokens: estimateTokens(JSON.stringify(request.messages)), outputTokens: estimateTokens(JSON.stringify(content)), cacheReadTokens: 0, cacheWriteTokens: 0 } };
    },
  };
}
