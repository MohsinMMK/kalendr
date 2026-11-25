/**
 * The one interface every outgoing-message provider implements: email now (Resend), SMS and
 * WhatsApp later. A provider sends one finished message; it never decides whether to send,
 * never reads the database and never logs the recipient or the body.
 *
 * No "server-only" import: the worker (run with tsx or a bundle) uses this too.
 */

export type MessageChannel = "email" | "sms" | "whatsapp";

export interface MessageAttachment {
  filename: string;
  contentType: string;
  /** The file's text. Calendar files are the only attachments today. */
  content: string;
}

export interface RenderedMessage {
  /** One recipient address. Never logged. */
  to: string;
  /** Display name before the configured sender address, usually the business name. */
  fromName?: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: MessageAttachment[];
  /** Extra message headers: the List-Unsubscribe pair on marketing email (feature 28). */
  headers?: Record<string, string>;
  /**
   * Stable for every attempt at this message (the notification's semantic key), so the
   * provider drops a repeat after a worker crash or retry instead of sending it twice.
   */
  idempotencyKey: string;
}

export interface MessageProvider {
  readonly channel: MessageChannel;
  send(message: RenderedMessage): Promise<{ providerMessageId: string }>;
}

/** The provider may accept the same message later: a timeout, a rate limit, a 5xx. The worker retries. */
export class TransientSendError extends Error {
  constructor(readonly failureCode: string) {
    super(`Message provider is unavailable (${failureCode}).`);
    this.name = "TransientSendError";
  }
}

/** The provider will never accept this message as it is. The worker sends it to dead letter. */
export class PermanentSendError extends Error {
  constructor(readonly failureCode: string) {
    super(`Message provider refused the message (${failureCode}).`);
    this.name = "PermanentSendError";
  }
}

/** "Clinic name <bookings@example.com>", with characters that would break the header removed. */
export function senderWithName(name: string | undefined, address: string): string {
  const bare = address.match(/<([^>]+)>/)?.[1] ?? address;
  const clean = (name ?? "").replace(/["<>\r\n\\]/g, "").trim().slice(0, 80);
  return clean ? `"${clean}" <${bare.trim()}>` : address.trim();
}
