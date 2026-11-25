/**
 * SMS in India through MSG91's Flow API. Indian networks block any text that differs from the
 * wording registered under DLT, so this channel sends the template id and the variables only,
 * never a body of its own. MSG91 fills the registered wording in.
 *
 * Delivery reports from MSG91 are not signed. The route protects them with a secret in the URL
 * path instead; parseWebhook here only reads the report.
 *
 * No "server-only" import: the worker uses this too. Nothing here logs a number or a variable.
 */
import { z } from "zod";

import { countSmsSegments, fillApprovedText } from "./sms-segments";
import {
  WebhookSignatureError,
  type Channel,
  type ChannelMessage,
  type ParsedWebhook,
  type SendResult,
  type StatusEvent,
  type WebhookRequest,
} from "./types";

export const MSG91_FLOW_URL = "https://api.msg91.com/api/v5/flow/";

export interface Msg91Options {
  authKey: string;
  /** The DLT-approved header. The flow (template) in MSG91 carries it; kept for the config check. */
  senderId: string;
  apiUrl?: string;
  /** Injected in tests so nothing leaves the machine. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** MSG91 answers {"type":"success","message":"<request id>"} on acceptance. */
const sendResponseSchema = z.object({ type: z.string(), message: z.string().min(1).max(200) });

function digitsOnly(e164: string): string {
  return e164.replace(/\D/g, "");
}

function flowBody(message: ChannelMessage, templateId: string, variables: string[]) {
  const recipient: Record<string, string> = { mobiles: digitsOnly(message.to) };
  variables.forEach((value, index) => {
    recipient[`VAR${index + 1}`] = value;
  });
  return { template_id: templateId, short_url: "0", recipients: [recipient] };
}

export function createMsg91Channel(options: Msg91Options): Channel {
  const doFetch = options.fetch ?? fetch;
  const url = options.apiUrl ?? MSG91_FLOW_URL;
  return {
    id: "sms",
    mode: "live",
    async send(message): Promise<SendResult> {
      const { content } = message;
      if (content.kind !== "template") return { status: "rejected", code: "template_required" };
      const templateId = content.provider.templateId;
      if (!templateId) return { status: "rejected", code: "no_dlt_template_id" };

      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: { authkey: options.authKey, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(flowBody(message, templateId, content.variables)),
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
      } catch {
        return { status: "retry", code: "network_error" };
      }
      if (response.status === 429 || response.status === 408 || response.status >= 500) {
        return { status: "retry", code: `http_${response.status}` };
      }
      if (!response.ok) return { status: "rejected", code: `http_${response.status}` };

      const parsed = sendResponseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) return { status: "retry", code: "bad_response" };
      if (parsed.data.type !== "success") return { status: "rejected", code: "msg91_refused" };

      const text = content.provider.approvedText ? fillApprovedText(content.provider.approvedText, content.variables) : "";
      return {
        status: "sent",
        providerMessageId: parsed.data.message,
        segments: text ? countSmsSegments(text).segments : undefined,
      };
    },
    parseWebhook({ rawBody }: WebhookRequest): ParsedWebhook {
      return { statuses: parseMsg91Reports(rawBody), inbound: [], templates: [] };
    },
  };
}

const reportSchema = z.object({
  requestId: z.string().min(1).max(200).optional(),
  request_id: z.string().min(1).max(200).optional(),
  requestid: z.string().min(1).max(200).optional(),
  status: z.union([z.string(), z.number()]).optional(),
  // The older SMS-API format nests one entry per recipient, each with its own status.
  report: z.array(z.object({ status: z.union([z.string(), z.number()]).optional() })).optional(),
});

/**
 * MSG91 status codes: 0 sent, 1 delivered, 2 failed, 9 refused by the do-not-disturb list.
 * Anything else is ignored. The failure code is ours, never MSG91's free text.
 */
function stateFor(status: string | number | undefined): Pick<StatusEvent, "state" | "failureCode"> | null {
  switch (String(status ?? "").trim()) {
    case "0": return { state: "sent" };
    case "1": return { state: "delivered" };
    case "2": return { state: "failed", failureCode: "undelivered" };
    case "9": return { state: "failed", failureCode: "ndnc" };
    default: return null;
  }
}

export function parseMsg91Reports(rawBody: string): StatusEvent[] {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new WebhookSignatureError();
  }
  const reports = z.union([z.array(reportSchema), reportSchema]).safeParse(json);
  if (!reports.success) throw new WebhookSignatureError();
  const list = Array.isArray(reports.data) ? reports.data : [reports.data];
  const events = new Map<string, StatusEvent>();
  for (const report of list) {
    const providerMessageId = report.requestId ?? report.request_id ?? report.requestid;
    if (!providerMessageId) continue;
    const statuses = report.status !== undefined ? [report.status] : (report.report ?? []).map((entry) => entry.status);
    for (const status of statuses) {
      const state = stateFor(status);
      if (!state) continue;
      // Stable per report and state, so MSG91 resending the same report queues nothing twice.
      const eventId = `${providerMessageId}:${state.state}`;
      if (!events.has(eventId)) events.set(eventId, { eventId, providerMessageId, ...state });
    }
  }
  return [...events.values()];
}
