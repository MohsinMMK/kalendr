/**
 * Sends the codes and notices customers asked for before they have a business to belong to (feature 8): the portal
 * sign-in code, the one-time code for a manage link, and the "your contact details changed" notice. The app only seals
 * them into patient_code_deliveries; this picks them up in the worker's main loop, tries WhatsApp (an authentication
 * template with a copy-code button), then a text message, then email, and clears the sealed copy afterwards.
 *
 * Rows belong to no business, so they are reached only through the claim and finish functions, never by table. Nothing
 * here logs a number, an address, a code or a body.
 */
import { randomUUID } from "node:crypto";

import type postgres from "postgres";

import { DEFAULT_ACCENT } from "../emails/_shared/brand";
import type { ChannelTemplateKey } from "../lib/channel-templates";
import { toE164 } from "../server/channels/phone";
import type { Channel, SendResult } from "../server/channels/types";
import { renderEmail } from "../server/messaging/email-templates";
import { openDelivery, type PatientDeliveryPayload, type PatientDeliveryPurpose } from "../server/messaging/patient-delivery";
import { PermanentSendError, TransientSendError, type MessageProvider } from "../server/messaging/provider";

const PLATFORM = "platform";

export interface CodeDeliveryDeps {
  workerId: string;
  whatsapp?: Channel | null;
  sms?: Channel | null;
  email?: { provider: MessageProvider; fallbackReplyTo: string | null } | null;
  /** Local capture and tests may send templates the provider has not approved yet. */
  allowUnapproved: boolean;
  /** Development only: with no channel at all, print the code to the worker console so the flow can be tried. */
  devConsole: boolean;
}

interface ClaimedDelivery {
  out_id: string;
  out_purpose: PatientDeliveryPurpose;
  out_via: "auto" | "text";
  out_sealed: string | null;
  out_attempts: number;
}

interface TemplateRow {
  provider_name: string;
  provider_template_id: string | null;
  status: string;
  language: string;
  body: string | null;
}

export type DeliveryOutcome = { outcome: "sent" } | { outcome: "retry" | "failed"; code: string };

async function loadTemplate(database: postgres.Sql, channel: "whatsapp" | "sms", key: ChannelTemplateKey): Promise<TemplateRow | undefined> {
  const rows = await database<TemplateRow[]>`
    select provider_name, provider_template_id, status, language, body from message_templates
    where channel = ${channel} and key = ${key} and language = 'en' limit 1
  `;
  return rows[0];
}

function send(channel: Channel, message: Parameters<Channel["send"]>[0]): Promise<SendResult> {
  return channel.send(message);
}

/** One delivery: the first channel that accepts it wins. Exported for tests. */
export async function deliverOne(
  database: postgres.Sql,
  deps: CodeDeliveryDeps,
  id: string,
  purpose: PatientDeliveryPurpose,
  via: "auto" | "text",
  payload: PatientDeliveryPayload,
): Promise<DeliveryOutcome> {
  const key: ChannelTemplateKey = purpose === "contact_changed" ? "contact_changed" : "sign_in_code";
  const code = purpose === "contact_changed" ? undefined : payload.code;
  if (purpose !== "contact_changed" && !/^\d{6}$/.test(code ?? "")) return { outcome: "failed", code: "invalid_payload" };
  const variables = code ? [code] : [payload.business ?? ""];
  const digits = payload.phone?.replace(/\D/g, "");
  const e164 = digits ? toE164(`+${digits}`) : null;
  let attempted = false;
  let transient = false;
  let lastCode = "no_channel";
  const note = (result: SendResult) => {
    if (result.status === "retry") transient = true;
    if (result.status !== "sent") lastCode = result.code;
  };

  if (e164 && via !== "text" && deps.whatsapp) {
    const template = await loadTemplate(database, "whatsapp", key);
    if (template && (template.status === "approved" || deps.allowUnapproved)) {
      attempted = true;
      const result = await send(deps.whatsapp, {
        tenantId: PLATFORM,
        to: e164,
        idempotencyKey: `code-delivery:${id}:whatsapp`,
        content: {
          kind: "template",
          templateKey: key,
          provider: { name: template.provider_name },
          language: template.language,
          variables,
          ...(code ? { copyCode: code } : {}),
        },
      });
      if (result.status === "sent") return { outcome: "sent" };
      note(result);
    }
  }
  if (e164 && deps.sms) {
    const template = await loadTemplate(database, "sms", key);
    if (template && (template.status === "approved" || deps.allowUnapproved)) {
      attempted = true;
      const result = await send(deps.sms, {
        tenantId: PLATFORM,
        to: e164,
        idempotencyKey: `code-delivery:${id}:sms`,
        content: {
          kind: "template",
          templateKey: key,
          provider: { name: template.provider_name, templateId: template.provider_template_id ?? undefined, approvedText: template.body ?? undefined },
          language: template.language,
          variables,
        },
      });
      if (result.status === "sent") return { outcome: "sent" };
      note(result);
    }
  }
  if (payload.email && deps.email) {
    attempted = true;
    try {
      const brand = { businessName: payload.business ?? "Kalendr", logoUrl: null, accentColor: DEFAULT_ACCENT };
      const rendered = purpose === "contact_changed"
        ? await renderEmail("contact_changed", { brand })
        : await renderEmail("sign_in_code", { code: code!, purpose: purpose === "step_up" ? "booking_change" : "sign_in" });
      await deps.email.provider.send({
        to: payload.email,
        fromName: purpose === "contact_changed" ? payload.business : undefined,
        replyTo: deps.email.fallbackReplyTo ?? undefined,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        idempotencyKey: `code-delivery:${id}:email`,
      });
      return { outcome: "sent" };
    } catch (error) {
      if (error instanceof TransientSendError) { transient = true; lastCode = error.failureCode; }
      else if (error instanceof PermanentSendError) lastCode = error.failureCode;
      else throw error;
    }
  }
  if (!attempted && deps.devConsole) {
    // Development only, with no provider connected. The contact is deliberately left out.
    if (code) console.info(`[kalendr dev] customer code: ${code}`);
    return { outcome: "sent" };
  }
  if (transient) return { outcome: "retry", code: lastCode };
  return { outcome: "failed", code: attempted ? lastCode : "provider_not_configured" };
}

/** Claims and sends up to `limit` due rows. Returns how many it handled, so the loop knows whether to wait. */
export async function runCodeDeliveries(database: postgres.Sql, deps: CodeDeliveryDeps, limit = 10): Promise<number> {
  const token = `${deps.workerId.slice(0, 70)}:${randomUUID()}`;
  const rows = await database<ClaimedDelivery[]>`select * from kalendr_claim_code_deliveries(${token}, ${limit})`;
  for (const row of rows) {
    let result: DeliveryOutcome;
    try {
      const payload = openDelivery(row.out_id, row.out_sealed);
      result = payload ? await deliverOne(database, deps, row.out_id, row.out_purpose, row.out_via, payload) : { outcome: "failed", code: "sealed_unreadable" };
    } catch {
      result = { outcome: "retry", code: "worker_error" };
    }
    await database`select kalendr_finish_code_delivery(${row.out_id}, ${token}, ${result.outcome}, ${"code" in result ? result.code : null})`;
  }
  return rows.length;
}

