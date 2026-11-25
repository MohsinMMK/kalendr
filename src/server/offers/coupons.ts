import "server-only";

import { sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";
import { auditEvents } from "@/db/schema";
import { formatMoney } from "@/lib/money";
import type { CouponInput, CouponView, ValidateCouponInput, ValidateCouponResult } from "@/lib/offers-contracts";
import { describeCoupon, GENERIC_COUPON_REFUSAL, normaliseCode, priceBooking, type CouponKind } from "@/lib/offers";

import { textArray } from "./sql";
import { ApiError } from "../api-error";
import { isPreviewMode } from "../preview-repository";
import { requirePermission, type StaffContext } from "../staff-context";
import { asDate, asNumber, drizzleRunner } from "../workflows/runner";
import { findCoupon, totalUses } from "./coupons-core";

function refusePreview(context: StaffContext): void {
  if (context.preview || isPreviewMode()) throw new ApiError(409, "preview_only", "Codes are not kept in the preview.");
}

type CouponDbRow = {
  id: string; code: string; kind: CouponKind; value: number; max_uses: number | null; per_customer_limit: number | null; valid_from: Date | null; valid_to: Date | null;
  service_ids: string[]; first_visit_only: boolean; stackable: boolean; is_active: boolean; version: number; used: number | string;
};

function view(row: CouponDbRow): CouponView {
  return {
    id: row.id, code: row.code, kind: row.kind, value: asNumber(row.value), maxUses: row.max_uses === null ? null : asNumber(row.max_uses),
    perCustomerLimit: row.per_customer_limit === null ? null : asNumber(row.per_customer_limit), validFrom: row.valid_from ? asDate(row.valid_from).toISOString() : null,
    validTo: row.valid_to ? asDate(row.valid_to).toISOString() : null, serviceIds: row.service_ids, firstVisitOnly: row.first_visit_only, stackable: row.stackable,
    isActive: row.is_active, version: asNumber(row.version), used: asNumber(row.used),
  };
}

const selectCoupons = (tenantId: string, only: string | null) => sql`
  select c.*, (select count(*) from coupon_redemptions r where r.tenant_id = c.tenant_id and r.coupon_id = c.id and r.released_at is null) as used
  from coupons c where c.tenant_id = ${tenantId} and (${only}::text is null or c.id = ${only}) order by c.is_active desc, c.created_at desc`;

export async function listCoupons(context: StaffContext): Promise<CouponView[]> {
  requirePermission(context, "schedule.read");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => (await transaction.execute<CouponDbRow>(selectCoupons(context.tenantId, null))).map(view));
}

/** Creates a code (no id) or edits one. The code itself cannot be changed once it has been used. */
export async function saveCoupon(context: StaffContext, couponId: string | null, input: CouponInput): Promise<CouponView> {
  requirePermission(context, "payments.settings");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    if (input.serviceIds.length > 0) {
      const found = await transaction.execute<{ id: string }>(sql`select id from services where tenant_id = ${context.tenantId} and id = any (${textArray(input.serviceIds)})`);
      if (found.length !== new Set(input.serviceIds).size) throw new ApiError(404, "service_not_found", "One of those services could not be found.");
    }
    let id = couponId;
    try {
      if (couponId) {
        const [current] = await transaction.execute<{ code: string; version: number }>(sql`select code, version from coupons where tenant_id = ${context.tenantId} and id = ${couponId} for update`);
        if (!current) throw new ApiError(404, "coupon_not_found", "That code could not be found.");
        if (input.version !== undefined && input.version !== current.version) throw new ApiError(409, "version_conflict", "Someone else changed this code. Reload and try again.");
        if (current.code !== input.code && (await totalUses(drizzleRunner(transaction), context.tenantId, couponId)) > 0) {
          throw new ApiError(409, "code_in_use", "This code has been used, so its letters can't change. Switch it off and make a new one.");
        }
        await transaction.execute(sql`
          update coupons set code = ${input.code}, kind = ${input.kind}, value = ${input.value}, max_uses = ${input.maxUses ?? null}, per_customer_limit = ${input.perCustomerLimit ?? null},
            valid_from = ${input.validFrom ?? null}::timestamptz, valid_to = ${input.validTo ?? null}::timestamptz, service_ids = ${textArray(input.serviceIds)},
            first_visit_only = ${input.firstVisitOnly}, stackable = ${input.stackable}, is_active = ${input.isActive}, version = version + 1, updated_at = now()
          where tenant_id = ${context.tenantId} and id = ${couponId}`);
      } else {
        const [created] = await transaction.execute<{ id: string }>(sql`
          insert into coupons (tenant_id, code, kind, value, max_uses, per_customer_limit, valid_from, valid_to, service_ids, first_visit_only, stackable, is_active)
          values (${context.tenantId}, ${input.code}, ${input.kind}, ${input.value}, ${input.maxUses ?? null}, ${input.perCustomerLimit ?? null}, ${input.validFrom ?? null}::timestamptz,
            ${input.validTo ?? null}::timestamptz, ${textArray(input.serviceIds)}, ${input.firstVisitOnly}, ${input.stackable}, ${input.isActive}) returning id`);
        id = created!.id;
      }
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "cause" in error && (error.cause as { code?: string })?.code === "23505") {
        throw new ApiError(409, "code_taken", "You already have a code with those letters.");
      }
      throw error;
    }
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: couponId ? "coupon.updated" : "coupon.created", outcome: "success",
      metadata: { couponId: id, kind: input.kind, value: input.value },
    });
    const [row] = await transaction.execute<CouponDbRow>(selectCoupons(context.tenantId, id));
    return view(row!);
  });
}

/**
 * The booking page's check. Every failure (no such code, expired, used up, wrong service) gets the same answer and the
 * route is tightly rate-limited, so a code can't be found by guessing. Rules that depend on who is booking (first visit only,
 * once per customer) are enforced when the booking is made, never revealed here.
 */
export async function validateCouponPublic(input: ValidateCouponInput): Promise<ValidateCouponResult> {
  const refused: ValidateCouponResult = { valid: false, message: GENERIC_COUPON_REFUSAL };
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "Codes can't be checked right now.");
  const [tenant] = await database.execute<{ tenant_id: string }>(sql`select tenant_id from kalendr_resolve_tenant(${input.clinicSlug}, null)`);
  if (!tenant) return refused;
  return withTenant(tenant.tenant_id, async (transaction) => {
    const run = drizzleRunner(transaction);
    const coupon = await findCoupon(run, tenant.tenant_id, normaliseCode(input.code));
    const [service] = await transaction.execute<{ price_minor: number | null }>(sql`select price_minor from services where tenant_id = ${tenant.tenant_id} and id = ${input.serviceId} and is_active`);
    if (!coupon || !service?.price_minor) return refused;
    const now = new Date();
    if (!coupon.isActive || (coupon.validFrom && now < coupon.validFrom) || (coupon.validTo && now >= coupon.validTo)) return refused;
    if (coupon.serviceIds.length > 0 && !coupon.serviceIds.includes(input.serviceId)) return refused;
    if (coupon.maxUses !== null && (await totalUses(run, tenant.tenant_id, coupon.id)) >= coupon.maxUses) return refused;
    const [tenantRow] = await transaction.execute<{ currency: string }>(sql`select currency from tenants where id = ${tenant.tenant_id}`);
    const currency = tenantRow?.currency ?? "INR";
    const priced = priceBooking({ listMinor: service.price_minor, coupon: { kind: coupon.kind, value: coupon.value, stackable: coupon.stackable } });
    return {
      valid: true, description: describeCoupon(coupon.kind, coupon.value, (minor) => formatMoney(minor, currency)),
      discountMinor: priced.listMinor - priced.netMinor, netMinor: priced.netMinor, currency,
    };
  });
}
