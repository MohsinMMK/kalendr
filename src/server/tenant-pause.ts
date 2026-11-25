import "server-only";

import { sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";

import { ApiError } from "./api-error";

/** What a visitor to a paused business reads. Neutral on purpose: it says nothing about why. */
export const pausedNoticeText = "This page is not taking bookings right now.";

export async function tenantIsPaused(tenantId: string): Promise<boolean> {
  const [row] = await withTenant(tenantId, (transaction) => transaction.execute<{ paused: boolean }>(sql`select paused_at is not null as paused from tenants where id = ${tenantId}`));
  return row?.paused === true;
}

/** For public booking calls (availability, holds, codes, booking). Staff of a paused business can still sign in and work. */
export async function assertTenantNotPaused(tenantId: string): Promise<void> {
  if (await tenantIsPaused(tenantId)) throw new ApiError(409, "business_paused", pausedNoticeText);
}

/** True when a public business link points at a paused business. Never throws for an unknown link. */
export async function slugIsPaused(slug: string): Promise<boolean> {
  const database = getDatabase();
  if (!database) return false;
  const [tenant] = await database.execute<{ tenant_id: string }>(sql`select tenant_id from kalendr_resolve_tenant(${slug}, null)`);
  return tenant ? tenantIsPaused(tenant.tenant_id) : false;
}

/** The public availability route's check: it has only the link name. */
export async function assertSlugNotPaused(slug: string): Promise<void> {
  if (await slugIsPaused(slug)) throw new ApiError(409, "business_paused", pausedNoticeText);
}
