/**
 * The shapes the Inbox screen and its API share. No server imports, so client components use it.
 * Message text is opened on the server and sent to staff who hold `inbox.reply`; it is never logged.
 */
import { z } from "zod";

import { replyTemplateKeys } from "./channel-templates";

export const inboxFilters = ["all", "unread", "mine"] as const;
export type InboxFilter = (typeof inboxFilters)[number];

export interface ThreadSummary {
  id: string;
  patientId: string;
  patientName: string;
  channel: "whatsapp";
  unreadCount: number;
  lastMessageAt: string;
  /** The last message as one line: the customer's words, or "Reminder sent" for a template. */
  preview: string;
  /** True when staff may still type a free-form reply. */
  windowOpen: boolean;
  assignedToUserId: string | null;
}

export type ThreadMessageStatus = "received" | "queued" | "sent" | "delivered" | "read" | "failed";

export interface ThreadMessage {
  id: string;
  direction: "inbound" | "outbound";
  kind: "text" | "template" | "button" | "other";
  /** The words, or null for a template (use `templateLabel`) or a picture/voice note. */
  text: string | null;
  templateLabel: string | null;
  status: ThreadMessageStatus;
  /** A short code such as window_closed or provider_not_configured; the screen turns it into words. */
  failureCode: string | null;
  createdAt: string;
}

export interface ThreadAppointment {
  id: string;
  startsAt: string;
  serviceName: string;
  practitionerName: string;
  status: string;
  confirmationStatus: string;
}

export interface ThreadDetail {
  thread: ThreadSummary;
  messages: ThreadMessage[];
  /** The customer's next booking, shown above the conversation and used by template replies. */
  nextAppointment: ThreadAppointment | null;
  windowClosesAt: string | null;
  /** Approved templates staff can send once the window has closed. Empty when there is no booking to fill in. */
  replyTemplates: Array<{ key: (typeof replyTemplateKeys)[number]; label: string }>;
}

export const replyInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), body: z.string().trim().min(1, "Write a message.").max(1000, "Keep it under 1,000 characters.") }).strict(),
  z.object({ kind: z.literal("template"), templateKey: z.enum(replyTemplateKeys), appointmentId: z.string().min(1).max(100) }).strict(),
]);
export type ReplyInput = z.infer<typeof replyInput>;

export const assignInput = z.object({ userId: z.string().min(1).max(100).nullable() }).strict();
export type AssignInput = z.infer<typeof assignInput>;

/** Settings > Messages: what one business has switched on, and the state of the approved templates. */
export interface ChannelSettings {
  whatsapp: ChannelState;
  sms: ChannelState & { provider: "msg91" | "twilio" | null };
}

export interface ChannelState {
  enabled: boolean;
  /** False until Kalendr's account for this channel is set up. The switch still works; nothing sends until then. */
  configured: boolean;
  templates: Array<{ key: string; language: string; status: "pending" | "approved" | "rejected" | "paused"; reason: string | null }>;
}

export const channelSettingsInput = z.object({
  whatsappEnabled: z.boolean().optional(),
  smsEnabled: z.boolean().optional(),
}).strict().refine((value) => value.whatsappEnabled !== undefined || value.smsEnabled !== undefined, "Change at least one setting.");
export type ChannelSettingsInput = z.infer<typeof channelSettingsInput>;
