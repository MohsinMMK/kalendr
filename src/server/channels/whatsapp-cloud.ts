/**
 * WhatsApp through Meta's Cloud API, with plain fetch (Meta's Node SDK is deprecated).
 *
 * Sends approved templates (and free text inside the customer's 24-hour window), checks the
 * X-Hub-Signature-256 header on callbacks, and turns Meta's callback payload into the shared
 * StatusEvent / InboundEvent / TemplateStatusEvent shapes.
 *
 * Meta has no idempotency key, so a repeat after a crash is stopped one level up, by the
 * worker's one-row-per-semantic-key guard. Nothing here logs a number, a variable or a body.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  WebhookSignatureError,
  type Channel,
  type ChannelMessage,
  type CostCategory,
  type InboundEvent,
  type ParsedWebhook,
  type SendResult,
  type StatusEvent,
  type TemplateStatusEvent,
} from "./types";

export const WHATSAPP_API_VERSION = "v23.0";
export const WHATSAPP_GRAPH_URL = "https://graph.facebook.com";

export interface WhatsAppOptions {
  accessToken: string;
  phoneNumberId: string;
  /** Needed to check webhook signatures. Without it every webhook is refused. */
  appSecret?: string;
  /** Graph base URL. Tests and local runs use a loopback capture server. */
  apiUrl?: string;
  mode?: "live" | "capture";
  fetchImpl?: typeof fetch;
}

/** Error codes where a later attempt may work: rate limits and Meta's own outages. */
const TRANSIENT_CODES = new Set([4, 80007, 130429, 131000, 131016, 131056, 133004, 133016]);

const sendResponse = z.object({ messages: z.array(z.object({ id: z.string().min(1).max(200) })).min(1) });
const errorResponse = z.object({ error: z.object({ code: z.number().optional() }).partial().optional() });

/** Meta wants the number as digits with the country code and no plus sign. */
const digits = (e164: string) => e164.replace(/\D/g, "");

export function buildSendBody(message: ChannelMessage): Record<string, unknown> | null {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: digits(message.to) };
  const { content } = message;
  if (content.kind === "text") return { ...base, type: "text", text: { preview_url: false, body: content.body } };
  if (content.kind !== "template") return null;
  const components: Array<Record<string, unknown>> = [];
  if (content.variables.length > 0) {
    components.push({ type: "body", parameters: content.variables.map((text) => ({ type: "text", text })) });
  }
  // Authentication template: the code is repeated in a url-type button at index 0 (Meta creates the copy-code button as a url button).
  if (content.copyCode) {
    components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: content.copyCode }] });
    return { ...base, type: "template", template: { name: content.provider.name, language: { code: content.language }, components } };
  }
  (content.buttons ?? []).forEach((button, index) => {
    components.push({ type: "button", sub_type: "quick_reply", index: String(index), parameters: [{ type: "payload", payload: button.payload }] });
  });
  if (content.linkSuffix) {
    components.push({ type: "button", sub_type: "url", index: String(content.buttons?.length ?? 0), parameters: [{ type: "text", text: content.linkSuffix }] });
  }
  return { ...base, type: "template", template: { name: content.provider.name, language: { code: content.language }, components } };
}

export function createWhatsAppChannel(options: WhatsAppOptions): Channel {
  const doFetch = options.fetchImpl ?? fetch;
  const base = (options.apiUrl ?? WHATSAPP_GRAPH_URL).replace(/\/+$/, "");
  return {
    id: "whatsapp",
    mode: options.mode ?? "live",
    async send(message): Promise<SendResult> {
      const body = buildSendBody(message);
      if (!body) return { status: "rejected", code: "whatsapp_wrong_content" };
      let response: Response;
      try {
        response = await doFetch(`${base}/${WHATSAPP_API_VERSION}/${encodeURIComponent(options.phoneNumberId)}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${options.accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        return { status: "retry", code: "whatsapp_network_error" };
      }
      const json: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const parsed = sendResponse.safeParse(json);
        if (!parsed.success) return { status: "retry", code: "whatsapp_missing_id" };
        return { status: "sent", providerMessageId: parsed.data.messages[0].id };
      }
      const metaCode = errorResponse.safeParse(json).data?.error?.code;
      const code = `whatsapp_${metaCode ?? response.status}`;
      if (response.status === 429 || response.status >= 500 || (metaCode !== undefined && TRANSIENT_CODES.has(metaCode))) {
        return { status: "retry", code };
      }
      return { status: "rejected", code };
    },
    parseWebhook({ rawBody, headers }) {
      if (!options.appSecret) throw new WebhookSignatureError();
      verifySignature(options.appSecret, rawBody, headers.get("x-hub-signature-256"));
      return parseCallback(rawBody);
    },
  };
}

/** `sha256=<hex>` over the exact bytes received, keyed with the app secret, compared in constant time. */
export function verifySignature(appSecret: string, rawBody: string, header: string | null): void {
  const expected = Buffer.from(`sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`);
  const given = Buffer.from(header ?? "");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new WebhookSignatureError();
}

/** The header a test or the local capture server uses to sign a body the way Meta does. */
export function signWhatsAppBody(appSecret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

const costCategories = new Set<CostCategory>(["utility", "marketing", "authentication", "service"]);

const statusItem = z.object({
  id: z.string().min(1).max(200),
  status: z.string(),
  timestamp: z.string().optional(),
  pricing: z.object({ category: z.string().optional() }).partial().optional(),
  errors: z.array(z.object({ code: z.number().optional() })).optional(),
});

const messageItem = z.object({
  id: z.string().min(1).max(200),
  from: z.string().min(5).max(20),
  timestamp: z.string().optional(),
  type: z.string(),
  context: z.object({ id: z.string().max(200).optional() }).partial().optional(),
  text: z.object({ body: z.string().max(8_192) }).optional(),
  button: z.object({ payload: z.string().max(256).optional(), text: z.string().max(256) }).optional(),
  interactive: z.object({
    button_reply: z.object({ id: z.string().max(256), title: z.string().max(256) }).optional(),
  }).partial().optional(),
});

const changeValue = z.object({
  statuses: z.array(z.unknown()).optional(),
  messages: z.array(z.unknown()).optional(),
  event: z.string().optional(),
  message_template_name: z.string().optional(),
  message_template_language: z.string().optional(),
  reason: z.string().optional(),
});

const callbackSchema = z.object({
  entry: z.array(z.object({
    changes: z.array(z.object({ field: z.string(), value: changeValue })).default([]),
  })).default([]),
});

function failureCodeFor(item: z.infer<typeof statusItem>): string {
  const code = item.errors?.[0]?.code;
  return code === undefined ? "whatsapp_failed" : `whatsapp_${code}`.slice(0, 40);
}

/** A callback can carry several statuses and messages at once; each becomes its own event. */
export function parseCallback(rawBody: string): ParsedWebhook {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new WebhookSignatureError();
  }
  const callback = callbackSchema.safeParse(json);
  if (!callback.success) throw new WebhookSignatureError();
  const result: ParsedWebhook = { statuses: [], inbound: [], templates: [] };
  for (const entry of callback.data.entry) {
    for (const change of entry.changes) {
      if (change.field === "messages") {
        for (const raw of change.value.statuses ?? []) {
          const item = statusItem.safeParse(raw);
          if (!item.success) continue;
          const states: Record<string, StatusEvent["state"] | undefined> = { sent: "sent", delivered: "delivered", read: "read", failed: "failed" };
          const state = states[item.data.status];
          if (!state) continue;
          const category = item.data.pricing?.category?.toLowerCase();
          result.statuses.push({
            eventId: `${item.data.id}:${state}`,
            providerMessageId: item.data.id,
            state,
            failureCode: state === "failed" ? failureCodeFor(item.data) : undefined,
            costCategory: category && costCategories.has(category as CostCategory) ? category as CostCategory : undefined,
          });
        }
        for (const raw of change.value.messages ?? []) {
          const item = messageItem.safeParse(raw);
          if (!item.success) continue;
          const inbound = toInbound(item.data);
          if (inbound) result.inbound.push(inbound);
        }
      } else if (change.field === "message_template_status_update") {
        const template = toTemplateStatus(change.value);
        if (template) result.templates.push(template);
      }
    }
  }
  return result;
}

function toInbound(item: z.infer<typeof messageItem>): InboundEvent | null {
  const receivedAt = item.timestamp && /^\d+$/.test(item.timestamp) ? new Date(Number(item.timestamp) * 1000) : new Date();
  const base = { eventId: `in:${item.id}`, from: `+${item.from.replace(/\D/g, "")}`, providerMessageId: item.id, receivedAt, contextMessageId: item.context?.id };
  if (item.type === "text" && item.text) return { ...base, content: { kind: "text", body: item.text.body } };
  // A tap on a template's quick-reply button arrives as type "button"; an interactive reply as "interactive".
  if (item.type === "button" && item.button) {
    return { ...base, content: { kind: "button", payload: item.button.payload ?? item.button.text, label: item.button.text } };
  }
  const reply = item.interactive?.button_reply;
  if (item.type === "interactive" && reply) return { ...base, content: { kind: "button", payload: reply.id, label: reply.title } };
  return { ...base, content: { kind: "other", mediaKind: item.type.slice(0, 24) } };
}

function toTemplateStatus(value: z.infer<typeof changeValue>): TemplateStatusEvent | null {
  if (!value.message_template_name || !value.event) return null;
  const events: Record<string, TemplateStatusEvent["status"] | undefined> = {
    APPROVED: "approved", REJECTED: "rejected", PAUSED: "paused", DISABLED: "rejected", PENDING: "pending", IN_APPEAL: "pending",
  };
  const status = events[value.event.toUpperCase()];
  if (!status) return null;
  return {
    eventId: `tpl:${value.message_template_name}:${value.message_template_language ?? "en"}:${value.event}`,
    providerTemplateName: value.message_template_name,
    language: (value.message_template_language ?? "en").slice(0, 16),
    status,
    reason: value.reason && /^[A-Z_]{1,60}$/.test(value.reason) ? value.reason : undefined,
  };
}

/** Meta's one-time address check: echo hub.challenge when the verify token matches, in constant time. */
export function answerVerification(searchParams: URLSearchParams, verifyToken: string | undefined): string | null {
  if (!verifyToken || searchParams.get("hub.mode") !== "subscribe") return null;
  const given = Buffer.from(searchParams.get("hub.verify_token") ?? "");
  const expected = Buffer.from(verifyToken);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const challenge = searchParams.get("hub.challenge") ?? "";
  return /^[A-Za-z0-9_-]{1,200}$/.test(challenge) ? challenge : null;
}
