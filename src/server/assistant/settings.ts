import "server-only";

import { sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents } from "@/db/schema";
import {
  defaultAssistantSettings, type AssistantSettingsInput, type AssistantSettingsUpdate, type AssistantSettingsView,
} from "@/lib/assistant-contracts";
import { canUse, type Entitlements } from "@/lib/entitlements";

import { ApiError } from "../api-error";
import { loadEntitlements, requireFeature } from "../entitlements";
import { assertNotReadOnlyImpersonation, requirePermission, type StaffContext } from "../staff-context";
import { assistantMode } from "./model";
import { monthlyCap, tokensUsedThisMonth } from "./usage";

interface SettingsRow extends Record<string, unknown> {
  enabled_web: boolean; enabled_whatsapp: boolean; enabled_sms: boolean; tone: AssistantSettingsInput["tone"];
  handoff_rule: AssistantSettingsInput["handoffRule"]; business_facts: string | null; retention_days: number; version: number;
}

export interface StoredAssistantSettings extends AssistantSettingsInput { version: number }

function fromRow(row: SettingsRow | undefined): StoredAssistantSettings {
  if (!row) return { ...defaultAssistantSettings, version: 0 };
  return {
    enabledWeb: row.enabled_web, enabledWhatsapp: row.enabled_whatsapp, enabledSms: row.enabled_sms, tone: row.tone, handoffRule: row.handoff_rule,
    businessFacts: row.business_facts ?? "", retentionDays: row.retention_days, version: row.version,
  };
}

export async function loadSettingsIn(transaction: KalendrTransaction, tenantId: string): Promise<StoredAssistantSettings> {
  const rows = await transaction.execute<SettingsRow>(sql`
    select enabled_web, enabled_whatsapp, enabled_sms, tone, handoff_rule, business_facts, retention_days, version
    from assistant_settings where tenant_id = ${tenantId}
  `);
  return fromRow(rows[0]);
}

function viewOf(settings: StoredAssistantSettings, entitlements: Entitlements | undefined, usedTokens: number): AssistantSettingsView {
  const mode = assistantMode();
  return { ...settings, available: !entitlements || canUse(entitlements, "assistant"), modelReady: mode !== "off", mode, usedTokens, tokenCap: monthlyCap() };
}

export async function getAssistantSettings(context: StaffContext): Promise<AssistantSettingsView> {
  requirePermission(context, "settings.manage");
  // The preview has no database: the screen opens, says the assistant is not available there, and saves nothing.
  if (context.preview) return { ...defaultAssistantSettings, version: 0, available: false, modelReady: false, mode: "off", usedTokens: 0, tokenCap: monthlyCap() };
  const { settings, used } = await withTenant(context.tenantId, async (transaction) => ({
    settings: await loadSettingsIn(transaction, context.tenantId), used: await tokensUsedThisMonth(transaction, context.tenantId, new Date()),
  }));
  return viewOf(settings, context.entitlements, used);
}

/** Saves the owner's choices. A channel can only be switched on when the plan includes the assistant. */
export async function updateAssistantSettings(context: StaffContext, input: AssistantSettingsUpdate): Promise<AssistantSettingsView> {
  assertNotReadOnlyImpersonation(context);
  requirePermission(context, "settings.manage");
  if (context.preview) throw new ApiError(409, "preview_only", "The assistant can't be set up in the preview. Sign in to your own business to turn it on.");
  if (input.enabledSms) {
    throw new ApiError(400, "validation_error", "Two-way text messages aren't connected yet, so the assistant can't answer by text.", { enabledSms: ["Not available yet."] });
  }
  const turningOn = input.enabledWeb || input.enabledWhatsapp || input.enabledSms;
  if (turningOn) requireFeature(context, "assistant");
  const saved = await withTenant(context.tenantId, async (transaction) => {
    const current = await loadSettingsIn(transaction, context.tenantId);
    if (current.version !== input.version) {
      throw new ApiError(409, "version_conflict", "Someone else changed these settings. Reload to see their changes, then try again.");
    }
    const facts = input.businessFacts.trim() || null;
    // The first save creates the row (version 0 means none yet); every later one must match the version the screen loaded.
    const rows = await transaction.execute<SettingsRow>(sql`
      insert into assistant_settings (tenant_id, enabled_web, enabled_whatsapp, enabled_sms, tone, handoff_rule, business_facts, retention_days, updated_by_user_id)
      values (${context.tenantId}, ${input.enabledWeb}, ${input.enabledWhatsapp}, ${input.enabledSms}, ${input.tone}, ${input.handoffRule}, ${facts}, ${input.retentionDays}, ${context.userId})
      on conflict (tenant_id) do update set
        enabled_web = excluded.enabled_web, enabled_whatsapp = excluded.enabled_whatsapp, enabled_sms = excluded.enabled_sms, tone = excluded.tone,
        handoff_rule = excluded.handoff_rule, business_facts = excluded.business_facts, retention_days = excluded.retention_days,
        updated_by_user_id = excluded.updated_by_user_id, version = assistant_settings.version + 1, updated_at = now()
      where assistant_settings.version = ${input.version}
      returning enabled_web, enabled_whatsapp, enabled_sms, tone, handoff_rule, business_facts, retention_days, version
    `);
    const row = rows[0];
    if (!row) throw new ApiError(409, "version_conflict", "Someone else changed these settings. Reload to see their changes, then try again.");
    // Which switches changed, never the owner's text.
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "settings.assistant.updated", outcome: "success",
      metadata: {
        web: input.enabledWeb, whatsapp: input.enabledWhatsapp, sms: input.enabledSms, tone: input.tone, handoffRule: input.handoffRule,
        retentionDays: input.retentionDays, factsLength: facts?.length ?? 0,
      },
    });
    return fromRow(row);
  });
  const entitlements = context.entitlements ?? (await loadEntitlements(context.tenantId)).entitlements;
  const used = await withTenant(context.tenantId, (transaction) => tokensUsedThisMonth(transaction, context.tenantId, new Date()));
  return viewOf(saved, entitlements, used);
}
