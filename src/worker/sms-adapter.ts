/**
 * The worker's SMS adapter: turns one outbox message into one text made from an approved DLT
 * template. It reads the customer and the booking itself, inside the business's row-level
 * security scope, checks the suppression list, and sends variables only (see the channel).
 *
 * The message's semantic key goes to the channel as the idempotency key. Only the capture
 * server honours it: neither MSG91 nor Twilio takes one, so a retry after a timeout whose text
 * did go out sends it again. Nothing here logs. Codes it returns are short and never hold a number, a
 * name or a body.
 */
import { CAMPAIGN_MESSAGE_EVENT } from "../lib/campaign-contracts";
import { sendCampaignSms } from "./campaign-delivery";
import { shortLinkUrl, ensureShortLink, shortLinkExpiry } from "../server/channels/short-link-code";
import { toE164 } from "../server/channels/phone";
import { smsSegmentsFor } from "../server/channels/sms-segments";
import type { Channel } from "../server/channels/types";
import { suppressionReason } from "../server/messaging/suppression";
import type { ProviderAdapter, ProviderSendRequest, ProviderSendResult } from "./delivery";
import type { TenantDb } from "./handlers/types";

export interface SmsAdapterOptions {
  channel: Channel;
  /** The public origin for links, with no trailing slash. */
  origin: string;
  /** Template language to prefer. Falls back to English when the template has no such row. */
  language?: string;
  /**
   * Send even when the template is not yet approved by DLT. Only local capture and tests set
   * this; production leaves it off so an unapproved template is skipped, never sent.
   */
  allowUnapproved?: boolean;
  /** Region used to read numbers typed without a country code. */
  defaultCountry?: string;
}

export type SmsTemplateKey = "booking_confirmed" | "reminder" | "rescheduled" | "cancelled";

/** Which SMS template an appointment event becomes. Null means this event has no SMS. */
export function smsTemplateKeyFor(eventType: string): SmsTemplateKey | null {
  switch (eventType) {
    case "appointment.created":
    case "appointment.confirm":
    case "appointment.status.booked":
      return "booking_confirmed";
    case "appointment.reminder":
      return "reminder";
    case "appointment.reschedule":
    case "appointment.suggest":
      return "rescheduled";
    case "appointment.cancel":
    case "appointment.status.cancelled":
      return "cancelled";
    default:
      return null;
  }
}


interface TemplateRow {
  language: string;
  provider_name: string;
  provider_template_id: string | null;
  status: string;
  variables: unknown;
  body: string | null;
}

/** "Mon 16 Nov, 10:30 am": short on purpose, because every character is billed. */
export function smsWhen(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone,
  }).format(date);
}

/** DLT variable slots are short; a long clinic name would be refused by the network. */
const clip = (value: string) => (value.length > 30 ? `${value.slice(0, 29)}…` : value);

const skipped = (code: string): ProviderSendResult => ({ status: "skipped", code });

async function loadTemplate(tenantDb: TenantDb, key: string, language: string): Promise<TemplateRow | undefined> {
  const rows = await tenantDb<TemplateRow[]>`
    select language, provider_name, provider_template_id, status, variables, body
    from message_templates
    where channel = 'sms' and key = ${key} and language in (${language}, 'en')
    order by (language = ${language}) desc
    limit 1
  `;
  return rows[0];
}

export function createSmsAdapter({ channel, origin, language = "en", allowUnapproved = false, defaultCountry = "IN" }: SmsAdapterOptions): ProviderAdapter {
  return {
    async send(request: ProviderSendRequest): Promise<ProviderSendResult> {
      const { tenantDb, tenantId, patientId, appointmentId, templateKey: eventType, idempotencyKey } = request;
      // A marketing message (feature 28) carries its own approved template and one line in the body.
      if (eventType === CAMPAIGN_MESSAGE_EVENT) return sendCampaignSms(request, { channel, allowUnapproved, defaultCountry, language });
      const templateKey = smsTemplateKeyFor(eventType);
      if (!templateKey) return { status: "rejected", code: "no_sms_template" };
      if (!appointmentId) return { status: "rejected", code: "invalid_event" };

      const [tenantRows, patientRows, appointmentRows] = await Promise.all([
        tenantDb<{ name: string; timezone: string }[]>`select name, timezone from tenants where id = ${tenantId}`,
        tenantDb<{ first_name: string; phone: string | null }[]>`
          select first_name, phone from patients where tenant_id = ${tenantId} and id = ${patientId}`,
        tenantDb<{ starts_at: Date; ends_at: Date; location_timezone: string | null }[]>`
          select appointment.starts_at, appointment.ends_at, location.timezone as location_timezone
          from appointments as appointment
          join locations as location on location.tenant_id = appointment.tenant_id and location.id = appointment.location_id
          where appointment.tenant_id = ${tenantId} and appointment.id = ${appointmentId}`,
      ]);
      const tenant = tenantRows[0];
      const patient = patientRows[0];
      const appointment = appointmentRows[0];
      if (!tenant) return { status: "rejected", code: "tenant_not_found" };
      if (!appointment) return skipped("appointment_not_found");
      if (!patient?.phone?.trim()) return skipped("no_destination");
      const to = toE164(patient.phone, defaultCountry);
      if (!to) return skipped("invalid_phone");

      const suppressed = await suppressionReason(tenantDb, tenantId, "sms", to);
      if (suppressed) return skipped(`suppressed_${suppressed}`);

      const template = await loadTemplate(tenantDb, templateKey, language);
      if (!template) return { status: "rejected", code: "no_sms_template" };
      if (template.status !== "approved" && !allowUnapproved) return skipped("template_not_approved");

      const order = Array.isArray(template.variables) ? template.variables : [];
      const values = new Map<string, () => Promise<string>>([
        ["name", async () => clip(patient.first_name)],
        ["business", async () => clip(tenant.name)],
        ["when", async () => smsWhen(appointment.starts_at, appointment.location_timezone || tenant.timezone)],
        ["link", async () => shortLinkUrl(origin, await ensureShortLink(tenantDb, {
          tenantId, appointmentId, expiresAt: shortLinkExpiry(appointment.ends_at),
        }))],
      ]);
      const variables: string[] = [];
      for (const name of order) {
        const make = typeof name === "string" ? values.get(name) : undefined;
        if (!make) return { status: "rejected", code: "unknown_template_variable" };
        variables.push(await make());
      }

      const result = await channel.send({
        tenantId,
        to,
        idempotencyKey,
        content: {
          kind: "template",
          templateKey,
          provider: {
            name: template.provider_name,
            templateId: template.provider_template_id ?? undefined,
            approvedText: template.body ?? undefined,
          },
          language: template.language,
          variables,
        },
      });
      if (result.status === "sent") {
        return {
          status: "sent",
          providerMessageId: result.providerMessageId,
          segments: result.segments ?? smsSegmentsFor(template.body, variables) ?? undefined,
        };
      }
      return result;
    },
  };
}
