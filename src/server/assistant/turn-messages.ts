import type { ModelMessage, StepResult, ToolSet } from "ai";

import { isFailureOutput } from "./ai-tools";
import type { LlmBlock, LlmMessage } from "./model";
import { usageOf } from "./model";
import type { NewMessage } from "./store";

/**
 * The two ways the website chat and the WhatsApp worker move between this app's saved blocks and the AI SDK's messages (feature 30).
 * Chats stay saved as plain model blocks, so an old chat, the handoff view and the privacy export read every message the same way.
 */

function parseOutput(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/**
 * The saved chat as the messages the model is sent. Tool calls and their results are replayed, so a later turn can use a time the
 * model found earlier. Thinking from an old chat is left out. A result whose call is not in the chat is dropped, never guessed at.
 */
export function modelMessagesOf(history: readonly LlmMessage[]): ModelMessage[] {
  const names = new Map<string, string>();
  const messages: ModelMessage[] = [];
  for (const message of history) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const content: Array<{ type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }> = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim() !== "") content.push({ type: "text", text: block.text });
        if (block.type === "tool_use") {
          names.set(block.id, block.name);
          content.push({ type: "tool-call", toolCallId: block.id, toolName: block.name, input: block.input ?? {} });
        }
      }
      if (content.length > 0) messages.push({ role: "assistant", content });
      continue;
    }
    const results = message.content.flatMap((block) => {
      if (block.type !== "tool_result") return [];
      const toolName = names.get(block.tool_use_id);
      if (!toolName) return [];
      const value = parseOutput(block.content);
      const output = typeof value === "string"
        ? { type: block.is_error ? ("error-text" as const) : ("text" as const), value }
        : { type: block.is_error ? ("error-json" as const) : ("json" as const), value: value as never };
      return [{ type: "tool-result" as const, toolCallId: block.tool_use_id, toolName, output }];
    });
    if (results.length > 0) messages.push({ role: "tool", content: results });
    const words = message.content.flatMap((block) => (block.type === "text" ? [{ type: "text" as const, text: block.text }] : []));
    if (words.length > 0) messages.push({ role: "user", content: words });
  }
  return messages;
}

/**
 * What the model did in the steps that ended in tool calls, as saved messages: its calls, then what came back. Words it wrote beside a
 * call ("Let me check") are not kept: the turn keeps one reply, the final answer as the customer was shown it, so a reloaded chat
 * matches what the page settled on. The last step (the answer) is not here either. A call the SDK refused (no such tool, input that
 * did not fit) is left out, so a later turn never replays it.
 */
export function toolMessagesOf(steps: ReadonlyArray<StepResult<ToolSet>>): NewMessage[] {
  const saved: NewMessage[] = [];
  for (const step of steps) {
    const blocks: LlmBlock[] = [];
    const results: LlmBlock[] = [];
    const answered = new Set<string>();
    const refused = new Set(step.content.flatMap((part) => (part.type === "tool-call" && part.invalid === true ? [part.toolCallId] : [])));
    for (const part of step.content) {
      if (part.type === "tool-result") {
        answered.add(part.toolCallId);
        results.push({ type: "tool_result", tool_use_id: part.toolCallId, content: JSON.stringify(part.output ?? {}), ...(isFailureOutput(part.output) ? { is_error: true } : {}) });
      } else if (part.type === "tool-error" && !refused.has(part.toolCallId)) {
        answered.add(part.toolCallId);
        results.push({ type: "tool_result", tool_use_id: part.toolCallId, content: JSON.stringify({ error: "That didn't work." }), is_error: true });
      }
    }
    for (const part of step.content) {
      if (part.type === "tool-call" && part.invalid !== true && answered.has(part.toolCallId)) blocks.push({ type: "tool_use", id: part.toolCallId, name: part.toolName, input: part.input });
    }
    if (!blocks.some((block) => block.type === "tool_use")) continue;
    const used = usageOf(step.usage);
    saved.push({ kind: "assistant", blocks, inputTokens: used.inputTokens, outputTokens: used.outputTokens });
    saved.push({ kind: "tool", blocks: results });
  }
  return saved;
}
