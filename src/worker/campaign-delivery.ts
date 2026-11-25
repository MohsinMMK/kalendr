/**
 * How a campaign message becomes a WhatsApp or text message (feature 28). Both channels only ever send an approved
 * template: the owner's one line goes into a variable slot and nothing else about the wording changes. A template that is
 * not approved yet is skipped (never sent) outside local capture and tests.
 *
 * Nothing here logs a number, a name or a variable. The codes returned are short and hold none of them.
 */
import { campaignPayloadSchema } from "../lib/campaign-contracts";
import { toE164 } from "../server/channels/phone";
import type { Channel, CostCategory } from "../server/channels/types";
import { suppressionReason } from "../server/messaging/suppression";
import type { ProviderSendRequest, ProviderSendResult } from "./delivery";
import { smsSegmentsFor } from "../server/channels/sms-segments";
import type { TenantDb } from "./handlers/types";

interface TemplateRow {
  language: string;
  provider_name: string;
  provider_template_id: string | null;
  status: string;
  variables: unknown;
  body: string | null;
  cost_category: CostCategory;
}

const skipped = (code: string): ProviderSendResult => ({ status: "skipped", code });

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

async function loadTemplate(tenantDb: TenantDb, channel: "whatsapp" | "sms", key: string, language = "en"): Promise<TemplateRow | undefined> {
  const rows = await tenantDb<TemplateRow[]>`
    select language, provider_name, provider_template_id, status, variables, body, cost_category from message_templates
    where channel = ${channel} and key = ${key} and language in (${language}, 'en')
    order by (language = ${language}) desc limit 1
  `;
  return rows[0];
}

async function loadRecipient(request: ProviderSendRequest): Promise<{ firstName: string; phone: string; business: string } | undefined> {
  // The owner's own test goes to their own number and needs no customer at all.
  if (request.testRecipientPhone) {
    const [tenant] = await request.tenantDb<{ name: string }[]>`select name from tenants where id = ${request.tenantId}`;
    return tenant ? { firstName: "Test", phone: request.testRecipientPhone, business: tenant.name } : undefined;
  }
  const [row] = await request.tenantDb<{ first_name: string; phone: string; business: string }[]>`
    select patient.first_name, patient.phone, tenant.name as business from patients as patient
    join tenants as tenant on tenant.id = patient.tenant_id
    where patient.tenant_id = ${request.tenantId} and patient.id = ${request.patientId}
  `;
  return row ? { firstName: row.first_name, phone: row.phone, business: row.business } : undefined;
}

/** The values for a template's slots, in the order the template lists them. A slot we do not know refuses the message. */
function slotValues(order: unknown, values: Record<string, string>): string[] | null {
  if (!Array.isArray(order)) return null;
  const filled: string[] = [];
  for (const name of order) {
    const value = typeof name === "string" ? values[name] : undefined;
    if (value === undefined) return null;
    filled.push(value);
  }
  return filled;
}

export async function sendCampaignWhatsApp(
  request: ProviderSendRequest,
  options: { channel: Channel; allowUnapproved: boolean; ensureThread: (tenantDb: TenantDb, tenantId: string, patientId: string, e164: string) => Promise<string>; logOutbound: (tenantDb: TenantDb, entry: { tenantId: string; threadId: string; templateKey: string; providerMessageId: string; appointmentId: string | null }) => Promise<void> },
): Promise<ProviderSendResult> {
  const payload = campaignPayloadSchema.safeParse(parseJson(request.body));
  if (!payload.success || !payload.data.template) return { status: "rejected", code: "invalid_event" };
  const recipient = await loadRecipient(request);
  if (!recipient) return skipped("patient_not_found");
  const e164 = toE164(recipient.phone);
  if (!e164) return skipped("invalid_phone");
  const template = await loadTemplate(request.tenantDb, "whatsapp", payload.data.template);
  if (!template) return { status: "rejected", code: "no_whatsapp_template" };
  if (template.status !== "approved" && !options.allowUnapproved) return skipped("template_not_approved");
  const variables = slotValues(template.variables, {
    name: clip(recipient.firstName, 60), business: clip(recipient.business, 60), service: clip(payload.data.service, 60),
    message: clip(payload.data.text.replace(/\s+/g, " "), 160), link: payload.data.bookUrl, unsubscribe: payload.data.unsubscribeUrl,
  });
  if (!variables) return { status: "rejected", code: "unknown_template_variable" };
  const result = await options.channel.send({
    tenantId: request.tenantId, to: e164, idempotencyKey: request.idempotencyKey,
    content: { kind: "template", templateKey: payload.data.template, language: template.language, variables, provider: { name: template.provider_name } },
  });
  if (result.status === "retry") return { status: "retry", code: result.code };
  if (result.status === "rejected") return { status: "rejected", code: result.code };
  // A test goes to the owner's own number, so it is never filed in a customer's thread.
  if (!request.testRecipientPhone) {
    const threadId = await options.ensureThread(request.tenantDb, request.tenantId, request.patientId, e164);
    await options.logOutbound(request.tenantDb, { tenantId: request.tenantId, threadId, templateKey: payload.data.template, providerMessageId: result.providerMessageId, appointmentId: null });
  }
  return { status: "sent", providerMessageId: result.providerMessageId, costCategory: result.costCategory ?? template.cost_category };
}

export async function sendCampaignSms(
  request: ProviderSendRequest,
  options: { channel: Channel; allowUnapproved: boolean; defaultCountry: string; language: string },
): Promise<ProviderSendResult> {
  const payload = campaignPayloadSchema.safeParse(parseJson(request.body));
  if (!payload.success) return { status: "rejected", code: "invalid_event" };
  const recipient = await loadRecipient(request);
  if (!recipient) return skipped("patient_not_found");
  const to = toE164(recipient.phone, options.defaultCountry);
  if (!to) return skipped("invalid_phone");
  if (await suppressionReason(request.tenantDb, request.tenantId, "sms", to)) return skipped("suppressed");
  const template = await loadTemplate(request.tenantDb, "sms", "campaign_message", options.language);
  if (!template) return { status: "rejected", code: "no_sms_template" };
  if (template.status !== "approved" && !options.allowUnapproved) return skipped("template_not_approved");
  const variables = slotValues(template.variables, {
    name: clip(recipient.firstName, 30), business: clip(recipient.business, 30), message: clip(payload.data.text.replace(/\s+/g, " "), 100),
    link: payload.data.bookUrl, unsubscribe: payload.data.unsubscribeUrl,
  });
  if (!variables) return { status: "rejected", code: "unknown_template_variable" };
  const result = await options.channel.send({
    tenantId: request.tenantId, to, idempotencyKey: request.idempotencyKey,
    content: {
      kind: "template", templateKey: "campaign_message", language: template.language, variables,
      provider: { name: template.provider_name, templateId: template.provider_template_id ?? undefined, approvedText: template.body ?? undefined },
    },
  });
  if (result.status === "sent") {
    return { status: "sent", providerMessageId: result.providerMessageId, costCategory: template.cost_category, segments: result.segments ?? smsSegmentsFor(template.body, variables) ?? undefined };
  }
  return result;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

