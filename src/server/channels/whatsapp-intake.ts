import "server-only";

/**
 * What the WhatsApp webhook does with a customer's reply, once the signature has passed: find
 * the business it belongs to, store it in that business's thread (the text is sealed with the
 * business's data key), and queue one outbox row so the worker can act on it (a Confirm tap,
 * a STOP, a notice to staff). Nothing in the outbox row is a number or a message body.
 *
 * With one shared number the callback names no business. A button tap names the message of ours
 * it answers, which does. Free text goes to the business that wrote to this number most
 * recently. STOP goes to every business that has written to this number, so one STOP ends
 * them all.
 */
import { sql } from "drizzle-orm";

import { requireDatabase, withTenant, type KalendrTransaction } from "@/db/client";
import { messageTemplates, messageThreads, outboxEvents, threadMessages } from "@/db/schema";
import { and, eq } from "drizzle-orm";

import { loadRecordKeys, sealText, writeKeyVersion } from "../record-crypto";
import { currentTraceParent } from "../tracing";
import { contactHash } from "./phone";
import { isStopMessage } from "./stop-words";
import type { InboundEvent, TemplateStatusEvent } from "./types";

export const CHANNEL_INBOUND_EVENT = "channel.inbound";
const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface InboundPayload {
  threadId: string;
  messageId: string;
  patientId: string;
  kind: "text" | "button" | "other";
  /** Our own button payload, such as "confirm:<appointment id>". Not customer-typed text. */
  buttonPayload: string | null;
  stop: boolean;
}

type Candidate = { tenant_id: string; thread_id: string; patient_id: string };

async function candidatesFor(event: InboundEvent): Promise<Candidate[]> {
  const database = requireDatabase();
  if (event.contextMessageId) {
    const direct = await database.execute<{ tenant_id: string; thread_id: string | null }>(
      sql`select tenant_id, thread_id from kalendr_resolve_provider_message('whatsapp', ${event.contextMessageId})`,
    );
    const hit = direct[0];
    if (hit?.thread_id) {
      const rows = await database.execute<Candidate>(sql`
        select tenant_id, thread_id, patient_id
        from kalendr_resolve_inbound_threads('whatsapp', ${contactHash("whatsapp", event.from)})
        where tenant_id = ${hit.tenant_id} and thread_id = ${hit.thread_id}
      `);
      if (rows[0]) return [rows[0]];
    }
  }
  return [...await database.execute<Candidate>(
    sql`select tenant_id, thread_id, patient_id from kalendr_resolve_inbound_threads('whatsapp', ${contactHash("whatsapp", event.from)})`,
  )];
}

async function store(transaction: KalendrTransaction, candidate: Candidate, event: InboundEvent, stop: boolean): Promise<boolean> {
  await loadRecordKeys(transaction, candidate.tenant_id, { forWrite: true });
  const text = event.content.kind === "text" ? event.content.body
    : event.content.kind === "button" ? event.content.label : null;
  const inserted = await transaction.insert(threadMessages).values({
    tenantId: candidate.tenant_id,
    threadId: candidate.thread_id,
    direction: "inbound",
    kind: event.content.kind,
    bodyCiphertext: text === null ? null : sealText(candidate.tenant_id, text),
    keyVersion: text === null ? null : writeKeyVersion(candidate.tenant_id),
    providerMessageId: event.providerMessageId,
    status: "received",
  }).onConflictDoNothing().returning({ id: threadMessages.id });
  const message = inserted[0];
  if (!message) return false;
  await transaction.update(messageThreads).set({
    unreadCount: sql`${messageThreads.unreadCount} + 1`,
    lastMessageAt: event.receivedAt,
    lastInboundAt: event.receivedAt,
    windowClosesAt: new Date(event.receivedAt.getTime() + WINDOW_MS),
    updatedAt: new Date(),
  }).where(and(eq(messageThreads.tenantId, candidate.tenant_id), eq(messageThreads.id, candidate.thread_id)));
  const payload: InboundPayload = {
    threadId: candidate.thread_id,
    messageId: message.id,
    patientId: candidate.patient_id,
    kind: event.content.kind,
    buttonPayload: event.content.kind === "button" ? event.content.payload.slice(0, 120) : null,
    stop,
  };
  await transaction.insert(outboxEvents).values({
    tenantId: candidate.tenant_id,
    aggregateType: "thread",
    aggregateId: candidate.thread_id,
    eventType: CHANNEL_INBOUND_EVENT,
    payload: { ...payload },
    dedupeKey: `whatsapp:${event.eventId}`.slice(0, 200),
    traceParent: currentTraceParent(),
  }).onConflictDoNothing();
  return true;
}

export interface InboundResult { stored: number; unknown: number }

export async function intakeInbound(events: InboundEvent[]): Promise<InboundResult> {
  const result: InboundResult = { stored: 0, unknown: 0 };
  for (const event of events) {
    const candidates = await candidatesFor(event);
    const stop = event.content.kind === "text" && isStopMessage(event.content.body);
    const targets = stop ? candidates : candidates.slice(0, 1);
    if (targets.length === 0) {
      result.unknown += 1;
      continue;
    }
    for (const candidate of targets) {
      const saved = await withTenant(candidate.tenant_id, (transaction) => store(transaction, candidate, event, stop));
      if (saved) result.stored += 1;
    }
  }
  return result;
}

/** A template's approval changed at Meta. The table has no business in it; a rejected template shows in Settings. */
export async function applyTemplateStatuses(events: TemplateStatusEvent[]): Promise<void> {
  for (const event of events) {
    await requireDatabase().update(messageTemplates).set({
      status: event.status,
      statusReason: event.reason ?? null,
      updatedAt: new Date(),
    }).where(and(
      eq(messageTemplates.channel, "whatsapp"),
      eq(messageTemplates.providerName, event.providerTemplateName),
      eq(messageTemplates.language, event.language),
    ));
  }
}
