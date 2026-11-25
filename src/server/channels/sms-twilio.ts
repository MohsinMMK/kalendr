/**
 * SMS outside India through Twilio's Messages API, called with plain fetch. We do not add the
 * `twilio` package: it is large, and the worker bundle only needs one POST and one HMAC.
 *
 * Twilio has no idempotency key, so a retry after a timeout could send twice. The guard is the
 * worker's semantic-key dedupe (one notification row per message, locked while sending), and
 * the channel only reports "retry" when Twilio certainly did not answer.
 *
 * No "server-only" import: the worker uses this too. Nothing here logs a number or a body.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { countSmsSegments, fillApprovedText } from "./sms-segments";
import {
  WebhookSignatureError,
  type Channel,
  type ParsedWebhook,
  type SendResult,
  type StatusEvent,
  type WebhookRequest,
} from "./types";

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  /** A Twilio number in E.164, or a messaging service sid starting with MG. */
  from: string;
  /** Base URL, default https://api.twilio.com. Local capture servers set this. */
  apiUrl?: string;
  /** Where Twilio reports delivery, when this app is public. */
  statusCallbackUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const sendResponseSchema = z.object({
  sid: z.string().min(1).max(200),
  num_segments: z.union([z.string(), z.number()]).nullish(),
});

/**
 * Twilio's signature: HMAC-SHA1, keyed with the auth token, over the full URL followed by each
 * form field's name and value, fields sorted by name. Base64 of the raw digest.
 */
export function twilioSignature(authToken: string, url: string, fields: ReadonlyArray<readonly [string, string]>): string {
  const sorted = [...fields].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signed = sorted.reduce((text, [name, value]) => `${text}${name}${value}`, url);
  return createHmac("sha1", authToken).update(signed).digest("base64");
}

function sameSignature(expected: string, received: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createTwilioChannel(options: TwilioOptions): Channel {
  const doFetch = options.fetch ?? fetch;
  const base = (options.apiUrl ?? "https://api.twilio.com").replace(/\/$/, "");
  const url = `${base}/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}/Messages.json`;
  const authorization = `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString("base64")}`;
  return {
    id: "sms",
    mode: "live",
    async send(message): Promise<SendResult> {
      const { content } = message;
      if (content.kind !== "template") return { status: "rejected", code: "template_required" };
      if (!content.provider.approvedText) return { status: "rejected", code: "no_approved_text" };
      const body = fillApprovedText(content.provider.approvedText, content.variables);

      const form = new URLSearchParams({ To: message.to, Body: body });
      form.set(options.from.startsWith("MG") ? "MessagingServiceSid" : "From", options.from);
      if (options.statusCallbackUrl) form.set("StatusCallback", options.statusCallbackUrl);

      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: { authorization, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: form.toString(),
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
      } catch {
        return { status: "retry", code: "network_error" };
      }
      if (response.status === 429 || response.status === 408 || response.status >= 500) {
        return { status: "retry", code: `http_${response.status}` };
      }
      const json: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const errorCode = z.object({ code: z.number().int() }).safeParse(json);
        return { status: "rejected", code: errorCode.success ? `twilio_${errorCode.data.code}` : `http_${response.status}` };
      }
      const parsed = sendResponseSchema.safeParse(json);
      if (!parsed.success) return { status: "retry", code: "bad_response" };
      const reported = Number(parsed.data.num_segments);
      return {
        status: "sent",
        providerMessageId: parsed.data.sid,
        segments: Number.isInteger(reported) && reported > 0 ? reported : countSmsSegments(body).segments,
      };
    },
    parseWebhook({ rawBody, headers, url: publicUrl }: WebhookRequest): ParsedWebhook {
      const received = headers.get("x-twilio-signature");
      if (!received) throw new WebhookSignatureError();
      const fields = [...new URLSearchParams(rawBody).entries()];
      if (!sameSignature(twilioSignature(options.authToken, publicUrl, fields), received)) throw new WebhookSignatureError();
      return { statuses: twilioStatuses(fields), inbound: [], templates: [] };
    },
  };
}

function twilioStatuses(fields: ReadonlyArray<readonly [string, string]>): StatusEvent[] {
  const value = (name: string) => fields.find(([key]) => key === name)?.[1];
  const sid = value("MessageSid") ?? value("SmsSid");
  const status = value("MessageStatus") ?? value("SmsStatus");
  if (!sid || !status) return [];
  const state: StatusEvent["state"] | null =
    status === "sent" ? "sent"
      : status === "delivered" ? "delivered"
        : status === "read" ? "read"
          : status === "undelivered" || status === "failed" ? "failed"
            : null;
  if (!state) return []; // queued, sending and accepted say nothing new.
  const errorCode = value("ErrorCode");
  return [{
    eventId: `${sid}:${status}`,
    providerMessageId: sid,
    state,
    failureCode: state === "failed" ? (errorCode && /^\d{1,6}$/.test(errorCode) ? `twilio_${errorCode}` : "undelivered") : undefined,
  }];
}
