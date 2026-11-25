import type { Conversation } from "./store";

/** What happened during one turn that the reply, and the screen, must show. Set by tools and read by the loop. */
export interface TurnState {
  proposal: { id: string; kind: "book" | "reschedule" | "cancel" | "staff_book"; summary: string; expiresAt: Date } | null;
  handoff: { reason: HandoffReason; summary: string } | null;
  awaitingCode: boolean;
  /** A change was really made this turn (by the customer's confirm, in code). */
  committed: boolean;
  toolCalls: number;
}

export const handoffReasons = ["asked_for_person", "upset", "cannot_help", "advice", "emergency", "other"] as const;
export type HandoffReason = (typeof handoffReasons)[number];

export function freshTurnState(): TurnState {
  return { proposal: null, handoff: null, awaitingCode: false, committed: false, toolCalls: 0 };
}

/** Who the server knows the customer to be without asking: on WhatsApp and text the sender's own number, already tied to a record. */
export interface ChannelCustomer { id: string; firstName: string; lastName: string; phone: string; email: string }

export interface ToolContext {
  tenantId: string;
  /** The business's link name. The model never sees it and cannot change it. */
  slug: string;
  channel: "web" | "whatsapp" | "sms";
  conversation: Conversation;
  businessName: string;
  businessPhone: string | null;
  bookingLink: string;
  now: Date;
  channelCustomer: ChannelCustomer | null;
  state: TurnState;
  /** True when the customer's own confirm for this proposal id arrived with this turn. Only the loop sets it, never a tool. */
  confirmedProposalId: string | null;
}

export interface ToolResult { text: string; isError: boolean }
export const ok = (value: unknown): ToolResult => ({ text: JSON.stringify(value), isError: false });
export const fail = (message: string): ToolResult => ({ text: JSON.stringify({ error: message }), isError: true });
