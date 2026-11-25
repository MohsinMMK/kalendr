import "server-only";

import { addMonths } from "date-fns";
import { sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents } from "@/db/schema";
import type { CustomerMembershipView, EnrolMembershipInput, MembershipPlanInput, MembershipPlanView } from "@/lib/offers-contracts";

import { textArray } from "./sql";
import { ApiError } from "../api-error";
import { loadVisibleCustomer } from "../customers/access";
import { claimKey, finishKey } from "../idempotent";
import { isPreviewMode } from "../preview-repository";
import { requirePermission, type StaffContext } from "../staff-context";
import { asNumber, drizzleRunner } from "../workflows/runner";
import { loadCustomerOffers } from "./packages";
import { applyMembershipEvent } from "./memberships-core";

function refusePreview(context: StaffContext): void {
  if (context.preview || isPreviewMode()) throw new ApiError(409, "preview_only", "Memberships are not kept in the preview.");
}

type PlanRow = { id: string; name: string; description: string | null; price_minor: number; credits_per_period: number; member_discount_percent: number; service_ids: string[]; is_active: boolean; version: number; members: number | string };

const selectPlans = (tenantId: string, only: string | null) => sql`
  select p.id, p.name, p.description, p.price_minor, p.credits_per_period, p.member_discount_percent, p.service_ids, p.is_active, p.version,
    (select count(*) from customer_memberships m where m.tenant_id = p.tenant_id and m.plan_id = p.id and m.status in ('active', 'past_due')) as members
  from membership_plans p where p.tenant_id = ${tenantId} and (${only}::text is null or p.id = ${only}) order by p.is_active desc, p.name`;

function view(row: PlanRow, currency: string): MembershipPlanView {
  return {
    id: row.id, name: row.name, description: row.description, priceMinor: asNumber(row.price_minor), currency, creditsPerPeriod: asNumber(row.credits_per_period),
    memberDiscountPercent: asNumber(row.member_discount_percent), serviceIds: row.service_ids, isActive: row.is_active, version: asNumber(row.version), activeMembers: asNumber(row.members),
  };
}

export async function listPlans(context: StaffContext): Promise<MembershipPlanView[]> {
  requirePermission(context, "schedule.read");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const [tenant] = await transaction.execute<{ currency: string }>(sql`select currency from tenants where id = ${context.tenantId}`);
    return (await transaction.execute<PlanRow>(selectPlans(context.tenantId, null))).map((row) => view(row, tenant?.currency ?? "INR"));
  });
}

export async function savePlan(context: StaffContext, planId: string | null, input: MembershipPlanInput): Promise<MembershipPlanView> {
  requirePermission(context, "payments.settings");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const found = await transaction.execute<{ id: string }>(sql`select id from services where tenant_id = ${context.tenantId} and id = any (${textArray(input.serviceIds)})`);
    if (found.length !== new Set(input.serviceIds).size) throw new ApiError(404, "service_not_found", "One of those services could not be found.");
    let id = planId;
    if (planId) {
      const updated = await transaction.execute<{ id: string }>(sql`
        update membership_plans set name = ${input.name}, description = ${input.description ?? null}, price_minor = ${input.priceMinor}, credits_per_period = ${input.creditsPerPeriod},
          member_discount_percent = ${input.memberDiscountPercent}, service_ids = ${textArray(input.serviceIds)}, is_active = ${input.isActive}, version = version + 1, updated_at = now()
        where tenant_id = ${context.tenantId} and id = ${planId} and (${input.version ?? null}::int is null or version = ${input.version ?? null}::int) returning id`);
      if (updated.length === 0) {
        const [exists] = await transaction.execute<{ id: string }>(sql`select id from membership_plans where tenant_id = ${context.tenantId} and id = ${planId}`);
        throw exists ? new ApiError(409, "version_conflict", "Someone else changed this plan. Reload and try again.") : new ApiError(404, "plan_not_found", "That plan could not be found.");
      }
    } else {
      const [created] = await transaction.execute<{ id: string }>(sql`
        insert into membership_plans (tenant_id, name, description, price_minor, credits_per_period, member_discount_percent, service_ids, is_active)
        values (${context.tenantId}, ${input.name}, ${input.description ?? null}, ${input.priceMinor}, ${input.creditsPerPeriod}, ${input.memberDiscountPercent}, ${textArray(input.serviceIds)}, ${input.isActive}) returning id`);
      id = created!.id;
    }
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: planId ? "membership_plan.updated" : "membership_plan.created", outcome: "success",
      metadata: { planId: id, priceMinor: input.priceMinor, creditsPerPeriod: input.creditsPerPeriod, discountPercent: input.memberDiscountPercent },
    });
    const [tenant] = await transaction.execute<{ currency: string }>(sql`select currency from tenants where id = ${context.tenantId}`);
    const [row] = await transaction.execute<PlanRow>(selectPlans(context.tenantId, id));
    return view(row!, tenant?.currency ?? "INR");
  });
}

/**
 * Starts a membership at the desk, billed by hand each month ("manual": the desk records every renewal). The first month is paid
 * now. Provider subscriptions (Razorpay, Stripe) are created from the provider's dashboard until the business connects them;
 * their renewals arrive as webhooks and use the same rules.
 */
export async function enrolMembership(context: StaffContext, input: EnrolMembershipInput, idempotencyKey: string): Promise<CustomerMembershipView> {
  requirePermission(context, "payments.collect");
  requirePermission(context, "invoices.issue");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const claim = await claimKey<CustomerMembershipView>(transaction, context.tenantId, "staff.memberships.enrol", idempotencyKey, input);
    if ("replay" in claim) return claim.replay;
    const [plan] = await transaction.execute<{ id: string; price_minor: number; is_active: boolean }>(sql`select id, price_minor, is_active from membership_plans where tenant_id = ${context.tenantId} and id = ${input.planId}`);
    if (!plan) throw new ApiError(404, "plan_not_found", "That plan could not be found.");
    if (!plan.is_active) throw new ApiError(409, "plan_inactive", "This plan is no longer on sale.");
    // A customer hidden from this person (other branch) reads as missing.
    await loadVisibleCustomer(transaction, context, input.patientId);
    const [patient] = await transaction.execute<{ id: string }>(sql`select id from patients where tenant_id = ${context.tenantId} and id = ${input.patientId} for key share`);
    if (!patient) throw new ApiError(404, "patient_not_found", "That customer could not be found.");
    const [already] = await transaction.execute<{ id: string }>(sql`select id from customer_memberships where tenant_id = ${context.tenantId} and patient_id = ${input.patientId} and plan_id = ${input.planId} and status in ('active', 'past_due', 'paused')`);
    if (already) throw new ApiError(409, "already_member", "This customer already has this membership.");
    const now = new Date();
    const subscriptionId = `manual_${crypto.randomUUID()}`;
    const [membership] = await transaction.execute<{ id: string }>(sql`
      insert into customer_memberships (tenant_id, patient_id, plan_id, provider, provider_subscription_id, status, current_period_end, started_at, created_by_user_id)
      values (${context.tenantId}, ${input.patientId}, ${input.planId}, 'manual', ${subscriptionId}, 'active', ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz, ${context.userId}) returning id`);
    await applyMembershipEvent(drizzleRunner(transaction), { tenantId: context.tenantId, provider: "manual", providerSubscriptionId: subscriptionId, eventId: `manual:${membership!.id}:${now.toISOString()}` },
      { kind: "renewed", periodStart: now, periodEnd: addMonths(now, 1), amountMinor: asNumber(plan.price_minor), method: input.method, actorUserId: context.userId }, now);
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "membership.started", outcome: "success", metadata: { membershipId: membership!.id, planId: input.planId },
    });
    const offers = await loadCustomerOffers(transaction, context.tenantId, input.patientId);
    const created = offers.memberships.find((entry) => entry.id === membership!.id)!;
    await finishKey(transaction, claim.claimId, created);
    return created;
  });
}

/** The desk takes this month's payment for a manually billed membership, and the next month's credits arrive. */
export async function renewMembership(context: StaffContext, membershipId: string, method: "cash" | "upi" | "card" | "bank", idempotencyKey: string): Promise<CustomerMembershipView> {
  requirePermission(context, "payments.collect");
  requirePermission(context, "invoices.issue");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const claim = await claimKey<CustomerMembershipView>(transaction, context.tenantId, "staff.memberships.renew", idempotencyKey, { membershipId, method });
    if ("replay" in claim) return claim.replay;
    const [row] = await transaction.execute<{ patient_id: string; provider: string; provider_subscription_id: string; status: string; current_period_end: Date; price_minor: number }>(sql`
      select m.patient_id, m.provider, m.provider_subscription_id, m.status, m.current_period_end, p.price_minor
      from customer_memberships m join membership_plans p on p.tenant_id = m.tenant_id and p.id = m.plan_id
      where m.tenant_id = ${context.tenantId} and m.id = ${membershipId} for update of m`);
    if (!row) throw new ApiError(404, "membership_not_found", "That membership could not be found.");
    await loadVisibleCustomer(transaction, context, row.patient_id, { allowMerged: true });
    if (row.provider !== "manual") throw new ApiError(409, "billed_by_provider", "This membership renews through the payment provider. It can't be renewed by hand.");
    if (row.status === "cancelled") throw new ApiError(409, "membership_cancelled", "This membership was cancelled.");
    const now = new Date();
    const start = new Date(row.current_period_end) > now ? new Date(row.current_period_end) : now;
    await applyMembershipEvent(drizzleRunner(transaction), { tenantId: context.tenantId, provider: "manual", providerSubscriptionId: row.provider_subscription_id, eventId: `manual:${membershipId}:${start.toISOString()}` },
      { kind: "renewed", periodStart: start, periodEnd: addMonths(start, 1), amountMinor: asNumber(row.price_minor), method, actorUserId: context.userId }, now);
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "membership.renewed", outcome: "success", metadata: { membershipId },
    });
    const offers = await loadCustomerOffers(transaction, context.tenantId, row.patient_id);
    const result = offers.memberships.find((entry) => entry.id === membershipId)!;
    await finishKey(transaction, claim.claimId, result);
    return result;
  });
}

/** Cancel, pause or resume a membership from the desk. Provider-billed ones are changed at the provider and arrive as events. */
export async function changeMembership(context: StaffContext, membershipId: string, action: "cancel" | "pause" | "resume"): Promise<CustomerMembershipView> {
  requirePermission(context, "payments.collect");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.execute<{ patient_id: string; provider: string; status: string }>(sql`
      select patient_id, provider, status from customer_memberships where tenant_id = ${context.tenantId} and id = ${membershipId} for update`);
    if (!row) throw new ApiError(404, "membership_not_found", "That membership could not be found.");
    await loadVisibleCustomer(transaction, context, row.patient_id, { allowMerged: true });
    if (row.provider !== "manual") throw new ApiError(409, "billed_by_provider", "Change this membership at the payment provider. The change arrives here by itself.");
    if (row.status === "cancelled") throw new ApiError(409, "membership_cancelled", "This membership was already cancelled.");
    const next = action === "cancel" ? "cancelled" : action === "pause" ? "paused" : "active";
    await transaction.execute(sql`
      update customer_memberships set status = ${next}, past_due_since = null, ended_at = case when ${next} = 'cancelled' then now() else null end, updated_at = now()
      where tenant_id = ${context.tenantId} and id = ${membershipId}`);
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: `membership.${action}`, outcome: "success", metadata: { membershipId },
    });
    return (await loadCustomerOffers(transaction, context.tenantId, row.patient_id)).memberships.find((entry) => entry.id === membershipId)!;
  });
}
