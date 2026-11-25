import "server-only";

import { sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import type { AssistantChatLine } from "@/lib/assistant-contracts";

import { ApiError } from "../api-error";
import { assertNotReadOnlyImpersonation, requirePermission, type StaffContext } from "../staff-context";
import { loadRecordKeys, openText } from "../record-crypto";
import { asDate, loadHistory, setStatus, visibleLines } from "./store";

/**
 * Chats the assistant passed to a person (feature 30). Staff read the summary and the chat, then either hand it back to the
 * assistant or close it. Web chats with no contact details live only here; WhatsApp chats are also in the inbox.
 */

export interface HandoffSummary {
  id: string;
  channel: "web" | "whatsapp" | "sms";
  reason: string | null;
  handedOffAt: string;
  summary: string;
  customerName: string | null;
}

export async function listHandoffs(context: StaffContext): Promise<HandoffSummary[]> {
  requirePermission(context, "inbox.reply");
  if (context.preview) return [];
  return withTenant(context.tenantId, async (transaction) => {
    await loadRecordKeys(transaction, context.tenantId);
    const rows = await transaction.execute<{ id: string; channel: HandoffSummary["channel"]; handoff_reason: string | null; handed_off_at: Date | string | null; summary_ciphertext: string | null; first_name: string | null; last_name: string | null }>(sql`
      select conversation.id, conversation.channel, conversation.handoff_reason, conversation.handed_off_at, conversation.summary_ciphertext, patient.first_name, patient.last_name
      from assistant_conversations as conversation
      left join patients as patient on patient.tenant_id = conversation.tenant_id and patient.id = conversation.patient_id
      where conversation.tenant_id = ${context.tenantId} and conversation.status = 'handed_off' and conversation.channel <> 'staff'
      order by conversation.handed_off_at desc nulls last limit 50
    `);
    return rows.map((row) => ({
      id: row.id, channel: row.channel, reason: row.handoff_reason, handedOffAt: asDate(row.handed_off_at ?? new Date()).toISOString(),
      summary: row.summary_ciphertext ? openText(context.tenantId, row.summary_ciphertext) : "",
      customerName: row.first_name ? `${row.first_name} ${row.last_name ?? ""}`.trim() : null,
    }));
  });
}

export async function readHandoff(context: StaffContext, id: string): Promise<{ lines: AssistantChatLine[] }> {
  requirePermission(context, "inbox.reply");
  if (context.preview) throw new ApiError(404, "not_found", "That chat was not found.");
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.execute<{ id: string }>(sql`select id from assistant_conversations where tenant_id = ${context.tenantId} and id = ${id} and channel <> 'staff'`);
    if (rows.length === 0) throw new ApiError(404, "not_found", "That chat was not found.");
    return { lines: visibleLines(await loadHistory(transaction, context.tenantId, id)) };
  });
}

/** "hand_back" lets the assistant answer again; "close" ends it. Both are recorded, with no words from the chat. */
export async function actOnHandoff(context: StaffContext, id: string, action: "hand_back" | "close"): Promise<void> {
  assertNotReadOnlyImpersonation(context);
  requirePermission(context, "inbox.reply");
  await withTenant(context.tenantId, async (transaction) => {
    const changed = await setStatus(transaction, context.tenantId, id, action === "hand_back" ? "active" : "closed");
    if (!changed) throw new ApiError(404, "not_found", "That chat was not found.");
    await transaction.execute(sql`
      insert into audit_events (tenant_id, actor_user_id, actor_type, action, outcome, metadata)
      values (${context.tenantId}, ${context.userId}, 'staff', ${`assistant.handoff.${action}`}, 'success', ${JSON.stringify({ conversationId: id })}::jsonb)
    `);
  });
}
