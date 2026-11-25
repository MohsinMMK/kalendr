/**
 * Where packages, memberships and coupons meet a booking (feature 25). A booking calls `prepareBookingOffers` before its row
 * is written (to learn the price), `record` right after (to write the discounts, redemption and credit in the same transaction),
 * and `releaseBookingOffers` when it is cancelled or expires. Written against `Runner`; the worker's hold expiry uses the release.
 * No "server-only": the worker imports this.
 */
import { sql } from "drizzle-orm";

import { ApiError } from "../api-error";
import { priceBooking } from "../../lib/offers";
import { membershipBenefitsOn, normaliseCode, type MembershipStatus } from "../../lib/offers";
import { asDate, asNumber, asString, type Runner } from "../workflows/runner";
import { checkCoupon, recordRedemption, releaseRedemptions, requireCoupon } from "./coupons-core";
import { redeemCredit, returnCreditFor } from "./credits-core";

export interface BookingOfferRequest {
  couponCode?: string | null;
  /** Spend a credit from this package instead of paying. Desk only: online booking does not take packages. */
  customerPackageId?: string | null;
}

export interface PreparedOffers {
  /** The price to store on the booking: the list price less every discount. Null when the service has no price. */
  priceMinor: number | null;
  /** Nothing was applied. */
  none: boolean;
  record(appointmentId: string): Promise<void>;
}

/** The biggest member discount that applies to this customer and service right now, with the membership it came from. */
async function memberDiscount(run: Runner, tenantId: string, patientId: string, serviceId: string, now: Date): Promise<{ percent: number; membershipId: string } | null> {
  const rows = await run(sql`
    select membership.id, membership.status, membership.past_due_since, plan.member_discount_percent
    from customer_memberships as membership
    join membership_plans as plan on plan.tenant_id = membership.tenant_id and plan.id = membership.plan_id
    where membership.tenant_id = ${tenantId} and membership.patient_id = ${patientId} and membership.status in ('active', 'past_due')
      and plan.member_discount_percent > 0 and ${serviceId} = any (plan.service_ids)
    order by plan.member_discount_percent desc`);
  for (const row of rows) {
    if (membershipBenefitsOn(asString(row.status) as MembershipStatus, row.past_due_since ? asDate(row.past_due_since) : null, now)) {
      return { percent: asNumber(row.member_discount_percent), membershipId: asString(row.id) };
    }
  }
  return null;
}

export async function prepareBookingOffers(run: Runner, input: {
  tenantId: string; serviceId: string; patientId: string | null; listPriceMinor: number | null; request: BookingOfferRequest; mode: "staff" | "customer"; now?: Date;
}): Promise<PreparedOffers> {
  const now = input.now ?? new Date();
  const code = input.request.couponCode ? normaliseCode(input.request.couponCode) : null;
  const packageId = input.request.customerPackageId ?? null;
  const unchanged: PreparedOffers = { priceMinor: input.listPriceMinor, none: true, async record() {} };
  const list = input.listPriceMinor;
  const member = input.patientId && list && list > 0 ? await memberDiscount(run, input.tenantId, input.patientId, input.serviceId, now) : null;
  if (!code && !packageId && !member) return unchanged;
  if (code && packageId) throw new ApiError(409, "one_discount", "A booking can use a package or a code, not both.");
  if ((code || packageId) && (!list || list <= 0)) {
    throw new ApiError(409, "nothing_to_discount", packageId ? "This service has no price, so a package credit isn't needed." : "This service has no price, so a code can't be applied.");
  }
  if (packageId && input.mode !== "staff") throw new ApiError(403, "package_desk_only", "Packages are applied at the desk.");
  if (!list || list <= 0) return unchanged;

  if (packageId) {
    // The whole price is covered by the credit. The credit itself is spent in `record`, once the booking exists.
    return {
      priceMinor: 0, none: false,
      async record(appointmentId) {
        if (!input.patientId) throw new ApiError(409, "package_not_found", "Choose an existing customer to use a package.");
        await redeemCredit(run, { tenantId: input.tenantId, customerPackageId: packageId, patientId: input.patientId, appointmentId, serviceId: input.serviceId, actorUserId: null, now });
        await run(sql`
          insert into appointment_discounts (tenant_id, appointment_id, kind, list_price_minor, amount_minor, customer_package_id)
          values (${input.tenantId}, ${appointmentId}, 'package', ${list}, ${list}, ${packageId})`);
      },
    };
  }

  const check = code ? await checkCoupon(run, { tenantId: input.tenantId, code, serviceId: input.serviceId, patientId: input.patientId, appointmentId: null, now, lock: true }) : null;
  const coupon = code ? requireCoupon(check, input.mode) : null;
  const priced = priceBooking({ listMinor: list, memberPercent: member?.percent ?? 0, coupon: coupon ? { kind: coupon.kind, value: coupon.value, stackable: coupon.stackable } : null });
  if (priced.couponRefused) throw new ApiError(409, "coupon_not_combinable", "This code can't be used together with a member price.");
  return {
    priceMinor: priced.netMinor, none: priced.discounts.length === 0,
    async record(appointmentId) {
      for (const discount of priced.discounts) {
        await run(sql`
          insert into appointment_discounts (tenant_id, appointment_id, kind, list_price_minor, amount_minor, coupon_id, membership_id)
          values (${input.tenantId}, ${appointmentId}, ${discount.kind}, ${list}, ${discount.amountMinor},
            ${discount.kind === "coupon" ? coupon!.id : null}, ${discount.kind === "member_price" ? member!.membershipId : null})`);
        if (discount.kind === "coupon" && input.patientId) {
          await recordRedemption(run, { tenantId: input.tenantId, couponId: coupon!.id, appointmentId, patientId: input.patientId, discountMinor: discount.amountMinor });
        }
      }
    },
  };
}

const RETURN_EVENTS: Record<string, "cancel" | "decline" | undefined> = {
  "appointment.cancel": "cancel",
  "appointment.status.cancelled": "cancel",
  "appointment.status.declined": "decline",
  "appointment.status.expired": "decline",
  "appointment.status.entered_in_error": "decline",
};

/** A booking that will not happen gives its code and credit back. No-shows keep both: the visit was held for them. */
export async function releaseBookingOffers(run: Runner, input: { tenantId: string; appointmentId: string; action: string; now?: Date }): Promise<void> {
  const event = RETURN_EVENTS[input.action];
  if (!event) return;
  await releaseRedemptions(run, input.tenantId, input.appointmentId);
  await returnCreditFor(run, { tenantId: input.tenantId, appointmentId: input.appointmentId, event, now: input.now ?? new Date() });
}
