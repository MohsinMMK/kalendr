/**
 * Sends email through Resend. The notification's semantic key is passed as Resend's
 * idempotency key, so a retried send of the same message is never delivered twice.
 *
 * `apiUrl` is EMAIL_API_URL: Resend's own address in production, or the local capture
 * server in tests and local runs. Nothing here logs an address, a subject or a body.
 */
import { Resend } from "resend";

import { PermanentSendError, senderWithName, TransientSendError, type MessageProvider, type RenderedMessage } from "./provider";

export const RESEND_EMAILS_URL = "https://api.resend.com/emails";

export interface ResendProviderOptions {
  apiKey: string;
  /** The sender address, for example "Kalendr <bookings@example.com>". */
  from: string;
  /** The `/emails` endpoint. Defaults to Resend's. */
  apiUrl?: string;
}

/** Resend errors that a later attempt may get past. Everything else is permanent. */
const TRANSIENT_ERRORS = new Set([
  "application_error",
  "internal_server_error",
  "rate_limit_exceeded",
  "concurrent_idempotent_requests",
  "daily_quota_exceeded",
]);

export function resendBaseUrl(apiUrl: string = RESEND_EMAILS_URL): string {
  return apiUrl.replace(/\/+$/, "").replace(/\/emails$/, "");
}

export function createResendEmailProvider(options: ResendProviderOptions): MessageProvider {
  const client = new Resend(options.apiKey, { baseUrl: resendBaseUrl(options.apiUrl) });
  return {
    channel: "email",
    async send(message: RenderedMessage) {
      let result;
      try {
        result = await client.emails.send({
          from: senderWithName(message.fromName, options.from),
          to: [message.to],
          replyTo: message.replyTo || undefined,
          subject: message.subject,
          html: message.html,
          text: message.text,
          headers: message.headers,
          attachments: message.attachments?.map((file) => ({
            filename: file.filename,
            contentType: file.contentType,
            content: Buffer.from(file.content, "utf8").toString("base64"),
          })),
        }, { idempotencyKey: message.idempotencyKey });
      } catch {
        throw new TransientSendError("email_network_error");
      }
      if (result.error) {
        const status = result.error.statusCode ?? 0;
        const name = String(result.error.name ?? "application_error");
        const code = `resend_${name}`.replace(/[^a-z0-9_]/g, "_").slice(0, 60);
        if (status === 0 || status === 429 || status >= 500 || TRANSIENT_ERRORS.has(name)) {
          throw new TransientSendError(code);
        }
        throw new PermanentSendError(code);
      }
      const id = result.data?.id;
      if (!id) throw new TransientSendError("resend_missing_id");
      return { providerMessageId: id };
    },
  };
}
