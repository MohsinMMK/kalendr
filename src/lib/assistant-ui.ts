import type { UIMessage } from "ai";
import { z } from "zod";

import { assistantProposalSchema, assistantPublicStatus, type AssistantProposal } from "./assistant-contracts";

/**
 * The shape of the website chat on the wire (feature 30). The server streams AI SDK UI messages. Besides the assistant's words they
 * carry typed data parts, and both ends import this file so they cannot drift apart:
 *
 *  - `conversation` (transient, so never part of a message): the chat's token on the first reply, and its state (with a person,
 *    waiting for a code, phone verified). Sent at the start and again when the turn is settled, because tools change it mid-turn.
 *  - `proposal`: the change the customer is asked to confirm. The Confirm button is drawn from it; only the customer's own tap commits.
 *  - `fallback`: set when the assistant could only give the booking link.
 *  - `replace`: a last line of defence. The server sends the model's words only once they are checked and saved, so the page's text
 *    parts already are the saved reply; should they ever differ, this carries the saved words and the page shows them instead.
 *
 * Tool steps never reach the page: only the words and these parts.
 */

export const assistantConversationSchema = z.object({
  token: z.string().optional(),
  status: assistantPublicStatus,
  awaitingCode: z.boolean(),
  verified: z.boolean(),
});
export type AssistantConversationState = z.infer<typeof assistantConversationSchema>;

type AssistantDataParts = {
  conversation: AssistantConversationState;
  proposal: AssistantProposal;
  fallback: { link: string };
  replace: { text: string };
};

/** `hidden` marks a message the page sent for the server but must not show as something the customer said (the code from a text message). */
export type AssistantUIMessage = UIMessage<{ hidden?: boolean }, AssistantDataParts>;

export const assistantDataSchemas = {
  conversation: assistantConversationSchema,
  proposal: assistantProposalSchema,
  fallback: z.object({ link: z.string() }),
  replace: z.object({ text: z.string() }),
} as const;
