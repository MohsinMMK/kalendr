import type { UIMessageChunk } from "ai";

import type { AssistantProposal } from "@/lib/assistant-contracts";
import type { AssistantConversationState } from "@/lib/assistant-ui";

/** What a visitor's page ends up with after reading one answer from the website chat's stream. */
export interface ReadAssistantAnswer {
  /** The chat's token, on the first answer of a chat. */
  token?: string;
  /** The words the customer is finally shown: the replacement when there is one, else the streamed parts in order. */
  reply: string;
  /** The words as they streamed, before any replacement. */
  streamed: string;
  replaced: boolean;
  proposal: AssistantProposal | null;
  fallbackLink: string | null;
  conversation: AssistantConversationState;
  chunkTypes: string[];
}

/** Reads a whole stream from `webChat`, the way the page's `useChat` does, for tests. */
export async function readAssistantStream(stream: ReadableStream<UIMessageChunk>): Promise<ReadAssistantAnswer> {
  const parts: string[] = [];
  const open = new Map<string, number>();
  let replacement: string | null = null;
  let proposal: AssistantProposal | null = null;
  let fallbackLink: string | null = null;
  let conversation: AssistantConversationState = { status: "active", awaitingCode: false, verified: false };
  let token: string | undefined;
  const chunkTypes: string[] = [];
  const reader = stream.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    const chunk = next.value as { type: string; id?: string; delta?: string; data?: unknown };
    chunkTypes.push(chunk.type);
    if (chunk.type === "error") throw new Error(`The stream failed: ${String((chunk as { errorText?: string }).errorText)}`);
    if (chunk.type === "text-start" && chunk.id) open.set(chunk.id, parts.push("") - 1);
    if (chunk.type === "text-delta" && chunk.id) {
      const slot = open.get(chunk.id);
      if (slot !== undefined) parts[slot] = `${parts[slot] ?? ""}${chunk.delta ?? ""}`;
    }
    if (chunk.type === "data-replace") replacement = (chunk.data as { text: string }).text;
    if (chunk.type === "data-proposal") proposal = chunk.data as AssistantProposal;
    if (chunk.type === "data-fallback") fallbackLink = (chunk.data as { link: string }).link;
    if (chunk.type === "data-conversation") {
      const state = chunk.data as AssistantConversationState;
      if (state.token) token = state.token;
      conversation = { status: state.status, awaitingCode: state.awaitingCode, verified: state.verified };
    }
  }
  const streamed = parts.map((part) => part.trim()).filter((part) => part !== "").join("\n\n");
  return { ...(token ? { token } : {}), reply: replacement ?? streamed, streamed, replaced: replacement !== null, proposal, fallbackLink, conversation, chunkTypes };
}
