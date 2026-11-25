import type { UIMessage } from "ai";
import { z } from "zod";

import { assistantProposalSchema, type AssistantProposal } from "./assistant-contracts";

/**
 * The shape of the staff copilot's chat on the wire (feature 30). The server streams AI SDK UI messages; besides the model's text
 * and tool steps they carry two typed data parts: the conversation id (sent once, never saved) and the booking proposal that the
 * staff member's Confirm button is drawn from. Both ends import this file, so the client and the server cannot drift apart.
 */

type CopilotDataParts = {
  /** The chat this message belongs to. Transient: it reaches the page but is not part of the saved message. */
  conversation: { id: string };
  /** A booking the staff member can confirm. Only their own press of Confirm books it. */
  proposal: AssistantProposal;
};

export type CopilotUIMessage = UIMessage<unknown, CopilotDataParts>;

/** For `validateUIMessages`: every data part the copilot can carry. */
export const copilotDataSchemas = {
  conversation: z.object({ id: z.string() }),
  proposal: assistantProposalSchema,
} as const;

/** What the page says while a tool runs, by tool name. */
export const copilotToolLabels: Readonly<Record<string, string>> = {
  list_services: "Looking at services",
  list_staff: "Looking at who is available",
  find_times: "Finding free times",
  search_customers: "Finding the customer",
  lapsed_customers: "Looking for customers who have not come back",
  list_unread_messages: "Checking unread messages",
  read_message_thread: "Reading the message thread",
  propose_booking: "Preparing a booking to confirm",
};
