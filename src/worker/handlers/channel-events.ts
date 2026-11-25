/**
 * The worker's side of WhatsApp and SMS: applying a provider's delivery status, acting on a
 * customer's reply (a Confirm tap, a Reschedule tap, STOP), sending a staff reply, and queueing
 * the one SMS fallback when WhatsApp fails.
 *
 * Every handler works inside the business's row-level security scope and is safe to run twice.
 * Nothing here logs a number or a message body; payloads hold ids and short codes only.
 */
import { z } from "zod";

import { replyTemplateKeys, type ChannelTemplateKey } from "../../lib/channel-templates";
import { meterSentMessage } from "../plan-gate";
import { toE164 } from "../../server/channels/phone";
import type { Channel } from "../../server/channels/types";
import { postgresDataKeyStore } from "../../server/keys/postgres-store";
import { loadDataKeys } from "../../server/keys/ring";
import { openText, sealText, writeKeyVersion } from "../../server/keys/records";
import { notifyStaffFromWorker } from "../staff-alerts";
import { openManageToken } from "../../server/messaging/sealed-link";
import { buildTemplateContent } from "../whatsapp-adapter";
import { queueAssistantInbound } from "./assistant-inbound";
import { appointmentMessageHandler, type HandlerDependencies } from "./appointment-message";
import type { EventHandler, OutboxEvent, TenantDb } from "./types";

export const CHANNEL_STATUS_EVENT = "channel.status";
export const CHANNEL_INBOUND_EVENT = "channel.inbound";
export const THREAD_REPLY_EVENT = "thread.reply";
export const SMS_FALLBACK_EVENT = "notification.sms_fallback";

const statusPayload = z.object({
  channel: z.enum(["whatsapp", "sms"]),
  providerMessageId: z.string(),
  state: z.enum(["sent", "delivered", "read", "failed"]),
  failureCode: z.string().nullable(),
  costCategory: z.string().nullable().optional(),
  notificationId: z.string().nullable(),
  messageId: z.string().nullable(),
});

/** A status never moves a message backwards: delivered then a late "sent" changes nothing. */
const RANK = "array_position(array['queued','sent','delivered','read'], status)";

export function channelStatusHandler(): EventHandler {
  return async (tenantDb, event) => {
    const payload = statusPayload.safeParse(event.payload);
    if (!payload.success) return { outcome: "dead", code: "invalid_payload" };
    const { state, notificationId, messageId, failureCode, channel } = payload.data;

    let failedNotification: { appointment_id: string | null } | undefined;
    if (notificationId) {
      if (state === "delivered" || state === "read") {
        await tenantDb`
          update notifications set
            status = case when status in ('queued', 'sending') then 'delivered' else status end,
            delivered_at = coalesce(delivered_at, now()),
            read_at = case when ${state} = 'read' then coalesce(read_at, now()) else read_at end,
            cost_category = coalesce(${payload.data.costCategory ?? null}, cost_category),
            updated_at = now()
          where tenant_id = ${event.tenantId} and id = ${notificationId}
        `;
      } else if (state === "failed") {
        const rows = await tenantDb`
          update notifications set status = 'failed', failed_at = now(), failure_code = ${failureCode ?? "provider_failed"}, updated_at = now()
          where tenant_id = ${event.tenantId} and id = ${notificationId} and status in ('queued', 'sending')
          returning appointment_id
        `;
        failedNotification = rows[0] as { appointment_id: string | null } | undefined;
      } else if (payload.data.costCategory) {
        await tenantDb`
          update notifications set cost_category = ${payload.data.costCategory} where tenant_id = ${event.tenantId} and id = ${notificationId}
        `;
      }
    }
    if (messageId) {
      if (state === "failed") {
        await tenantDb`
          update messages set status = 'failed', failure_code = ${failureCode ?? "provider_failed"}, updated_at = now()
          where tenant_id = ${event.tenantId} and id = ${messageId} and status in ('queued', 'sent')
        `;
      } else {
        await tenantDb`
          update messages set status = ${state}, updated_at = now()
          where tenant_id = ${event.tenantId} and id = ${messageId}
            and ${tenantDb.unsafe(RANK)} < array_position(array['queued','sent','delivered','read'], ${state})
        `;
      }
    }
    // WhatsApp said it could not deliver: queue the SMS version once. The event's dedupe key is the
    // notification id, so a repeated failure callback queues nothing more.
    if (failedNotification?.appointment_id && channel === "whatsapp" && notificationId) {
      await tenantDb`
        insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
        values (${event.tenantId}, 'notification', ${notificationId}, ${SMS_FALLBACK_EVENT},
          ${tenantDb.json({ notificationId })}, ${`sms-fallback:${notificationId}`})
        on conflict (tenant_id, dedupe_key) do nothing
      `;
    }
    return "delivered";
  };
}

/**
 * Sends the SMS version of a message WhatsApp could not deliver. It finds the outbox event the
 * original message came from (the notification's key is a hash of that event's dedupe key) and
 * runs it again with SMS forced, so the same freshness rules apply: a booking that has since
 * moved or been cancelled sends nothing.
 */
export function smsFallbackHandler(dependencies: HandlerDependencies): EventHandler {
  const deliver = appointmentMessageHandler(dependencies, undefined, { forceChannel: "sms" });
  return async (tenantDb, event) => {
    const payload = z.object({ notificationId: z.string() }).safeParse(event.payload);
    if (!payload.success) return { outcome: "dead", code: "invalid_payload" };
    const notification = (await tenantDb`
      select semantic_key from notifications where tenant_id = ${event.tenantId} and id = ${payload.data.notificationId}
    `)[0] as { semantic_key: string } | undefined;
    if (!notification) return "delivered";
    const hash = notification.semantic_key.replace(/^[a-z]+:/, "");
    const original = (await tenantDb`
      select id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, attempt_count
      from outbox_events
      where tenant_id = ${event.tenantId} and encode(sha256(convert_to(dedupe_key, 'UTF8')), 'hex') = ${hash}
      limit 1
    `)[0] as { id: string; aggregate_type: string; aggregate_id: string; event_type: string; payload: unknown; dedupe_key: string; attempt_count: number } | undefined;
    if (!original) return "delivered";
    const replay: OutboxEvent = {
      id: original.id,
      tenantId: event.tenantId,
      aggregateType: original.aggregate_type,
      aggregateId: original.aggregate_id,
      eventType: original.event_type,
      payload: original.payload,
      dedupeKey: original.dedupe_key,
      attemptCount: event.attemptCount,
    };
    return deliver(tenantDb, replay);
  };
}

const inboundPayload = z.object({
  threadId: z.string(),
  messageId: z.string(),
  patientId: z.string(),
  kind: z.enum(["text", "button", "other"]),
  buttonPayload: z.string().nullable(),
  stop: z.boolean(),
});

/** Queues an outbound text on a thread (sealed with the business's key) and the outbox row that sends it. */
export async function queueTextReply(tenantDb: TenantDb, tenantId: string, threadId: string, text: string, dedupe: string): Promise<void> {
  await loadDataKeys(postgresDataKeyStore(tenantDb), tenantId, { forWrite: true });
  const rows = await tenantDb`
    insert into messages (tenant_id, thread_id, direction, kind, body_ciphertext, key_version, status)
    values (${tenantId}, ${threadId}, 'outbound', 'text', ${sealText(tenantId, text)}, ${writeKeyVersion(tenantId)}, 'queued')
    returning id
  `;
  const messageId = (rows[0] as { id: string }).id;
  await tenantDb`
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    values (${tenantId}, 'thread', ${threadId}, ${THREAD_REPLY_EVENT}, ${tenantDb.json({ messageId })}, ${dedupe.slice(0, 200)})
    on conflict (tenant_id, dedupe_key) do nothing
  `;
}

/**
 * Records that a customer no longer wants marketing: a withdrawal in the consent history (only when they had agreed, so a
 * second STOP changes nothing) and an opt-out for the WhatsApp channel. Appointment messages are untouched.
 */
async function withdrawMarketing(tenantDb: TenantDb, tenantId: string, patientId: string): Promise<void> {
  const [latest] = await tenantDb<{ granted: boolean }[]>`
    select granted from consent_records where tenant_id = ${tenantId} and patient_id = ${patientId} and purpose = 'marketing_messages'
    order by created_at desc, id desc limit 1
  `;
  if (latest?.granted) {
    await tenantDb`
      insert into consent_records (tenant_id, patient_id, purpose, granted, wording_version, source, actor_type)
      values (${tenantId}, ${patientId}, 'marketing_messages', false, 'stop', 'whatsapp_stop', 'provider')
    `;
  }
  await tenantDb`
    insert into marketing_preferences (tenant_id, patient_id, channel, opted_in, source, changed_at)
    values (${tenantId}, ${patientId}, 'whatsapp', false, 'whatsapp_stop', now())
    on conflict (tenant_id, patient_id, channel) do update set opted_in = false, source = excluded.source, changed_at = excluded.changed_at
  `;
}

export function channelInboundHandler({ origin = "" }: HandlerDependencies): EventHandler {
  return async (tenantDb, event) => {
    const payload = inboundPayload.safeParse(event.payload);
    if (!payload.success) return { outcome: "dead", code: "invalid_payload" };
    const { threadId, patientId, messageId } = payload.data;
    const tenant = (await tenantDb`select name from tenants where id = ${event.tenantId}`)[0] as { name: string } | undefined;
    const business = tenant?.name ?? "this business";

    if (payload.data.stop) {
      // STOP always ends marketing (feature 28): the answer is recorded as a withdrawal and the channel is marked opted out.
      await withdrawMarketing(tenantDb, event.tenantId, patientId);
      // A STOP sent in reply to a marketing message only ends marketing. Reminders and booking messages carry on.
      const [lastOutbound] = await tenantDb<{ template_key: string | null }[]>`
        select template_key from messages where tenant_id = ${event.tenantId} and thread_id = ${threadId} and direction = 'outbound'
        order by created_at desc, id desc limit 1
      `;
      const marketingOnly = Boolean(lastOutbound?.template_key?.startsWith("campaign_"));
      if (!marketingOnly) {
        await tenantDb`
          update patients set messaging_consent_at = null, updated_at = now()
          where tenant_id = ${event.tenantId} and id = ${patientId}
        `;
        // The ledger row is what stops a later form from quietly turning messages back on (feature 7). Appointment
        // messages default to yes, so a customer who never answered still gets a row.
        const [latest] = await tenantDb<{ granted: boolean }[]>`
          select granted from consent_records where tenant_id = ${event.tenantId} and patient_id = ${patientId} and purpose = 'appointment_messages'
          order by created_at desc, id desc limit 1
        `;
        if (latest?.granted !== false) {
          await tenantDb`
            insert into consent_records (tenant_id, patient_id, purpose, granted, wording_version, source, actor_type)
            values (${event.tenantId}, ${patientId}, 'appointment_messages', false, 'stop', 'whatsapp_stop', 'provider')
          `;
        }
      }
      // The record of the withdrawal (feature 7 reads this). No message text goes in the metadata.
      await tenantDb`
        insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
        values (${event.tenantId}, 'patient', 'consent.messaging_withdrawn', 'success', ${tenantDb.json({ channel: "whatsapp", threadId, marketingOnly })})
      `;
      await queueTextReply(
        tenantDb, event.tenantId, threadId,
        marketingOnly
          ? `You won't get marketing messages from ${business} any more. You'll still get messages about your appointments.`
          : `You won't get WhatsApp or text messages from ${business} any more. We'll use email instead.`,
        `stop-confirm:${messageId}`,
      );
      return "delivered";
    }

    if (payload.data.kind === "button" && payload.data.buttonPayload) {
      const [action, appointmentId] = payload.data.buttonPayload.split(":");
      if (!appointmentId) return "delivered";
      if (action === "confirm") {
        const rows = await tenantDb`
          select id, version, status, confirmation_status from appointments
          where tenant_id = ${event.tenantId} and id = ${appointmentId} and patient_id = ${patientId}
          for update
        `;
        const current = rows[0] as { id: string; version: number; status: string; confirmation_status: string } | undefined;
        if (current && current.status === "booked" && current.confirmation_status !== "confirmed") {
          const next = current.version + 1;
          const updated = await tenantDb`
            update appointments set confirmation_status = 'confirmed', version = ${next}, updated_at = now()
            where tenant_id = ${event.tenantId} and id = ${current.id} and version = ${current.version}
            returning id
          `;
          if (updated.length > 0) {
            await tenantDb`
              insert into audit_events (tenant_id, appointment_id, actor_type, action, outcome, metadata)
              values (${event.tenantId}, ${current.id}, 'patient', 'appointment.confirm', 'success', ${tenantDb.json({ version: next, via: "whatsapp" })})
            `;
            await tenantDb`
              insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
              values (${event.tenantId}, 'appointment', ${current.id}, 'appointment.confirm',
                ${tenantDb.json({ appointmentId: current.id, version: next })}, ${`appointment.confirm:${current.id}:${next}`})
              on conflict (tenant_id, dedupe_key) do nothing
            `;
          }
        }
      } else if (action === "reschedule") {
        const row = (await tenantDb`
          select manage_token_ciphertext from appointments
          where tenant_id = ${event.tenantId} and id = ${appointmentId} and patient_id = ${patientId}
        `)[0] as { manage_token_ciphertext: string | null } | undefined;
        const token = row ? openManageToken(event.tenantId, appointmentId, row.manage_token_ciphertext) : null;
        if (token) {
          await queueTextReply(
            tenantDb, event.tenantId, threadId,
            `You can pick a new time here: ${origin}/manage/${encodeURIComponent(token)}`,
            `reschedule-link:${messageId}`,
          );
        }
      }
    }
    // The booking assistant (feature 30) answers free text when the business switched it on; it queues its own event, so the model call stays off this one.
    if (payload.data.kind === "text" && await queueAssistantInbound(tenantDb, event.tenantId, { ...payload.data })) return "delivered";
    // Free text and anything else waits in the inbox with an unread count. Staff who chose to hear about messages are told here
    // (feature 56): a first name and a link to the inbox, never what the customer wrote.
    await notifyStaffFromWorker(tenantDb, event.tenantId, { kind: "message", dedupeKey: `message:${messageId}`, link: "/messages", patientId });
    return "delivered";
  };
}

const isReplyTemplate = (key: string): key is ChannelTemplateKey => (replyTemplateKeys as readonly string[]).includes(key);

const replyPayload = z.object({
  messageId: z.string(),
  /** Set for an approved-template reply (used once the 24-hour window has closed). */
  templateKey: z.string().optional(),
  appointmentId: z.string().nullable().optional(),
});

/** Sends one queued staff reply, as free text inside the 24-hour window or as an approved template. */
export function threadReplyHandler({ channels, origin = "", now }: HandlerDependencies & { origin?: string }, allowUnapproved: boolean): EventHandler {
  return async (tenantDb, event) => {
    const payload = replyPayload.safeParse(event.payload);
    if (!payload.success) return { outcome: "dead", code: "invalid_payload" };
    const row = (await tenantDb`
      select message.id, message.status, message.body_ciphertext, message.thread_id,
        thread.patient_id, thread.window_closes_at, patient.phone
      from messages as message
      join message_threads as thread on thread.tenant_id = message.tenant_id and thread.id = message.thread_id
      join patients as patient on patient.tenant_id = thread.tenant_id and patient.id = thread.patient_id
      where message.tenant_id = ${event.tenantId} and message.id = ${payload.data.messageId} and message.direction = 'outbound'
      for update of message
    `)[0] as {
      id: string; status: string; body_ciphertext: string | null; thread_id: string; patient_id: string;
      window_closes_at: Date | null; phone: string;
    } | undefined;
    if (!row || row.status !== "queued") return "delivered";

    const fail = async (code: string) => {
      await tenantDb`
        update messages set status = 'failed', failure_code = ${code}, updated_at = now()
        where tenant_id = ${event.tenantId} and id = ${row.id}
      `;
      return "delivered" as const;
    };
    const channel: Channel | undefined = channels?.whatsapp;
    if (!channel) return fail("provider_not_configured");
    const e164 = toE164(row.phone);
    if (!e164) return fail("invalid_phone");

    let message: Parameters<Channel["send"]>[0];
    if (payload.data.templateKey) {
      const key = payload.data.templateKey;
      if (!isReplyTemplate(key)) return fail("template_not_allowed");
      const built = await buildTemplateContent(tenantDb, {
        tenantId: event.tenantId, patientId: row.patient_id, appointmentId: payload.data.appointmentId ?? null,
        key, origin, allowUnapproved,
      });
      if ("skip" in built) return fail(built.skip);
      message = { tenantId: event.tenantId, to: built.e164, content: built.content, idempotencyKey: `reply:${row.id}` };
    } else {
      // Free text is only allowed while the customer's last message is under 24 hours old.
      if (!row.window_closes_at || row.window_closes_at.getTime() <= now().getTime()) return fail("window_closed");
      if (!row.body_ciphertext) return fail("empty_message");
      await loadDataKeys(postgresDataKeyStore(tenantDb), event.tenantId);
      message = { tenantId: event.tenantId, to: e164, content: { kind: "text", body: openText(event.tenantId, row.body_ciphertext) }, idempotencyKey: `reply:${row.id}` };
    }

    const result = await channel.send(message);
    if (result.status === "retry") return { outcome: "retry", code: result.code };
    if (result.status === "rejected") return fail(result.code);
    await tenantDb`
      update messages set status = 'sent', provider_message_id = ${result.providerMessageId}, updated_at = now()
      where tenant_id = ${event.tenantId} and id = ${row.id}
    `;
    await tenantDb`
      update message_threads set last_message_at = now(), last_outbound_at = now(), updated_at = now()
      where tenant_id = ${event.tenantId} and id = ${row.thread_id}
    `;
    // A staff reply is a sent WhatsApp message too, so the usage meter counts it (feature 14). Only reached once: the row left "queued" above.
    await meterSentMessage(tenantDb, event.tenantId, "whatsapp", payload.data.templateKey ? null : "service", null, now());
    return "delivered";
  };
}
