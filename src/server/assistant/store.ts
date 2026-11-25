import "server-only";

import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { z } from "zod";

import type { KalendrTransaction } from "@/db/client";

import { createOpaqueToken, sha256 } from "../crypto";
import { loadRecordKeys, openText, sealText, writeKeyVersion } from "../record-crypto";
import { blockSchema, type LlmBlock, type LlmMessage } from "./model";
import { encodeUiMessage, readUiEnvelope, textOfUiParts, type StoredUiMessage } from "./stored-format";

/**
 * Where the assistant keeps its conversations (feature 30). Every message, the proposal waiting for a yes and the phone number a
 * code was sent to are sealed with the business's own key, like thread messages. Nothing in here logs a body.
 */

/** A turn must end before this: the model client times out at 30 s with one retry, and the loop stops starting calls after TURN_BUDGET_MS. */
export const LEASE_SECONDS = 150;

export type ConversationChannel = "web" | "whatsapp" | "sms" | "staff";
export type ConversationStatus = "active" | "handed_off" | "closed";

/** The change a customer is being asked to confirm. Kept sealed; only the id is ever shown on a screen. */
export const pendingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("book"),
    summary: z.string(),
    /** The turn that made this proposal. A typed "yes" counts only on the very next turn; a tapped Confirm counts until it expires. */
    atTurn: z.number().int(),
    serviceId: z.string(), serviceName: z.string(), personId: z.string(), personName: z.string(),
    locationId: z.string(), startsAt: z.string(), endsAt: z.string(), holdToken: z.string().nullable(),
    firstName: z.string(), lastName: z.string(), phone: z.string(), email: z.string().default(""),
  }),
  z.object({ kind: z.literal("reschedule"), summary: z.string(), atTurn: z.number().int(), appointmentId: z.string(), version: z.number().int(), personId: z.string(), startsAt: z.string() }),
  z.object({ kind: z.literal("cancel"), summary: z.string(), atTurn: z.number().int(), appointmentId: z.string(), version: z.number().int() }),
  // The copilot's proposal for a staff member to confirm: a booking for a customer already on the books.
  z.object({
    kind: z.literal("staff_book"),
    summary: z.string(),
    atTurn: z.number().int(),
    patientId: z.string(), serviceId: z.string(), personId: z.string(), locationId: z.string(), startsAt: z.string(),
  }),
]);
export type Pending = z.infer<typeof pendingSchema>;

export interface Conversation {
  id: string;
  tenantId: string;
  channel: ConversationChannel;
  status: ConversationStatus;
  patientId: string | null;
  threadId: string | null;
  staffUserId: string | null;
  turnCount: number;
  failureCount: number;
  pendingId: string | null;
  pendingExpiresAt: Date | null;
  verifiedPatientIds: string[];
  shownAppointmentIds: string[];
  otpSentAt: Date | null;
  hasOtpPhone: boolean;
  lastActivityAt: Date;
}

interface ConversationRow extends Record<string, unknown> {
  id: string; tenant_id: string; channel: ConversationChannel; status: ConversationStatus; patient_id: string | null; thread_id: string | null;
  staff_user_id: string | null; turn_count: number; failure_count: number; pending_id: string | null; pending_expires_at: Date | string | null;
  verified_patient_ids: string[]; shown_appointment_ids: string[]; otp_sent_at: Date | string | null; otp_phone_ciphertext: string | null; last_activity_at: Date | string;
}

const columns = sql.raw(`id, tenant_id, channel, status, patient_id, thread_id, staff_user_id, turn_count, failure_count, pending_id, pending_expires_at,
  verified_patient_ids, shown_appointment_ids, otp_sent_at, otp_phone_ciphertext, last_activity_at`);

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id, tenantId: row.tenant_id, channel: row.channel, status: row.status, patientId: row.patient_id, threadId: row.thread_id,
    staffUserId: row.staff_user_id, turnCount: row.turn_count, failureCount: row.failure_count, pendingId: row.pending_id,
    pendingExpiresAt: row.pending_expires_at ? asDate(row.pending_expires_at) : null, verifiedPatientIds: row.verified_patient_ids, shownAppointmentIds: row.shown_appointment_ids,
    otpSentAt: row.otp_sent_at ? asDate(row.otp_sent_at) : null, hasOtpPhone: row.otp_phone_ciphertext !== null, lastActivityAt: asDate(row.last_activity_at),
  };
}

/** The database driver hands timestamps back as text and wants text in; these two keep Dates out of the SQL. */
export const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
const stamp = (value: Date) => sql`${value.toISOString()}::timestamptz`;

export function textArray(values: readonly string[]) {
  if (values.length === 0) return sql`'{}'::text[]`;
  return sql`array[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}

/** A web chat's secret: 256 random bits. Only its hash is stored. */
export function newWebToken(): { token: string; hash: string } {
  const token = createOpaqueToken();
  return { token, hash: sha256(token) };
}

/** An id the Confirm button carries. Not a secret on its own: the server also checks the conversation it belongs to. */
export function newProposalId(): string {
  return randomBytes(24).toString("base64url");
}

export async function createConversation(transaction: KalendrTransaction, tenantId: string, input: {
  channel: ConversationChannel; tokenHash?: string; patientId?: string; threadId?: string; staffUserId?: string; verifiedPatientIds?: readonly string[];
}): Promise<Conversation> {
  const rows = await transaction.execute<ConversationRow>(sql`
    insert into assistant_conversations (tenant_id, channel, token_hash, patient_id, thread_id, staff_user_id, verified_patient_ids, verified_at)
    values (${tenantId}, ${input.channel}, ${input.tokenHash ?? null}, ${input.patientId ?? null}, ${input.threadId ?? null}, ${input.staffUserId ?? null},
      ${textArray(input.verifiedPatientIds ?? [])}, ${input.verifiedPatientIds?.length ? sql`now()` : sql`null`})
    returning ${columns}
  `);
  const row = rows[0];
  if (!row) throw new Error("Conversation was not created");
  return toConversation(row);
}

export async function findWebConversation(transaction: KalendrTransaction, tenantId: string, tokenHash: string): Promise<Conversation | null> {
  const rows = await transaction.execute<ConversationRow>(sql`
    select ${columns} from assistant_conversations where tenant_id = ${tenantId} and token_hash = ${tokenHash} and channel = 'web'
  `);
  return rows[0] ? toConversation(rows[0]) : null;
}

export async function getConversation(transaction: KalendrTransaction, tenantId: string, id: string): Promise<Conversation | null> {
  const rows = await transaction.execute<ConversationRow>(sql`
    select ${columns} from assistant_conversations where tenant_id = ${tenantId} and id = ${id}
  `);
  return rows[0] ? toConversation(rows[0]) : null;
}

/** The latest chat on a thread that has not been closed and was active in the last day; a new day starts a new chat. */
export async function findThreadConversation(transaction: KalendrTransaction, tenantId: string, threadId: string, now: Date): Promise<Conversation | null> {
  const rows = await transaction.execute<ConversationRow>(sql`
    select ${columns} from assistant_conversations
    where tenant_id = ${tenantId} and thread_id = ${threadId} and status <> 'closed' and last_activity_at > ${stamp(new Date(now.getTime() - 24 * 3_600_000))}
    order by created_at desc limit 1
  `);
  return rows[0] ? toConversation(rows[0]) : null;
}

/** Takes the chat for one turn. A second message that arrives while a turn runs waits; a stuck lease frees itself. */
export async function acquireLease(transaction: KalendrTransaction, tenantId: string, id: string, seconds = LEASE_SECONDS): Promise<boolean> {
  const rows = await transaction.execute<{ id: string }>(sql`
    update assistant_conversations set lease_until = now() + (${seconds} * interval '1 second')
    where tenant_id = ${tenantId} and id = ${id} and (lease_until is null or lease_until < now())
    returning id
  `);
  return rows.length > 0;
}

export async function releaseLease(transaction: KalendrTransaction, tenantId: string, id: string): Promise<void> {
  await transaction.execute(sql`update assistant_conversations set lease_until = null where tenant_id = ${tenantId} and id = ${id}`);
}

const storedBlocks = z.array(blockSchema);

/**
 * One saved message. `message` is always the words as model blocks, so the public chat, the handoff view and the exports read every chat
 * the same way. A message saved in the AI SDK format (see stored-format.ts) also carries `ui`, the full message with its tool steps.
 */
export interface StoredMessage { seq: number; kind: "customer" | "assistant" | "tool" | "staff"; message: LlmMessage; ui?: StoredUiMessage }

/** The conversation as the model sees it, oldest first. Anything that no longer parses is skipped, never guessed at. */
export async function loadHistory(transaction: KalendrTransaction, tenantId: string, conversationId: string): Promise<StoredMessage[]> {
  await loadRecordKeys(transaction, tenantId);
  const rows = await transaction.execute<{ seq: number; kind: StoredMessage["kind"]; content_ciphertext: string }>(sql`
    select seq, kind, content_ciphertext from assistant_messages
    where tenant_id = ${tenantId} and conversation_id = ${conversationId} order by seq
  `);
  const history: StoredMessage[] = [];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(openText(tenantId, row.content_ciphertext));
    } catch {
      continue;
    }
    const role = row.kind === "assistant" ? "assistant" : "user";
    const ui = readUiEnvelope(parsed);
    if (ui) {
      const text = textOfUiParts(ui.parts);
      history.push({ seq: row.seq, kind: row.kind, ui, message: { role, content: text ? [{ type: "text", text }] : [] } });
      continue;
    }
    const blocks = storedBlocks.safeParse(parsed);
    if (!blocks.success) continue;
    history.push({ seq: row.seq, kind: row.kind, message: { role, content: blocks.data } });
  }
  return history;
}

/**
 * The staff copilot's conversation as UI messages, oldest first. Messages saved in the AI SDK format come back whole; a chat from before
 * the move comes back as its words only (the old tool traffic was never a UI message), with neighbours of the same side joined.
 */
export async function loadUiHistory(transaction: KalendrTransaction, tenantId: string, conversationId: string): Promise<StoredUiMessage[]> {
  const messages: StoredUiMessage[] = [];
  let lastWasLegacy = false;
  for (const entry of await loadHistory(transaction, tenantId, conversationId)) {
    if (entry.ui) {
      messages.push(entry.ui);
      lastWasLegacy = false;
      continue;
    }
    if (entry.kind === "tool" || typeof entry.message.content === "string") continue;
    const text = entry.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
    if (!text) continue;
    const role = entry.kind === "assistant" ? "assistant" : "user";
    const previous = messages.at(-1);
    if (lastWasLegacy && previous && previous.role === role) {
      previous.parts = [{ type: "text", text: `${textOfUiParts(previous.parts)}\n${text}` }];
    } else {
      messages.push({ id: `legacy-${entry.seq}`, role, parts: [{ type: "text", text }] });
    }
    lastWasLegacy = true;
  }
  return messages;
}

export interface NewMessage {
  kind: StoredMessage["kind"];
  blocks: LlmBlock[];
  /** Set to save the message in the AI SDK format; `blocks` is then ignored. */
  ui?: StoredUiMessage;
  sourceKey?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** Adds messages in order. Returns false when the first one's provider id was already stored (a repeated webhook). */
export async function appendMessages(transaction: KalendrTransaction, tenantId: string, conversationId: string, messages: readonly NewMessage[]): Promise<boolean> {
  if (messages.length === 0) return true;
  await loadRecordKeys(transaction, tenantId, { forWrite: true });
  const [{ next } = { next: 1 }] = await transaction.execute<{ next: number }>(sql`
    select coalesce(max(seq), 0) + 1 as next from assistant_messages where tenant_id = ${tenantId} and conversation_id = ${conversationId}
  `);
  let seq = Number(next);
  let first = true;
  for (const message of messages) {
    const inserted = await transaction.execute<{ id: string }>(sql`
      insert into assistant_messages (tenant_id, conversation_id, seq, kind, content_ciphertext, key_version, source_key, input_tokens, output_tokens)
      values (${tenantId}, ${conversationId}, ${seq}, ${message.kind}, ${sealText(tenantId, message.ui ? encodeUiMessage(message.ui) : JSON.stringify(message.blocks))}, ${writeKeyVersion(tenantId)},
        ${message.sourceKey ?? null}, ${message.inputTokens ?? 0}, ${message.outputTokens ?? 0})
      on conflict do nothing
      returning id
    `);
    if (inserted.length === 0 && first) return false;
    seq += 1;
    first = false;
  }
  return true;
}

export async function touchConversation(transaction: KalendrTransaction, tenantId: string, id: string, patch: { turns?: number; failed?: boolean; resetFailures?: boolean }): Promise<void> {
  await transaction.execute(sql`
    update assistant_conversations set
      turn_count = turn_count + ${patch.turns ?? 0},
      failure_count = case when ${patch.resetFailures === true} then 0 when ${patch.failed === true} then failure_count + 1 else failure_count end,
      last_activity_at = now(), updated_at = now()
    where tenant_id = ${tenantId} and id = ${id}
  `);
}

export async function setPending(transaction: KalendrTransaction, tenantId: string, id: string, pending: Pending, expiresAt: Date): Promise<string> {
  await loadRecordKeys(transaction, tenantId, { forWrite: true });
  const pendingId = newProposalId();
  await transaction.execute(sql`
    update assistant_conversations set pending_id = ${pendingId}, pending_ciphertext = ${sealText(tenantId, JSON.stringify(pending))},
      pending_key_version = ${writeKeyVersion(tenantId)}, pending_expires_at = ${stamp(expiresAt)}, updated_at = now()
    where tenant_id = ${tenantId} and id = ${id}
  `);
  return pendingId;
}

export async function clearPending(transaction: KalendrTransaction, tenantId: string, id: string): Promise<void> {
  await transaction.execute(sql`
    update assistant_conversations set pending_id = null, pending_ciphertext = null, pending_key_version = null, pending_expires_at = null, updated_at = now()
    where tenant_id = ${tenantId} and id = ${id}
  `);
}

/** The waiting proposal, if it is still live. */
export async function readPending(transaction: KalendrTransaction, tenantId: string, id: string, now: Date): Promise<{ pendingId: string; pending: Pending; expiresAt: Date } | null> {
  await loadRecordKeys(transaction, tenantId);
  const rows = await transaction.execute<{ pending_id: string | null; pending_ciphertext: string | null; pending_expires_at: Date | string | null }>(sql`
    select pending_id, pending_ciphertext, pending_expires_at from assistant_conversations where tenant_id = ${tenantId} and id = ${id}
  `);
  const row = rows[0];
  const expires = row?.pending_expires_at ? asDate(row.pending_expires_at) : null;
  if (!row?.pending_id || !row.pending_ciphertext || !expires || expires.getTime() <= now.getTime()) return null;
  try {
    const parsed = pendingSchema.safeParse(JSON.parse(openText(tenantId, row.pending_ciphertext)));
    return parsed.success ? { pendingId: row.pending_id, pending: parsed.data, expiresAt: expires } : null;
  } catch {
    return null;
  }
}

export async function setOtpPhone(transaction: KalendrTransaction, tenantId: string, id: string, phone: string): Promise<void> {
  await loadRecordKeys(transaction, tenantId, { forWrite: true });
  await transaction.execute(sql`
    update assistant_conversations set otp_phone_ciphertext = ${sealText(tenantId, phone)}, otp_key_version = ${writeKeyVersion(tenantId)}, otp_sent_at = now(), updated_at = now()
    where tenant_id = ${tenantId} and id = ${id}
  `);
}

export async function readOtpPhone(transaction: KalendrTransaction, tenantId: string, id: string): Promise<string | null> {
  await loadRecordKeys(transaction, tenantId);
  const rows = await transaction.execute<{ otp_phone_ciphertext: string | null }>(sql`
    select otp_phone_ciphertext from assistant_conversations where tenant_id = ${tenantId} and id = ${id}
  `);
  const sealed = rows[0]?.otp_phone_ciphertext;
  if (!sealed) return null;
  try { return openText(tenantId, sealed); } catch { return null; }
}

export async function markVerified(transaction: KalendrTransaction, tenantId: string, id: string, patientIds: readonly string[]): Promise<void> {
  await transaction.execute(sql`
    update assistant_conversations set verified_patient_ids = ${textArray(patientIds)}, verified_at = now(), otp_phone_ciphertext = null, otp_key_version = null, updated_at = now()
    where tenant_id = ${tenantId} and id = ${id}
  `);
}

export async function rememberShown(transaction: KalendrTransaction, tenantId: string, id: string, appointmentIds: readonly string[]): Promise<void> {
  await transaction.execute(sql`
    update assistant_conversations set shown_appointment_ids = ${textArray(appointmentIds)}, updated_at = now() where tenant_id = ${tenantId} and id = ${id}
  `);
}

export async function handOff(transaction: KalendrTransaction, tenantId: string, id: string, reason: string, summary: string): Promise<void> {
  await loadRecordKeys(transaction, tenantId, { forWrite: true });
  await transaction.execute(sql`
    update assistant_conversations set status = 'handed_off', handed_off_at = now(), handoff_reason = ${reason.slice(0, 24)},
      summary_ciphertext = ${sealText(tenantId, summary.slice(0, 1200))}, summary_key_version = ${writeKeyVersion(tenantId)},
      pending_id = null, pending_ciphertext = null, pending_key_version = null, pending_expires_at = null, updated_at = now()
    where tenant_id = ${tenantId} and id = ${id} and status = 'active'
  `);
}

export async function setStatus(transaction: KalendrTransaction, tenantId: string, id: string, status: ConversationStatus): Promise<boolean> {
  const rows = await transaction.execute<{ id: string }>(sql`
    update assistant_conversations set status = ${status}, updated_at = now(), failure_count = 0,
      handed_off_at = case when ${status} = 'active' then null else handed_off_at end
    where tenant_id = ${tenantId} and id = ${id} returning id
  `);
  return rows.length > 0;
}

/** The customer-facing lines of a conversation, oldest first. Tool traffic and server notes are left out. */
export function visibleLines(history: readonly StoredMessage[]): Array<{ role: "customer" | "assistant"; text: string }> {
  const lines: Array<{ role: "customer" | "assistant"; text: string }> = [];
  for (const entry of history) {
    if (entry.kind === "tool") continue;
    const content = entry.message.content;
    if (typeof content === "string") continue;
    const text = content.filter((block) => block.type === "text").map((block) => (block.type === "text" ? block.text : "")).join("\n").trim();
    if (!text) continue;
    // A turn that carries a server note keeps only what the customer wrote.
    const shown = entry.kind === "customer" ? text.split("\n").filter((line) => !line.startsWith("[SERVER NOTE]")).join("\n").trim() : text;
    if (shown) lines.push({ role: entry.kind === "assistant" ? "assistant" : "customer", text: shown });
  }
  return lines;
}

export async function hasSourceKey(transaction: KalendrTransaction, tenantId: string, conversationId: string, sourceKey: string): Promise<boolean> {
  const rows = await transaction.execute<{ id: string }>(sql`
    select id from assistant_messages where tenant_id = ${tenantId} and conversation_id = ${conversationId} and source_key = ${sourceKey} limit 1
  `);
  return rows.length > 0;
}
