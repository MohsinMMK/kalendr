/**
 * The suppression list: addresses a provider said not to send to again. Only a hash of the
 * address is stored, so the list can't be read back as a list of customers' emails.
 *
 * Works with any postgres.js transaction that has already set app.tenant_id (the worker's
 * TenantDb, or the web app's raw client inside withTenant), so row-level security applies.
 */
import { createHash } from "node:crypto";

import type postgres from "postgres";

import type { MessageChannel } from "./provider";

export type SuppressionReason = "bounced" | "complained";

export function destinationHash(channel: MessageChannel, destination: string): string {
  const normal = channel === "email" ? destination.trim().toLowerCase() : destination.replace(/[^\d+]/g, "");
  return createHash("sha256").update(`kalendr-suppression:${channel}:${normal}`).digest("hex");
}

type Sql = postgres.Sql | postgres.TransactionSql;

/** Why this address is suppressed, or null when sending is allowed. */
export async function suppressionReason(tenantDb: Sql, tenantId: string, channel: MessageChannel, destination: string): Promise<SuppressionReason | null> {
  const rows = await tenantDb`
    select reason from message_suppressions
    where tenant_id = ${tenantId} and channel = ${channel} and destination_hash = ${destinationHash(channel, destination)}
    limit 1
  `;
  const reason = (rows[0] as { reason?: string } | undefined)?.reason;
  return reason === "bounced" || reason === "complained" ? reason : null;
}

export async function suppressDestination(
  tenantDb: Sql,
  input: { tenantId: string; channel: MessageChannel; destinationHash: string; reason: SuppressionReason; notificationId: string | null },
): Promise<void> {
  await tenantDb`
    insert into message_suppressions (tenant_id, channel, destination_hash, reason, notification_id)
    values (${input.tenantId}, ${input.channel}, ${input.destinationHash}, ${input.reason}, ${input.notificationId})
    on conflict (tenant_id, channel, destination_hash) do nothing
  `;
}
