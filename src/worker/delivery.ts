import { CAMPAIGN_MESSAGE_EVENT } from "../lib/campaign-contracts";
import type { NotificationChannel } from "../lib/notification-routing";
import type { HandlerOutcome, TenantDb } from "./handlers/types";
import type { CaptureMessage } from "./policy";
import { meterSentMessage } from "./plan-gate";

export type WorkerMode = "local_capture" | "production";

export interface OutgoingMessage {
  tenantId: string;
  appointmentId: string | null;
  patientId: string;
  channel: NotificationChannel;
  message: CaptureMessage;
  /**
   * Only for privacy messages (feature 7): an address the handler already holds, used instead of the customer's row.
   * An erasure notice needs it because the row has been cleared by the time the message is sent.
   */
  recipient?: DirectRecipient;
  /** Set only for a workflow's "send me a test": the signed-in staff member's own address, never a customer's. */
  testRecipientEmail?: string;
  /** Set only for a campaign's test send (feature 28): the owner's own number, never a customer's. */
  testRecipientPhone?: string;
}

export interface DirectRecipient {
  email: string;
  name: string;
}

export type DeliveryOutcome = "delivered" | "duplicate" | Exclude<HandlerOutcome, "delivered">;

/** Where a rendered message goes. The handler has already decided it should be sent. */
export interface MessageSink {
  readonly mode: WorkerMode;
  deliver(tenantDb: TenantDb, outgoing: OutgoingMessage, now: Date): Promise<DeliveryOutcome>;
}

/**
 * Records the message in `notifications` as delivered to the local capture sink and nothing
 * else. No customer contact is read and no provider is called. The only mode tests use.
 */
export const localCaptureSink: MessageSink = {
  mode: "local_capture",
  async deliver(tenantDb, { tenantId, appointmentId, channel, message }, now) {
    const inserted = await tenantDb`
      insert into notifications (
        tenant_id, appointment_id, channel, template_key, destination_ciphertext,
        provider_message_id, semantic_key, status, scheduled_at, sent_at, delivered_at,
        attempt_count
      ) values (
        ${tenantId}, ${appointmentId}, ${channel}, ${message.templateKey},
        'local-capture:no-recipient', ${message.semanticKey}, ${message.semanticKey},
        'delivered', ${message.scheduledAt}, ${now}, ${now}, 1
      )
      on conflict (tenant_id, semantic_key) do nothing
      returning id
    `;
    return inserted.length > 0 ? "delivered" : "duplicate";
  },
};

/** What a provider adapter (features 2 to 4) is given. It looks up the recipient itself. */
export interface ProviderSendRequest {
  /** The business's scope, so the adapter can read the recipient and booking under row-level security. */
  tenantDb: TenantDb;
  tenantId: string;
  /** The booking the message is about, or null for a message that isn't about one (a shared document). */
  appointmentId: string | null;
  patientId: string;
  channel: NotificationChannel;
  templateKey: string;
  body: string;
  /** The email subject, for messages whose text comes from a workflow. */
  subject?: string;
  /** A workflow test goes to this address instead of looking up the customer. Only the email adapter honours it. */
  testRecipientEmail?: string;
  /** A campaign test goes to this number instead of the customer's. Only the WhatsApp and text adapters honour it. */
  testRecipientPhone?: string;
  /** Stable for every attempt at this message, so the provider can drop a repeat. */
  idempotencyKey: string;
  /** See OutgoingMessage.recipient. */
  recipient?: DirectRecipient;
}

export type ProviderSendResult =
  /** `costCategory` (WhatsApp) and `segments` (SMS) are stored on the notification for the usage meter. */
  | { status: "sent"; providerMessageId: string; costCategory?: string; segments?: number }
  /**
   * Deliberately not sent: the address bounced or complained before, or the customer has no
   * address for this channel. Recorded as cancelled with the reason, and the event is finished.
   */
  | { status: "skipped"; code: string }
  | { status: "retry"; code: string }
  | { status: "rejected"; code: string };

export interface ProviderAdapter {
  send(request: ProviderSendRequest): Promise<ProviderSendResult>;
}

export type ProviderAdapters = Partial<Record<NotificationChannel, ProviderAdapter>>;

const CODE_PATTERN = /^[a-z0-9_.:-]{1,120}$/;
const safeCode = (code: string) => CODE_PATTERN.test(code) ? code : "provider_error";

/**
 * Production delivery: hands the message to the adapter for its channel. A channel with no
 * adapter goes straight to dead letter as provider_not_configured, so staff see it at once
 * and can try again after the provider is set up. The notification row records the outcome;
 * the destination column holds a marker, never an address.
 */
/** The WhatsApp or SMS template for this message is missing or not approved yet: the message can still go by email. */
const NO_USABLE_TEMPLATE = new Set(["template_not_approved", "no_whatsapp_template", "no_sms_template"]);

export function providerSink(adapters: ProviderAdapters): MessageSink {
  const sink: MessageSink = {
    mode: "production",
    async deliver(tenantDb, outgoing, now) {
      const { tenantId, appointmentId, patientId, channel, message, recipient, testRecipientEmail, testRecipientPhone } = outgoing;
      const semanticKey = message.semanticKey.replace(/^local:[a-z]+:/, `${channel}:`);
      const existing = await tenantDb`
        select status from notifications
        where tenant_id = ${tenantId} and semantic_key = ${semanticKey}
        for update
      `;
      const previous = existing[0] as { status: string } | undefined;
      if (previous && (previous.status === "sending" || previous.status === "delivered")) return "duplicate";

      const adapter = adapters[channel];
      const result: ProviderSendResult = adapter
        ? await adapter.send({
          tenantDb,
          tenantId,
          appointmentId,
          patientId,
          channel,
          templateKey: message.templateKey,
          body: message.body,
          subject: message.subject,
          testRecipientEmail,
          testRecipientPhone,
          idempotencyKey: semanticKey,
          recipient,
        })
        : { status: "rejected", code: "provider_not_configured" };
      if (result.status === "retry") return { outcome: "retry", code: safeCode(result.code) };

      const sent = result.status === "sent";
      const skipped = result.status === "skipped";
      // A booking message whose template Meta or DLT has not approved goes by email instead of vanishing. A campaign
      // (marketing) message does not: its consent is per channel. Tests go only where they were asked to.
      const toEmail = !sent && channel !== "email" && adapters.email !== undefined && NO_USABLE_TEMPLATE.has(result.code)
        && message.templateKey !== CAMPAIGN_MESSAGE_EVENT && !testRecipientPhone && !testRecipientEmail && !recipient;
      const failureCode = sent ? null : safeCode(result.code);
      const status = sent ? "sending" : skipped || toEmail ? "cancelled" : "failed";
      await tenantDb`
        insert into notifications (
          tenant_id, appointment_id, channel, template_key, destination_ciphertext,
          provider_message_id, semantic_key, status, scheduled_at, sent_at, failed_at,
          failure_code, attempt_count, cost_category, segments
        ) values (
          ${tenantId}, ${appointmentId}, ${channel}, ${message.templateKey},
          ${`provider:${channel}`}, ${sent ? result.providerMessageId : null}, ${semanticKey},
          ${status}, ${message.scheduledAt}, ${sent ? now : null},
          ${sent ? null : now}, ${failureCode}, 1,
          ${sent ? result.costCategory ?? null : null}, ${sent ? result.segments ?? null : null}
        )
        on conflict (tenant_id, semantic_key) do update set
          status = excluded.status,
          provider_message_id = excluded.provider_message_id,
          sent_at = excluded.sent_at,
          failed_at = excluded.failed_at,
          failure_code = excluded.failure_code,
          cost_category = excluded.cost_category,
          segments = excluded.segments,
          attempt_count = notifications.attempt_count + 1,
          updated_at = now()
      `;
      // The usage meter counts here and only here: a duplicate returned above, so one message is one count (feature 14).
      if (sent) await meterSentMessage(tenantDb, tenantId, channel, result.costCategory ?? null, result.segments ?? null, now);
      if (toEmail) return sink.deliver(tenantDb, { ...outgoing, channel: "email" }, now);
      return sent || skipped ? "delivered" : { outcome: "dead", code: failureCode ?? "provider_error" };
    },
  };
  return sink;
}
