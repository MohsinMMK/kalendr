import { z } from "zod";

import { postgresDataKeyStore } from "../../server/keys/postgres-store";
import { loadDataKeys } from "../../server/keys/ring";
import { openText } from "../../server/keys/records";
import { withTenant } from "../../db/client";
import { withWorkerDatabase } from "../../server/imports/appointments-import";
import { createConversation, findThreadConversation } from "../../server/assistant/store";
import { hasAssistantModel, resolveAssistantModel, type AssistantLanguageModel } from "../../server/assistant/model";
import { runTurn } from "../../server/assistant/loop";
import { notifyStaffFromWorker } from "../staff-alerts";
import { queueTextReply } from "./channel-events";
import type { EventHandler, TenantDb } from "./types";

/**
 * The booking assistant on WhatsApp (feature 30). The webhook only stores the customer's message and queues the usual inbound
 * event. That event's handler hands free text to this one by queueing `assistant.inbound`, so the model call happens here, in the
 * worker, never inside the webhook request. The reply goes back through the same outbox path as a staff reply, inside the 24-hour window.
 *
 * Nothing here logs a number or a message body, and the outbox payload holds ids only.
 */

export const ASSISTANT_INBOUND_EVENT = "assistant.inbound";

const payloadSchema = z.object({ threadId: z.string(), messageId: z.string(), patientId: z.string() });

/** Queues the assistant for a text, when this business has the assistant on for WhatsApp. Returns whether it did. */
export async function queueAssistantInbound(tenantDb: TenantDb, tenantId: string, input: { threadId: string; messageId: string; patientId: string }): Promise<boolean> {
  // With no model set up the assistant cannot answer, so the message goes to staff exactly as it did before the assistant existed.
  if (!hasAssistantModel()) return false;
  const rows = await tenantDb`select enabled_whatsapp from assistant_settings where tenant_id = ${tenantId}`;
  if (!(rows[0] as { enabled_whatsapp: boolean } | undefined)?.enabled_whatsapp) return false;
  await tenantDb`
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    values (${tenantId}, 'thread', ${input.threadId}, ${ASSISTANT_INBOUND_EVENT}, ${tenantDb.json({ ...input })}, ${`assistant:${input.messageId}`.slice(0, 200)})
    on conflict (tenant_id, dedupe_key) do nothing
  `;
  return true;
}

export interface AssistantInboundDependencies {
  /** The worker's database address: the booking code runs on a small pool of its own, like the appointment import. */
  databaseUrl?: string;
  now: () => Date;
  /** Tests install a model here; the live worker uses the configured one. */
  model?: () => Promise<AssistantLanguageModel | null>;
}

export function assistantInboundHandler(dependencies: AssistantInboundDependencies): EventHandler {
  return async (tenantDb, event) => {
    const payload = payloadSchema.safeParse(event.payload);
    if (!payload.success) return { outcome: "dead", code: "invalid_payload" };
    if (!dependencies.databaseUrl) return { outcome: "dead", code: "database_unavailable" };
    const { threadId, messageId, patientId } = payload.data;

    const stored = (await tenantDb`
      select message.body_ciphertext, tenant.slug
      from messages as message join tenants as tenant on tenant.id = message.tenant_id
      where message.tenant_id = ${event.tenantId} and message.id = ${messageId} and message.thread_id = ${threadId} and message.direction = 'inbound'
    `)[0] as { body_ciphertext: string | null; slug: string } | undefined;
    if (!stored?.body_ciphertext) return "delivered";
    await loadDataKeys(postgresDataKeyStore(tenantDb), event.tenantId);
    const text = openText(event.tenantId, stored.body_ciphertext);
    const now = dependencies.now();

    const turn = await withWorkerDatabase(dependencies.databaseUrl, async () => {
      const model = await (dependencies.model ?? (() => resolveAssistantModel("customer")))();
      const conversationId = await withTenant(event.tenantId, async (transaction) => {
        const existing = await findThreadConversation(transaction, event.tenantId, threadId, now);
        if (existing) return existing.id;
        const created = await createConversation(transaction, event.tenantId, { channel: "whatsapp", patientId, threadId, verifiedPatientIds: [patientId] });
        return created.id;
      });
      return runTurn({ tenantId: event.tenantId, slug: stored.slug, conversationId, model, now, text, sourceKey: `wa:${messageId}` });
    });

    if (turn.kind === "busy") return { outcome: "retry", code: "assistant_busy" };
    if (turn.kind === "duplicate") return "delivered";
    if (turn.held) {
      // A person already has this chat: tell staff there is a new message, send nothing.
      await notifyStaffFromWorker(tenantDb, event.tenantId, { kind: "message", dedupeKey: `message:${messageId}`, link: "/messages", patientId });
      return "delivered";
    }
    await queueTextReply(tenantDb, event.tenantId, threadId, turn.reply, `assistant-reply:${messageId}`);
    // The assistant could only send the booking link (the plan, a cap or the chat's length stopped it): a person still needs to hear about the message.
    if (turn.fallbackLink) await notifyStaffFromWorker(tenantDb, event.tenantId, { kind: "message", dedupeKey: `message:${messageId}`, link: "/messages", patientId });
    return "delivered";
  };
}
