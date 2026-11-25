import "server-only";

import { sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import type { AppCard, AppState } from "@/lib/apps/catalog";
import { env } from "@/server/env";
import type { StaffContext } from "@/server/staff-context";

/**
 * The integrations built before the Apps page (calendars, video, payments, WhatsApp, text messages, webhooks, API keys,
 * the AI assistant connection and website embeds), listed here so a business finds every connection in one place. Each
 * is managed on its own screen, which still owns its credentials and its rules: this file only reports its state and
 * says where to go. Nothing is copied from them.
 */

interface Status { state: AppState; text: string }

interface Counts extends Record<string, unknown> {
  calendars_google: number;
  calendars_microsoft: number;
  calendars_apple: number;
  payments_active: number;
  webhooks_active: number;
  keys_active: number;
  embed_origins: number;
  whatsapp_enabled: boolean | null;
  sms_enabled: boolean | null;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function calendarStatus(count: number): Status {
  return count > 0 ? { state: "connected", text: `${plural(count, "calendar account", "calendar accounts")} connected` } : { state: "not_connected", text: "Nobody has connected one yet" };
}

export async function connectedCards(context: StaffContext, canUseApi: boolean): Promise<AppCard[]> {
  const settings = env();
  const counts = context.preview ? null : await withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.execute<Counts>(sql`
      select
        (select count(*)::int from calendar_connections where tenant_id = ${context.tenantId} and provider = 'google' and status in ('pending', 'active')) as calendars_google,
        (select count(*)::int from calendar_connections where tenant_id = ${context.tenantId} and provider = 'microsoft' and status in ('pending', 'active')) as calendars_microsoft,
        (select count(*)::int from calendar_connections where tenant_id = ${context.tenantId} and provider = 'apple' and status in ('pending', 'active')) as calendars_apple,
        (select count(*)::int from tenant_payment_accounts where tenant_id = ${context.tenantId} and status = 'active') as payments_active,
        (select count(*)::int from webhook_endpoints where tenant_id = ${context.tenantId} and status = 'active') as webhooks_active,
        (select count(*)::int from api_keys where tenant_id = ${context.tenantId} and revoked_at is null and (expires_at is null or expires_at > now())) as keys_active,
        (select count(*)::int from tenant_embed_origins where tenant_id = ${context.tenantId}) as embed_origins,
        (select whatsapp_enabled from tenant_channel_settings where tenant_id = ${context.tenantId}) as whatsapp_enabled,
        (select sms_enabled from tenant_channel_settings where tenant_id = ${context.tenantId}) as sms_enabled`);
    return row ?? null;
  });
  const whatsappReady = Boolean(settings.WHATSAPP_ACCESS_TOKEN && settings.WHATSAPP_PHONE_NUMBER_ID);
  const smsReady = settings.SMS_PROVIDER === "msg91" ? Boolean(settings.MSG91_AUTH_KEY && settings.MSG91_SENDER_ID)
    : settings.SMS_PROVIDER === "twilio" ? Boolean(settings.TWILIO_ACCOUNT_SID && settings.TWILIO_AUTH_TOKEN && settings.TWILIO_FROM) : false;
  const channelStatus = (ready: boolean, enabled: boolean | null | undefined): Status =>
    !ready ? { state: "unavailable", text: "Not set up on this Kalendr yet" }
      : enabled === false ? { state: "paused", text: "Switched off for your business" }
        : { state: "connected", text: "On for your business" };
  const video = settings.VIDEO_PROVIDER === "daily" ? { state: "connected" as const, text: "Video visits are on" }
    : settings.VIDEO_PROVIDER === "test" ? { state: "connected" as const, text: "On in test mode: no real rooms are made" }
      : { state: "unavailable" as const, text: "Not set up on this Kalendr yet" };
  const payments: Status = (counts?.payments_active ?? 0) > 0 ? { state: "connected", text: "A payment account is connected" } : { state: "not_connected", text: "No payment account yet" };

  const make = (card: Omit<AppCard, "kind" | "needsUpgrade" | "dataSent" | "statusText" | "state"> & { dataSent: string[]; needsUpgrade?: boolean }, status: Status): AppCard =>
    ({ ...card, kind: "connected", needsUpgrade: card.needsUpgrade ?? false, state: status.state, statusText: status.text });

  return [
    make({ key: "google-calendar", name: "Google Calendar", tagline: "Keep bookings and busy time in step.", category: "calendar", dataSent: ["Bookings are written to each person's own calendar.", "Their busy times are read so nobody is double-booked."], manage: { href: "/profile", label: "Open my profile" } }, calendarStatus(counts?.calendars_google ?? 0)),
    make({ key: "microsoft-calendar", name: "Outlook calendar", tagline: "Keep bookings and busy time in step.", category: "calendar", dataSent: ["Bookings are written to each person's own calendar.", "Their busy times are read so nobody is double-booked."], manage: { href: "/profile", label: "Open my profile" } }, calendarStatus(counts?.calendars_microsoft ?? 0)),
    make({ key: "apple-calendar", name: "Apple Calendar", tagline: "Keep bookings and busy time in step.", category: "calendar", dataSent: ["Bookings are written to each person's own calendar.", "Their busy times are read so nobody is double-booked."], manage: { href: "/profile", label: "Open my profile" } }, calendarStatus(counts?.calendars_apple ?? 0)),
    make({ key: "video-visits", name: "Video visits", tagline: "A private room for each online visit.", category: "video", dataSent: ["A room is made for each online visit and ends with it.", "The customer's name is shown in the room."], manage: null }, video),
    make({ key: "online-payments", name: "Online payments", tagline: "Take deposits and full payment at booking.", category: "payments", dataSent: ["The amount and the booking reference go to your payment provider.", "Card details never reach Kalendr."], manage: { section: "payments", label: "Payment settings" } }, payments),
    make({ key: "whatsapp", name: "WhatsApp", tagline: "Reminders and replies on WhatsApp.", category: "messaging", dataSent: ["Approved message templates with the booking time.", "The customer's WhatsApp number."], manage: { section: "messaging", label: "Message settings" } }, channelStatus(whatsappReady, counts?.whatsapp_enabled)),
    make({ key: "sms", name: "Text messages", tagline: "Reminders by SMS.", category: "messaging", dataSent: ["Reminder text with the booking time.", "The customer's mobile number."], manage: { section: "messaging", label: "Message settings" } }, channelStatus(smsReady, counts?.sms_enabled)),
    make({ key: "webhooks", name: "Webhooks", tagline: "Send events to your own software.", category: "developer", dataSent: ["Ids, times and numbers for each booking event. No names, phones or emails."], needsUpgrade: !canUseApi, manage: { section: "developers", label: "Open developer tools" } },
      (counts?.webhooks_active ?? 0) > 0 ? { state: "connected", text: `${plural(counts?.webhooks_active ?? 0, "address", "addresses")} receiving events` } : { state: "not_connected", text: "No address yet" }),
    make({ key: "api-keys", name: "API keys", tagline: "Let your software read and book.", category: "developer", dataSent: ["Whatever you allow each key to read or change."], needsUpgrade: !canUseApi, manage: { section: "developers", label: "Open developer tools" } },
      (counts?.keys_active ?? 0) > 0 ? { state: "connected", text: `${plural(counts?.keys_active ?? 0, "active key", "active keys")}` } : { state: "not_connected", text: "No keys yet" }),
    make({ key: "ai-assistants", name: "AI assistants (MCP)", tagline: "Let an AI assistant check times and book.", category: "developer", dataSent: ["What each API key you give the assistant may read or change."], needsUpgrade: !canUseApi, manage: { href: "/developers", label: "Read the guide" } },
      { state: canUseApi ? "available" : "unavailable", text: canUseApi ? "Uses an API key you make" : "Comes with the Growth plan" }),
    make({ key: "wordpress", name: "WordPress", tagline: "A shortcode and a block for your WordPress site.", category: "website", dataSent: ["Nothing leaves your site until a visitor opens the booking form.", "The plugin keeps only your Kalendr address and business name."], manage: { section: "website", label: "Get the embed code" } },
      { state: "available", text: "Plugin: integrations/wordpress in the Kalendr repository" }),
    make({ key: "website-embed", name: "Website booking widget", tagline: "Put booking on your own website.", category: "website", dataSent: ["Nothing leaves your site until a visitor opens the booking form."], manage: { section: "website", label: "Get the code" } },
      (counts?.embed_origins ?? 0) > 0 ? { state: "connected", text: `${plural(counts?.embed_origins ?? 0, "website", "websites")} allowed` } : { state: "available", text: "Not on a website yet" }),
  ];
}
