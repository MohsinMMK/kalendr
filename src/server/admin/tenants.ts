import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  adminSignupDaySchema, adminTenantHealthSchema, adminTenantListSchema,
  type AdminTenantHealth, type AdminTenantList,
} from "@/lib/admin-contracts";

import { getAdminBilling, getAdminPlans } from "../billing/admin-actions";
import { adminCall, count, isoTime, isoTimeOrNull } from "./db";

export const tenantPageSize = 25;

const listRowSchema = z.object({
  tenant_id: z.string(),
  slug: z.string(),
  name: z.string(),
  business_type: z.string(),
  created_at: isoTime,
  last_active_at: isoTimeOrNull,
  is_active: z.boolean(),
  paused_at: isoTimeOrNull,
  staff_count: count,
  setup_stage: z.enum(["signed_up", "services_added", "first_booking"]),
  total: count,
});

export interface TenantListQuery { search?: string; status: "all" | "active" | "paused"; page: number }

/**
 * One page of businesses. Counts and statuses only, plus each business's plan and status from the billing lane
 * (joined here for the page's ids, never in the SQL function that other lanes own).
 */
export async function listTenants(adminUserId: string, query: TenantListQuery): Promise<AdminTenantList> {
  const rows = await adminCall((database) => database.execute(sql`
    select * from admin_list_tenants(${adminUserId}, ${query.search ?? ""}, ${query.status}, ${tenantPageSize}, ${(query.page - 1) * tenantPageSize})
  `));
  const parsed = z.array(listRowSchema).parse([...rows]);
  const plans = new Map((await getAdminPlans(adminUserId, parsed.map((row) => row.tenant_id))).map((plan) => [plan.tenantId, plan]));
  return adminTenantListSchema.parse({
    items: parsed.map((row) => ({
      planKey: plans.get(row.tenant_id)?.planKey ?? null, planStatus: plans.get(row.tenant_id)?.status ?? null,
      tenantId: row.tenant_id, slug: row.slug, name: row.name, businessType: row.business_type, createdAt: row.created_at,
      lastActiveAt: row.last_active_at, isActive: row.is_active, pausedAt: row.paused_at, staffCount: row.staff_count, setupStage: row.setup_stage,
    })),
    total: parsed[0]?.total ?? 0,
    pageSize: tenantPageSize,
  });
}

export async function tenantHealth(adminUserId: string, tenantId: string): Promise<AdminTenantHealth> {
  const rows = await adminCall((database) => database.execute<{ health: unknown }>(sql`select admin_tenant_health(${adminUserId}, ${tenantId}) as health`));
  const health = adminTenantHealthSchema.parse(rows[0]?.health);
  const billing = await getAdminBilling(adminUserId, tenantId);
  return {
    ...health,
    billing: billing ? { planKey: billing.planKey, status: billing.status, trialEndsAt: billing.trialEndsAt, currentPeriodEnd: billing.currentPeriodEnd, usage: billing.usage } : null,
  };
}

export type SignupDay = z.infer<typeof adminSignupDaySchema>;

export async function signupsByDay(adminUserId: string, days: number): Promise<SignupDay[]> {
  const rows = await adminCall((database) => database.execute(sql`select * from admin_signups_by_day(${adminUserId}, ${days})`));
  return z.array(z.object({ day: z.union([z.date(), z.string()]).transform((value) => new Date(value).toISOString().slice(0, 10)), signups: count })).parse([...rows]);
}
