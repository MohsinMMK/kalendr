/**
 * The one interface every delivery channel implements: email, WhatsApp and SMS. Message
 * workflows (feature 5) and the worker call channels only through this file, so keep it small
 * and stable: add optional fields, never rename or remove one.
 *
 * A channel sends one finished message and reports what the provider says afterwards. It never
 * decides whether to send (consent, quiet hours and routing live in the worker), never reads
 * the database and never logs the recipient, a variable or a body.
 *
 * No "server-only" import: the worker (run with tsx or a bundle) uses this too.
 */

export type ChannelId = "email" | "sms" | "whatsapp";

/** How a provider bills a message. The usage meter (feature 14) counts by this. */
export type CostCategory = "utility" | "marketing" | "authentication" | "service";

/**
 * A message made from an approved template: WhatsApp template names and DLT SMS templates work
 * this way, and the provider rejects wording that differs, so the channel sends variables only.
 */
export interface TemplateContent {
  kind: "template";
  /** Our key in message_templates, such as "reminder" or "booking_confirmed". */
  templateKey: string;
  /**
   * What the provider calls this template, resolved by the caller from message_templates (a
   * channel never reads the database). WhatsApp: `name`. SMS: `templateId` is the DLT template
   * id (MSG91 flow id) and `approvedText` the exact approved wording with its variable slots,
   * which Twilio sends with the variables filled in.
   */
  provider: { name: string; templateId?: string; approvedText?: string };
  /** BCP 47 language the approved template is written in, such as "en" or "hi". */
  language: string;
  /** Values in the template's variable order. Never logged. */
  variables: string[];
  /** Quick-reply buttons, set only for templates that have them. `payload` comes back on a tap. */
  buttons?: Array<{ label: string; payload: string }>;
  /** URL appended to the template (the manage link), when the template has a dynamic link. */
  linkSuffix?: string;
  /**
   * The one-time code, for a WhatsApp authentication template with a copy-code button. Meta wants it twice: as the
   * body variable (put it in `variables` too) and as the button's parameter. Never set with `buttons` or
   * `linkSuffix`, which would take the same button position.
   */
  copyCode?: string;
}

/** Free text. Allowed on WhatsApp only inside the customer's 24-hour window. */
export interface TextContent {
  kind: "text";
  body: string;
}

/** A finished email. Kept here so email can sit behind the same interface. */
export interface EmailContent {
  kind: "email";
  subject: string;
  html: string;
  text: string;
  fromName?: string;
  replyTo?: string;
  attachments?: Array<{ filename: string; contentType: string; content: string }>;
}

export type ChannelContent = TemplateContent | TextContent | EmailContent;

export interface ChannelMessage {
  /** The business sending, so a channel can use a per-business account later. */
  tenantId: string;
  /** E.164 for sms and whatsapp, an email address for email. Never logged. */
  to: string;
  content: ChannelContent;
  /**
   * Stable for every attempt at this message (the notification's semantic key). Resend and the
   * capture server drop a repeat with it; Meta, MSG91 and Twilio have no such key, so for them a
   * retry after a timeout can send twice.
   */
  idempotencyKey: string;
}

export type SendResult =
  | {
    status: "sent";
    providerMessageId: string;
    costCategory?: CostCategory;
    /** SMS only: how many segments the provider will bill. */
    segments?: number;
  }
  /** The provider may accept it later (timeout, rate limit, 5xx). The worker retries. */
  | { status: "retry"; code: string }
  /** The provider will never accept it as it is. The worker sends it to dead letter. */
  | { status: "rejected"; code: string };

export type DeliveryState = "sent" | "delivered" | "read" | "failed";

/** One thing a provider's callback reported about a message we sent. */
export interface StatusEvent {
  /** The provider's id for the callback, used to ignore a repeat. */
  eventId: string;
  providerMessageId: string;
  state: DeliveryState;
  /** Short machine code, never provider free text. */
  failureCode?: string;
  /** What the provider billed it as, when its callback says (WhatsApp: the pricing category). */
  costCategory?: CostCategory;
}

/** A customer wrote to us (WhatsApp now; SMS replies later). */
export interface InboundEvent {
  eventId: string;
  /** E.164 of the sender. Never logged. */
  from: string;
  providerMessageId: string;
  receivedAt: Date;
  /** The message of ours this replies to (a button tap names it), which tells us which business. */
  contextMessageId?: string;
  content:
    | { kind: "text"; body: string }
    | { kind: "button"; payload: string; label: string }
    | { kind: "other"; mediaKind: string };
}

/** A template changed approval state at the provider. */
export interface TemplateStatusEvent {
  eventId: string;
  providerTemplateName: string;
  language: string;
  status: "approved" | "rejected" | "paused" | "pending";
  reason?: string;
}

/** What a webhook carried, after its signature was checked. */
export interface ParsedWebhook {
  statuses: StatusEvent[];
  inbound: InboundEvent[];
  templates: TemplateStatusEvent[];
}

export class WebhookSignatureError extends Error {
  constructor() {
    super("The webhook signature is not valid.");
    this.name = "WebhookSignatureError";
  }
}

export interface Channel {
  readonly id: ChannelId;
  /** "capture" means nothing leaves this machine. */
  readonly mode: "live" | "capture";
  send(message: ChannelMessage): Promise<SendResult>;
  /**
   * Checks the provider's signature over the exact raw bytes and returns what the callback
   * carried. Throws WebhookSignatureError on any failure. Compares in constant time.
   */
  parseWebhook(request: WebhookRequest): ParsedWebhook;
}

/** Everything a provider's signature check might cover. Twilio signs the public URL and the form fields. */
export interface WebhookRequest {
  rawBody: string;
  headers: Headers;
  /** The full public URL the provider called, as the provider saw it. */
  url: string;
}

export const emptyWebhook: ParsedWebhook = { statuses: [], inbound: [], templates: [] };
