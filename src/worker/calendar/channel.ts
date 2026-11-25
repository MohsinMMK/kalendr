/**
 * Watch channels: the provider's promise to ping our webhook when a calendar changes. They expire
 * (Google after about a week, Microsoft after under three days), so any channel within a day of
 * its end is renewed, and a calendar that has none gets one. A calendar with no channel is still
 * read every few minutes by the poll job, so a failure here never leaves availability stale.
 */
import { webhookSecret, webhookUrl } from "../../server/calendars/runtime";
import type { TenantDb } from "../handlers/types";
import type { ConnectionRow, ProviderSession } from "./common";

export const RENEW_BEFORE_MS = 24 * 60 * 60 * 1_000;

export interface SelectionChannelRow {
  id: string;
  calendar_id: string;
  channel_id: string | null;
  channel_resource_id: string | null;
  channel_expires_at: Date | null;
}

export type ChannelResult = "fine" | "opened" | "renewed" | "skipped" | "revoked";

/** Opens or renews the channel of one calendar when it needs it. Never throws; the caller persists tokens. */
export async function ensureChannel(
  tenantDb: TenantDb,
  tenantId: string,
  session: ProviderSession,
  connection: Pick<ConnectionRow, "provider">,
  selection: SelectionChannelRow,
  now: Date,
): Promise<ChannelResult> {
  if (!session.provider.supportsPush || (connection.provider !== "google" && connection.provider !== "microsoft")) return "skipped";
  const token = webhookSecret();
  if (!token) return "skipped";
  const request = { callbackUrl: webhookUrl(connection.provider), token };

  const hasChannel = selection.channel_id !== null && selection.channel_expires_at !== null;
  if (hasChannel && selection.channel_expires_at && selection.channel_expires_at.getTime() - now.getTime() > RENEW_BEFORE_MS) return "fine";

  const result = await session.call((provider, credentials) => {
    if (selection.channel_id && selection.channel_expires_at) {
      return provider.renewWatch(
        credentials,
        selection.calendar_id,
        { channelId: selection.channel_id, resourceId: selection.channel_resource_id, expiresAt: selection.channel_expires_at.toISOString() },
        request,
      );
    }
    return provider.watch(credentials, selection.calendar_id, request);
  });
  if (!result.ok) return result.failure.kind === "revoked" ? "revoked" : "skipped";

  await tenantDb`
    update calendar_selections
    set channel_id = ${result.value.channelId}, channel_resource_id = ${result.value.resourceId},
      channel_expires_at = ${result.value.expiresAt}, updated_at = now()
    where tenant_id = ${tenantId} and id = ${selection.id}`;
  return hasChannel ? "renewed" : "opened";
}
