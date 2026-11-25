import { randomUUID } from "node:crypto";

import type postgres from "postgres";

import { resolvePermissions, type StaffRole } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

import { createCustomer, createTenant, type TenantFixture } from "./privacy-fixture";

export { createCustomer, createTenant };
export type { TenantFixture };

/** Only an isolated scratch server (5544, 5545, 5601, 5609), never a real database. */
export function isLocalDatabase(url: string | undefined): boolean {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5544", "5545", "5601", "5609"].includes(parsed.port);
}

/** Puts a business's subscription in the given state (made as the table owner, which the app role cannot do for money rows). */
export async function setSubscription(owner: postgres.Sql, tenantId: string, fields: {
  plan?: string; status?: string; trialEndsAt?: Date | null; periodEnd?: Date | null; pastDueSince?: Date | null;
  provider?: string | null; providerSubscriptionId?: string | null; cancelAtPeriodEnd?: boolean; pending?: string | null; overage?: string;
}): Promise<void> {
  await owner`
    insert into tenant_subscriptions (tenant_id, plan_key, status, trial_ends_at, current_period_end, past_due_since, provider, provider_subscription_id, cancel_at_period_end, pending_plan_key, overage_mode)
    values (${tenantId}, ${fields.plan ?? "growth"}, ${fields.status ?? "trialing"}, ${fields.trialEndsAt ?? null}, ${fields.periodEnd ?? null}, ${fields.pastDueSince ?? null},
      ${fields.provider ?? null}, ${fields.providerSubscriptionId ?? null}, ${fields.cancelAtPeriodEnd ?? false}, ${fields.pending ?? null}, ${fields.overage ?? "stop_marketing"})
    on conflict (tenant_id) do update set plan_key = excluded.plan_key, status = excluded.status, trial_ends_at = excluded.trial_ends_at, current_period_end = excluded.current_period_end,
      past_due_since = excluded.past_due_since, provider = excluded.provider, provider_subscription_id = excluded.provider_subscription_id,
      cancel_at_period_end = excluded.cancel_at_period_end, pending_plan_key = excluded.pending_plan_key, overage_mode = excluded.overage_mode`;
}

/** More active practitioners for a business, created a second apart so "oldest first" is well defined. */
export async function addPractitioners(owner: postgres.Sql, tenantId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const [row] = await owner<{ id: string }[]>`
      insert into practitioners (tenant_id, name, title, initials, specialty, created_at)
      values (${tenantId}, ${`Extra ${index}`}, 'Doctor', 'EX', 'General', now() + ${index + 1} * interval '1 second') returning id`;
    ids.push(row!.id);
  }
  return ids;
}

export function staffContext(fixture: Pick<TenantFixture, "tenantId" | "slug">, role: StaffRole = "owner", overrides: Partial<StaffContext> = {}): StaffContext {
  return {
    tenantId: fixture.tenantId, clinicSlug: fixture.slug, clinicName: "Billing Test", role, permissions: resolvePermissions(role, {}),
    membershipId: null, userId: randomUUID(), userName: "Owner", userEmail: "owner@example.com", secondFactorEnrolled: true, secondFactorAt: new Date(), preview: false, ...overrides,
  };
}
