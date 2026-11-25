/**
 * Coupon rules against the database (feature 25), written against `Runner`. The total-use count is taken under a lock on the
 * coupon row, so a 100-use code cannot be used 101 times however many bookings arrive at once.
 * No "server-only": the worker imports this.
 */
import { sql } from "drizzle-orm";

import { ApiError } from "../api-error";
import { couponRefusal, couponRefusalText, type CouponFacts, type CouponKind, type CouponRefusal } from "../../lib/offers";
import { asDate, asNumber, asString, type Runner } from "../workflows/runner";

export interface CouponRow extends CouponFacts {
  id: string;
  code: string;
  kind: CouponKind;
  value: number;
  stackable: boolean;
}

function toRow(row: Record<string, unknown>): CouponRow {
  return {
    id: asString(row.id), code: asString(row.code), kind: asString(row.kind) as CouponKind, value: asNumber(row.value), stackable: row.stackable === true,
    isActive: row.is_active === true, validFrom: row.valid_from ? asDate(row.valid_from) : null, validTo: row.valid_to ? asDate(row.valid_to) : null,
    serviceIds: row.service_ids as string[], firstVisitOnly: row.first_visit_only === true, maxUses: row.max_uses === null ? null : asNumber(row.max_uses),
    perCustomerLimit: row.per_customer_limit === null ? null : asNumber(row.per_customer_limit),
  };
}

/**
 * Looks a code up. `lock` takes the lock that serialises redemptions, and it is a write (the row is rewritten with the same
 * values), not just `for update`: a booking runs at serializable isolation, where a waiter keeps its old snapshot and would count
 * too few redemptions, but a waiter whose row was rewritten under it is stopped and retried, and then counts them all.
 */
export async function findCoupon(run: Runner, tenantId: string, code: string, lock = false): Promise<CouponRow | null> {
  const [row] = await run(lock
    ? sql`update coupons set updated_at = updated_at where tenant_id = ${tenantId} and code = ${code} returning *`
    : sql`select * from coupons where tenant_id = ${tenantId} and code = ${code}`);
  return row ? toRow(row) : null;
}

export async function totalUses(run: Runner, tenantId: string, couponId: string): Promise<number> {
  const [row] = await run(sql`select count(*) as used from coupon_redemptions where tenant_id = ${tenantId} and coupon_id = ${couponId} and released_at is null`);
  return asNumber(row?.used);
}

/** Whether the customer has had a visit here that counts (booked, kept or finished), not counting `exceptAppointmentId`. */
export async function hasPriorVisit(run: Runner, tenantId: string, patientId: string | null, exceptAppointmentId: string | null): Promise<boolean> {
  if (!patientId) return false;
  const [row] = await run(sql`
    select exists (select 1 from appointments where tenant_id = ${tenantId} and patient_id = ${patientId}
      and status::text in ('booked', 'checked_in', 'completed', 'no_show') and (${exceptAppointmentId}::text is null or id <> ${exceptAppointmentId})) as prior`);
  return row?.prior === true;
}

export interface CouponCheck {
  coupon: CouponRow;
  refusal: CouponRefusal | null;
}

/** Every rule, with the counts read under the lock when `lock` is set. `patientId` is null when the customer is not known yet. */
export async function checkCoupon(run: Runner, input: { tenantId: string; code: string; serviceId: string; patientId: string | null; appointmentId: string | null; now: Date; lock: boolean }): Promise<CouponCheck | null> {
  const coupon = await findCoupon(run, input.tenantId, input.code, input.lock);
  if (!coupon) return null;
  const customerUses = input.patientId
    ? asNumber((await run(sql`select count(*) as used from coupon_redemptions where tenant_id = ${input.tenantId} and coupon_id = ${coupon.id} and patient_id = ${input.patientId} and released_at is null`))[0]?.used)
    : 0;
  return {
    coupon,
    refusal: couponRefusal(coupon, {
      now: input.now, serviceId: input.serviceId, hasPriorVisit: await hasPriorVisit(run, input.tenantId, input.patientId, input.appointmentId),
      customerUses, totalUses: await totalUses(run, input.tenantId, coupon.id),
    }),
  };
}

/** Throws a plain refusal (for staff and for a booking) when a code cannot be used. A booking never says which rule failed to a customer. */
export function requireCoupon(check: CouponCheck | null, mode: "staff" | "customer"): CouponRow {
  if (!check || check.refusal) {
    const reason = check?.refusal;
    throw new ApiError(409, "coupon_invalid", mode === "staff" && reason ? couponRefusalText[reason] : "That code isn't valid for this booking.");
  }
  return check.coupon;
}

/** Records a redemption. The unique (coupon, booking) key makes a repeat a no-op. */
export async function recordRedemption(run: Runner, input: { tenantId: string; couponId: string; appointmentId: string; patientId: string; discountMinor: number }): Promise<void> {
  await run(sql`
    insert into coupon_redemptions (tenant_id, coupon_id, appointment_id, patient_id, discount_minor)
    values (${input.tenantId}, ${input.couponId}, ${input.appointmentId}, ${input.patientId}, ${input.discountMinor})
    on conflict (tenant_id, coupon_id, appointment_id) do nothing`);
}

/** Lets a code count again when its booking is cancelled or its hold expires. The row stays; only the release time is set. */
export async function releaseRedemptions(run: Runner, tenantId: string, appointmentId: string): Promise<number> {
  const released = await run(sql`
    update coupon_redemptions set released_at = now() where tenant_id = ${tenantId} and appointment_id = ${appointmentId} and released_at is null returning id`);
  return released.length;
}
