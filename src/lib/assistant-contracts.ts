import { z } from "zod";

/**
 * What the booking assistant (feature 30) shares between the server and the screens: the owner's settings, the chat
 * requests and replies, and the proposals the customer or staff member must confirm. Nothing here reaches the model.
 */

export const assistantTones = ["friendly", "professional", "concise"] as const;
export const assistantHandoffRules = ["balanced", "eager"] as const;

export const assistantToneLabels: Record<(typeof assistantTones)[number], { label: string; description: string }> = {
  friendly: { label: "Friendly", description: "Warm and relaxed, like a good receptionist." },
  professional: { label: "Professional", description: "Polite and measured." },
  concise: { label: "Short and direct", description: "As few words as it takes." },
};

export const assistantHandoffLabels: Record<(typeof assistantHandoffRules)[number], { label: string; description: string }> = {
  balanced: { label: "When it needs to", description: "Passes to a person when asked, when someone is upset, or when it cannot help after two tries." },
  eager: { label: "Early", description: "Also passes to a person at the first sign of frustration or a question it is unsure about." },
};

export const assistantSettingsSchema = z.object({
  enabledWeb: z.boolean(),
  enabledWhatsapp: z.boolean(),
  enabledSms: z.boolean(),
  tone: z.enum(assistantTones),
  handoffRule: z.enum(assistantHandoffRules),
  businessFacts: z.string().trim().max(3000),
  retentionDays: z.number().int().min(7).max(730),
});
export type AssistantSettingsInput = z.infer<typeof assistantSettingsSchema>;

export const assistantSettingsUpdateSchema = assistantSettingsSchema.extend({
  /** The version the screen loaded, so two people saving at once do not overwrite each other. */
  version: z.number().int().min(0),
});
export type AssistantSettingsUpdate = z.infer<typeof assistantSettingsUpdateSchema>;

export interface AssistantSettingsView extends AssistantSettingsInput {
  version: number;
  /** False when the plan does not include the assistant. */
  available: boolean;
  /** False when no model is set up: the assistant then shows the booking link. */
  modelReady: boolean;
  /** "fake" runs the scripted local model. */
  mode: "live" | "fake" | "off";
  /** This month's tokens against the cap, so the owner can see how much is left. */
  usedTokens: number;
  tokenCap: number;
}

export const defaultAssistantSettings: AssistantSettingsInput = {
  enabledWeb: false, enabledWhatsapp: false, enabledSms: false, tone: "friendly", handoffRule: "balanced", businessFacts: "", retentionDays: 90,
};

/** One thing the customer owes a yes to. The model proposes; only the customer's own confirm commits it. */
export const assistantProposalSchema = z.object({
  id: z.string(),
  kind: z.enum(["book", "reschedule", "cancel"]),
  /** A plain-words line the screen shows beside the Confirm button. */
  summary: z.string(),
  expiresAt: z.string(),
});
export type AssistantProposal = z.infer<typeof assistantProposalSchema>;

export const assistantPublicStatus = z.enum(["active", "handed_off", "closed"]);

/** One line of the visible chat. Tool traffic never reaches the screen. */
export interface AssistantChatLine { role: "customer" | "assistant"; text: string }

/** What a visitor sends. A token comes back from the first reply and is sent on every later message. */
export const assistantChatRequestSchema = z.object({
  business: z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  token: z.string().regex(/^[A-Za-z0-9_-]{40,64}$/).optional(),
  text: z.string().trim().min(1).max(1000).optional(),
  /** The Confirm button. Only a button the server drew can carry this id. */
  confirmProposalId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional(),
  /** The six digits from the text message. Sent from its own field and never shown to the model. */
  code: z.string().regex(/^\d{6}$/).optional(),
}).refine((value) => [value.text, value.confirmProposalId, value.code].filter((part) => part !== undefined).length === 1, {
  message: "Send one message, one confirmation or one code.",
});
export type AssistantChatRequest = z.infer<typeof assistantChatRequestSchema>;

/** What the public widget needs before the first message. */
export interface AssistantPublicConfig {
  enabled: boolean;
  businessName: string;
  bookingLink: string;
  greeting: string;
}

// The copilot (staff). The page sends only the new message and the chat it belongs to; the server keeps the history.
export const copilotRequestSchema = z.object({
  conversationId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  /** `regenerate-message` retries the same question after a failed answer; it never adds a second copy of the question. */
  trigger: z.enum(["submit-message", "regenerate-message"]).default("submit-message"),
  message: z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    text: z.string().trim().min(1).max(1500),
  }),
});
export type CopilotRequest = z.infer<typeof copilotRequestSchema>;

export const copilotConfirmSchema = z.object({
  conversationId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  proposalId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
});

export const handoffActionSchema = z.object({ action: z.enum(["hand_back", "close"]) });
