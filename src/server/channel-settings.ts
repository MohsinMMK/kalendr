import "server-only";

import { sql } from "drizzle-orm";

import { requireDatabase, withTenant } from "@/db/client";
import { auditEvents, tenantChannelSettings } from "@/db/schema";
import type { ChannelSettings, ChannelSettingsInput, ChannelState } from "@/lib/inbox-contracts";

import { ApiError } from "./api-error";
import { env } from "./env";
import { isPreviewMode } from "./preview-repository";
import { requirePermission, type StaffContext } from "./staff-context";

type TemplateRow = { channel: "whatsapp" | "sms"; key: string; language: string; status: ChannelState["templates"][number]["status"]; status_reason: string | null };

export async function getChannelSettings(context: StaffContext): Promise<ChannelSettings> {
  requirePermission(context, "settings.manage");
  const settings = env();
  const whatsappConfigured = Boolean(settings.WHATSAPP_ACCESS_TOKEN && settings.WHATSAPP_PHONE_NUMBER_ID);
  const smsProvider = settings.SMS_PROVIDER ?? null;
  const smsConfigured = smsProvider === "msg91" ? Boolean(settings.MSG91_AUTH_KEY && settings.MSG91_SENDER_ID)
    : smsProvider === "twilio" ? Boolean(settings.TWILIO_ACCOUNT_SID && settings.TWILIO_AUTH_TOKEN && settings.TWILIO_FROM) : false;
  if (context.preview || isPreviewMode()) {
    return { whatsapp: { enabled: true, configured: false, templates: [] }, sms: { enabled: true, configured: false, provider: smsProvider, templates: [] } };
  }
  // The templates table has no business in it (Kalendr's own approved templates), so read it directly.
  const templates = await requireDatabase().execute<TemplateRow>(sql`
    select channel, key, language, status, status_reason from message_templates where channel in ('whatsapp', 'sms') order by channel, key, language
  `);
  const row = await withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.select().from(tenantChannelSettings);
    return rows[0];
  });
  const of = (channel: "whatsapp" | "sms") => templates
    .filter((template) => template.channel === channel)
    .map((template) => ({ key: template.key, language: template.language, status: template.status, reason: template.status_reason }));
  return {
    whatsapp: { enabled: row?.whatsappEnabled ?? true, configured: whatsappConfigured, templates: of("whatsapp") },
    sms: { enabled: row?.smsEnabled ?? true, configured: smsConfigured, provider: smsProvider, templates: of("sms") },
  };
}

export async function updateChannelSettings(context: StaffContext, input: ChannelSettingsInput): Promise<ChannelSettings> {
  requirePermission(context, "settings.manage");
  if (context.preview || isPreviewMode()) throw new ApiError(409, "preview_only", "Settings are not saved in the preview.");
  await withTenant(context.tenantId, async (transaction) => {
    await transaction.insert(tenantChannelSettings).values({
      tenantId: context.tenantId,
      ...(input.whatsappEnabled === undefined ? {} : { whatsappEnabled: input.whatsappEnabled }),
      ...(input.smsEnabled === undefined ? {} : { smsEnabled: input.smsEnabled }),
    }).onConflictDoUpdate({
      target: tenantChannelSettings.tenantId,
      set: {
        ...(input.whatsappEnabled === undefined ? {} : { whatsappEnabled: input.whatsappEnabled }),
        ...(input.smsEnabled === undefined ? {} : { smsEnabled: input.smsEnabled }),
        updatedAt: new Date(),
      },
    });
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "settings.channels", outcome: "success",
      metadata: { ...input },
    });
  });
  return getChannelSettings(context);
}
