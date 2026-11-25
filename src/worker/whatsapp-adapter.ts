/**
 * The worker's WhatsApp adapter: turns one outbox message into one approved-template WhatsApp
 * message and hands it to the Cloud API channel (or the capture channel in tests).
 *
 * It reads the customer and the booking itself, inside the business's row-level security scope,
 * picks the approved template for the event, fills its variables in their approved order, adds
 * the Confirm / Reschedule buttons to a reminder, and records the message in the customer's
 * thread so staff see what was sent. WhatsApp has no idempotency key; the worker's
 * one-row-per-semantic-key guard stops a repeat.
 *
 * Nothing here logs a number, a name, a variable or a body. Codes it returns are short.
 */
import { CAMPAIGN_MESSAGE_EVENT } from "../lib/campaign-contracts";
import { channelTemplateFor, type ChannelTemplateKey } from "../lib/channel-templates";
import { contactHash, toE164 } from "../server/channels/phone";
import type { Channel, CostCategory, TemplateContent } from "../server/channels/types";
import { openManageToken } from "../server/messaging/sealed-link";
import { sendCampaignWhatsApp } from "./campaign-delivery";
import { emailWhen } from "./email-adapter";
import type { ProviderAdapter, ProviderSendRequest, ProviderSendResult } from "./delivery";
import type { TenantDb } from "./handlers/types";

export interface WhatsAppAdapterOptions {
  channel: Channel;
  /** The public origin for links, with no trailing slash. */
  origin: string;
  /** Local capture and tests send templates that Meta has not approved yet. Production never does. */
  allowUnapproved?: boolean;
}

interface TemplateRow {
  provider_name: string;
  status: string;
  language: string;
  cost_category: CostCategory;
  buttons: string[];
}

interface Context {
  business: string;
  timezone: string;
  customerName: string;
  phone: string;
  appointment: {
    id: string;
    startsAt: Date;
    service: string;
    manageToken: string | null;
  } | null;
}

export async function loadTemplate(tenantDb: TenantDb, key: ChannelTemplateKey, language = "en"): Promise<TemplateRow | undefined> {
  const rows = await tenantDb`
    select provider_name, status, language, cost_category, buttons from message_templates
    where channel = 'whatsapp' and key = ${key} and language in (${language}, 'en')
    order by (language = ${language}) desc limit 1
  `;
  return rows[0] as TemplateRow | undefined;
}

async function loadContext(tenantDb: TenantDb, tenantId: string, patientId: string, appointmentId: string | null): Promise<Context | undefined> {
  const rows = await tenantDb`
    select tenant.name as business, tenant.timezone, patient.first_name, patient.phone,
      appointment.id as appointment_id, appointment.starts_at, appointment.manage_token_ciphertext,
      service.name as service_name, location.timezone as location_timezone
    from patients as patient
    join tenants as tenant on tenant.id = patient.tenant_id
    left join appointments as appointment
      on appointment.tenant_id = patient.tenant_id and appointment.id = ${appointmentId}
    left join services as service
      on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
    left join locations as location
      on location.tenant_id = appointment.tenant_id and location.id = appointment.location_id
    where patient.tenant_id = ${tenantId} and patient.id = ${patientId}
  `;
  const row = rows[0] as {
    business: string; timezone: string; first_name: string; phone: string; appointment_id: string | null;
    starts_at: Date | null; manage_token_ciphertext: string | null; service_name: string | null; location_timezone: string | null;
  } | undefined;
  if (!row) return undefined;
  return {
    business: row.business,
    timezone: row.location_timezone || row.timezone,
    customerName: row.first_name,
    phone: row.phone,
    appointment: row.appointment_id && row.starts_at
      ? {
        id: row.appointment_id,
        startsAt: row.starts_at,
        service: row.service_name ?? "",
        manageToken: openManageToken(tenantId, row.appointment_id, row.manage_token_ciphertext),
      }
      : null,
  };
}

/** Values in the template's approved order. A template with fewer slots simply uses the first ones. */
export function templateVariables(key: ChannelTemplateKey, context: Context, origin: string): string[] | null {
  const appointment = context.appointment;
  if (!appointment) return null;
  const when = emailWhen(appointment.startsAt, context.timezone);
  const link = appointment.manageToken ? `${origin}/manage/${encodeURIComponent(appointment.manageToken)}` : origin;
  switch (key) {
    case "cancelled":
      return [context.customerName, context.business, appointment.service, when];
    case "review_request":
      return [context.customerName, context.business, link];
    case "booking_confirmed":
    case "reminder":
    case "rescheduled":
    case "waitlist_offer":
      return [context.customerName, context.business, appointment.service, when, link];
    default:
      return null;
  }
}

/** The waitlist offer template's values, in its approved order: name, business, service, when, link. */
function offerVariables(context: Context, body: string): string[] | null {
  try {
    const fields = JSON.parse(body) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 500) : "");
    if (!text(fields.url)) return null;
    return [context.customerName, context.business, text(fields.service), text(fields.when), text(fields.url)];
  } catch {
    return null;
  }
}

/** The series confirmation's values, in its approved order: name, business, service, "8 visits from Tue 24 Nov, 10:00 am", link. */
function seriesVariables(context: Context, body: string): string[] | null {
  try {
    const fields = JSON.parse(body) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 500) : "");
    if (!text(fields.when)) return null;
    return [context.customerName, context.business, text(fields.service), text(fields.when), text(fields.url) || context.business];
  } catch {
    return null;
  }
}

/** Finds or opens this customer's thread and returns its id. One thread per customer per channel. */
export async function ensureThread(tenantDb: TenantDb, tenantId: string, patientId: string, e164: string): Promise<string> {
  const rows = await tenantDb`
    insert into message_threads (tenant_id, patient_id, channel, contact_hash)
    values (${tenantId}, ${patientId}, 'whatsapp', ${contactHash("whatsapp", e164)})
    on conflict (tenant_id, patient_id, channel) do update set contact_hash = excluded.contact_hash
    returning id
  `;
  return (rows[0] as { id: string }).id;
}

export async function logOutbound(
  tenantDb: TenantDb,
  entry: { tenantId: string; threadId: string; templateKey: string; providerMessageId: string; appointmentId: string | null },
): Promise<void> {
  await tenantDb`
    insert into messages (tenant_id, thread_id, direction, kind, template_key, provider_message_id, status, appointment_id)
    values (${entry.tenantId}, ${entry.threadId}, 'outbound', 'template', ${entry.templateKey}, ${entry.providerMessageId}, 'sent', ${entry.appointmentId})
    on conflict (tenant_id, provider_message_id) do nothing
  `;
  await tenantDb`
    update message_threads set last_message_at = now(), last_outbound_at = now(), updated_at = now()
    where tenant_id = ${entry.tenantId} and id = ${entry.threadId}
  `;
}

/** Builds the approved-template content for one template and booking, or says why not. */
export async function buildTemplateContent(
  tenantDb: TenantDb,
  input: { tenantId: string; patientId: string; appointmentId: string | null; key: ChannelTemplateKey; origin: string; allowUnapproved: boolean; body?: string },
): Promise<{ content: TemplateContent; e164: string; cost: CostCategory } | { skip: string }> {
  const context = await loadContext(tenantDb, input.tenantId, input.patientId, input.appointmentId);
  if (!context) return { skip: "patient_not_found" };
  const e164 = toE164(context.phone);
  if (!e164) return { skip: "invalid_phone" };
  const template = await loadTemplate(tenantDb, input.key);
  if (!template) return { skip: "no_whatsapp_template" };
  if (template.status !== "approved" && !input.allowUnapproved) return { skip: "template_not_approved" };
  // An offered time (feature 21) is about no booking: the handler put its details, with the private link, in the body.
  const variables = input.key === "waitlist_offer"
    ? offerVariables(context, input.body ?? "")
    : input.key === "series_confirmed" ? seriesVariables(context, input.body ?? "") : templateVariables(input.key, context, input.origin);
  if (!variables) return { skip: "appointment_not_found" };
  const buttons = input.key === "reminder" && context.appointment
    ? [
      { label: template.buttons[0] ?? "Confirm", payload: `confirm:${context.appointment.id}` },
      { label: template.buttons[1] ?? "Reschedule", payload: `reschedule:${context.appointment.id}` },
    ]
    : undefined;
  return {
    e164,
    cost: template.cost_category,
    content: {
      kind: "template",
      templateKey: input.key,
      language: template.language,
      variables,
      buttons,
      provider: { name: template.provider_name },
    },
  };
}

export function createWhatsAppAdapter({ channel, origin, allowUnapproved = false }: WhatsAppAdapterOptions): ProviderAdapter {
  return {
    async send(request: ProviderSendRequest): Promise<ProviderSendResult> {
      const { tenantDb, tenantId, patientId, appointmentId, templateKey, idempotencyKey } = request;
      // A marketing message (feature 28): its approved template and one line travel in the body.
      if (templateKey === CAMPAIGN_MESSAGE_EVENT) return sendCampaignWhatsApp(request, { channel, allowUnapproved, ensureThread, logOutbound });
      const key = channelTemplateFor(templateKey);
      if (!key) return { status: "rejected", code: "no_whatsapp_template" };
      const built = await buildTemplateContent(tenantDb, { tenantId, patientId, appointmentId, key, origin, allowUnapproved, body: request.body });
      if ("skip" in built) return { status: "skipped", code: built.skip };

      const result = await channel.send({ tenantId, to: built.e164, content: built.content, idempotencyKey });
      if (result.status === "retry") return { status: "retry", code: result.code };
      if (result.status === "rejected") return { status: "rejected", code: result.code };

      const threadId = await ensureThread(tenantDb, tenantId, patientId, built.e164);
      await logOutbound(tenantDb, { tenantId, threadId, templateKey: key, providerMessageId: result.providerMessageId, appointmentId });
      return { status: "sent", providerMessageId: result.providerMessageId, costCategory: result.costCategory ?? built.cost };
    },
  };
}
