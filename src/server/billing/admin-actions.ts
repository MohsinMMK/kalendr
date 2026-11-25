import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { planKeySchema, type PlanKey } from "@/lib/entitlements";

import { adminCall, isoTime, isoTimeOrNull } from "../admin/db";

/**
 * Billing functions for the platform admin console (feature 15). Each one calls a `SECURITY DEFINER` function from
 * migration 0048 and 0049 that checks the operator's role and writes the admin audit row itself, so the console cannot reach
 * a business's billing any other way. Nothing here holds a card detail or a provider id.
 */

const planRow = z.object({
  tenant_id: z.string(),
  plan_key: planKeySchema,
  status: z.string(),
  trial_ends_at: isoTimeOrNull,
});

export interface AdminPlanSummary {
  tenantId: string;
  planKey: PlanKey;
  status: string;
  trialEndsAt: string | null;
}

/** Plan, status and trial end for a page of businesses at once (the list screen). Operators with support, billing or super. */
export async function getAdminPlans(adminUserId: string, tenantIds: readonly string[]): Promise<AdminPlanSummary[]> {
  if (tenantIds.length === 0) return [];
  // Ids are passed as one comma-joined parameter and split in SQL; an id with anything but id characters is refused first.
  const ids = z.array(z.string().regex(/^[A-Za-z0-9-]{1,64}$/)).max(500).parse([...tenantIds]);
  const rows = await adminCall((database) => database.execute(sql`select * from admin_tenant_plans(${adminUserId}, string_to_array(${ids.join(",")}, ','))`));
  return Array.from(rows, (row) => planRow.parse(row)).map((row) => ({ tenantId: row.tenant_id, planKey: row.plan_key, status: row.status, trialEndsAt: row.trial_ends_at }));
}

const billingDetail = z.object({
  planKey: planKeySchema,
  status: z.string(),
  trialEndsAt: isoTimeOrNull,
  currentPeriodEnd: isoTimeOrNull,
  provider: z.enum(["razorpay", "stripe"]).nullable(),
  pastDueSince: isoTimeOrNull,
  usage: z.record(z.string(), z.coerce.number().int()),
});
export type AdminBilling = z.infer<typeof billingDetail>;

/** One business's plan, period, provider and this month's usage counts. Null when the business has no subscription row. */
export async function getAdminBilling(adminUserId: string, tenantId: string): Promise<AdminBilling | null> {
  const rows = await adminCall((database) => database.execute(sql`select admin_tenant_billing(${adminUserId}, ${tenantId}) as detail`));
  const detail = Array.from(rows)[0]?.detail;
  return detail ? billingDetail.parse(detail) : null;
}

/** Gives a trial or Free business more days of Growth (1 to 60). A reason of a few words is required and goes in the admin audit log. */
export async function extendTrial(adminUserId: string, tenantId: string, days: number, reason: string): Promise<string> {
  const rows = await adminCall((database) => database.execute(sql`select admin_extend_trial(${adminUserId}, ${tenantId}, ${days}, ${reason}) as ends_at`));
  return isoTime.parse(Array.from(rows)[0]?.ends_at);
}

/** Sets a plan by hand, for billing fixes. It charges nobody: paid changes go through the provider. Needs a reason. */
export async function changePlanManually(adminUserId: string, tenantId: string, planKey: PlanKey, reason: string): Promise<void> {
  await adminCall((database) => database.execute(sql`select admin_change_plan(${adminUserId}, ${tenantId}, ${planKey}, ${reason})`));
}
