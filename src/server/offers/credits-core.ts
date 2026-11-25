/**
 * The credit ledger (feature 25). Written against `Runner` so booking, cancelling, the nightly expiry and membership renewals
 * all use the same code on both sides of the app. Rows are only ever added; a balance is the sum of `change`.
 * No "server-only": the worker imports this.
 */
import { sql } from "drizzle-orm";

import { ApiError } from "../api-error";
import { asDate, asNumber, asString, type Runner } from "../workflows/runner";
import { membershipBenefitsOn, reminderDue, type MembershipStatus } from "../../lib/offers";

export interface HeldPackage {
  id: string;
  patientId: string;
  source: string;
  membershipId: string | null;
  serviceIds: string[];
  expiresAt: Date;
  remaining: number;
}

/** The credit left on one package: the sum of its ledger. */
export async function remainingCredits(run: Runner, tenantId: string, customerPackageId: string): Promise<number> {
  const [row] = await run(sql`select coalesce(sum("change"), 0) as remaining from customer_credits where tenant_id = ${tenantId} and customer_package_id = ${customerPackageId}`);
  return asNumber(row?.remaining);
}

/**
 * Locks the package row so two bookings at once queue up here, then reads it. The lock is a write (the row is rewritten with
 * the same values), not just `for update`: a booking runs at serializable isolation, where a waiter keeps its old snapshot and
 * would not see the winner's credit row, but a waiter whose row was rewritten under it is stopped and retried, and then sees it.
 */
export async function lockPackage(run: Runner, tenantId: string, customerPackageId: string): Promise<HeldPackage | null> {
  const [row] = await run(sql`
    update customer_packages set bought_at = bought_at
    where tenant_id = ${tenantId} and id = ${customerPackageId}
    returning id, patient_id, source, membership_id, service_ids, expires_at`);
  if (!row) return null;
  return {
    id: asString(row.id), patientId: asString(row.patient_id), source: asString(row.source), membershipId: row.membership_id ? asString(row.membership_id) : null,
    serviceIds: row.service_ids as string[], expiresAt: asDate(row.expires_at), remaining: await remainingCredits(run, tenantId, customerPackageId),
  };
}

export type RedeemResult = { status: "used"; remaining: number } | { status: "already_used" };

/**
 * Spends one credit on a booking, in the caller's transaction. Locks the package first, then checks the balance, so ten
 * bookings at once against one credit leave exactly one winner. A repeat for the same booking is a no-op.
 */
export async function redeemCredit(run: Runner, input: { tenantId: string; customerPackageId: string; patientId: string; appointmentId: string; serviceId: string; actorUserId: string | null; now: Date }): Promise<RedeemResult> {
  const held = await lockPackage(run, input.tenantId, input.customerPackageId);
  if (!held || held.patientId !== input.patientId) throw new ApiError(404, "package_not_found", "That package could not be found for this customer.");
  const [already] = await run(sql`select 1 from customer_credits where tenant_id = ${input.tenantId} and customer_package_id = ${input.customerPackageId} and appointment_id = ${input.appointmentId} and kind = 'use'`);
  if (already) return { status: "already_used" };
  if (held.expiresAt <= input.now) throw new ApiError(409, "package_expired", "This package has expired.");
  if (!held.serviceIds.includes(input.serviceId)) throw new ApiError(409, "package_wrong_service", "This package can't be used for that service.");
  if (held.membershipId) {
    const [membership] = await run(sql`select status, past_due_since from customer_memberships where tenant_id = ${input.tenantId} and id = ${held.membershipId}`);
    const on = membership ? membershipBenefitsOn(asString(membership.status) as MembershipStatus, membership.past_due_since ? asDate(membership.past_due_since) : null, input.now) : false;
    if (!on) throw new ApiError(409, "membership_inactive", "This membership's benefits are paused. Ask the customer to update their payment.");
  }
  if (held.remaining < 1) throw new ApiError(409, "no_credits", "This package has no credits left.");
  const inserted = await run(sql`
    insert into customer_credits (tenant_id, customer_package_id, "change", kind, appointment_id, reason, actor_user_id)
    values (${input.tenantId}, ${input.customerPackageId}, -1, 'use', ${input.appointmentId}, 'Used on a booking', ${input.actorUserId})
    on conflict do nothing returning id`);
  if (inserted.length === 0) return { status: "already_used" };
  return { status: "used", remaining: held.remaining - 1 };
}

/**
 * Puts a credit back when a booking paid with one is cancelled. Inside the free-cancel window, or when the business
 * cancelled, it goes back; a late cancel by the customer keeps it spent. Once per booking: the ledger refuses a second return.
 */
export async function returnCreditFor(run: Runner, input: { tenantId: string; appointmentId: string; event: "cancel" | "no_show" | "decline"; now: Date }): Promise<{ returned: number; kept: number }> {
  const uses = await run(sql`
    select credit.customer_package_id from customer_credits as credit
    where credit.tenant_id = ${input.tenantId} and credit.appointment_id = ${input.appointmentId} and credit.kind = 'use'`);
  if (uses.length === 0) return { returned: 0, kept: 0 };
  const [visit] = await run(sql`select starts_at, cancelled_by from appointments where tenant_id = ${input.tenantId} and id = ${input.appointmentId}`);
  const [policy] = await run(sql`select free_cancel_hours from tenant_payment_policies where tenant_id = ${input.tenantId}`);
  const freeHours = policy ? asNumber(policy.free_cancel_hours) : 24;
  const startsAt = visit ? asDate(visit.starts_at) : input.now;
  const byBusiness = visit ? asString(visit.cancelled_by) !== "customer" : true;
  const early = startsAt.getTime() - input.now.getTime() >= freeHours * 3_600_000;
  const giveBack = input.event === "decline" || (input.event === "cancel" && (byBusiness || early));
  if (!giveBack) return { returned: 0, kept: uses.length };
  let returned = 0;
  for (const use of uses) {
    const packageId = asString(use.customer_package_id);
    // Lock first so a return and a use of the same package serialise.
    await run(sql`update customer_packages set bought_at = bought_at where tenant_id = ${input.tenantId} and id = ${packageId}`);
    const inserted = await run(sql`
      insert into customer_credits (tenant_id, customer_package_id, "change", kind, appointment_id, reason)
      values (${input.tenantId}, ${packageId}, 1, 'return', ${input.appointmentId}, ${input.event === "cancel" ? "Booking cancelled in time" : "Booking not going ahead"})
      on conflict do nothing returning id`);
    returned += inserted.length;
  }
  return { returned, kept: uses.length - returned };
}

/** Writes an expiry row for credits left on packages that ran out of time. Safe to run twice: the dedupe key allows one per package. */
export async function expireCredits(run: Runner, tenantId: string, now: Date): Promise<number> {
  const due = await run(sql`
    select package.id from customer_packages as package
    where package.tenant_id = ${tenantId} and package.expires_at <= ${now.toISOString()}::timestamptz
      and (select coalesce(sum(credit."change"), 0) from customer_credits as credit where credit.tenant_id = package.tenant_id and credit.customer_package_id = package.id) > 0
    order by package.expires_at limit 200`);
  let expired = 0;
  for (const row of due) {
    const id = asString(row.id);
    await run(sql`update customer_packages set bought_at = bought_at where tenant_id = ${tenantId} and id = ${id}`);
    const remaining = await remainingCredits(run, tenantId, id);
    if (remaining <= 0) continue;
    const inserted = await run(sql`
      insert into customer_credits (tenant_id, customer_package_id, "change", kind, reason, dedupe_key)
      values (${tenantId}, ${id}, ${-remaining}, 'expiry', 'Package expired', ${`expiry:${id}`})
      on conflict do nothing returning id`);
    expired += inserted.length;
  }
  return expired;
}

export const EXPIRY_REMINDER_EVENT = "package.expiry_reminder";

/**
 * Queues the 14-day and 3-day "credits left" message once each, as outbox rows the worker delivers. The package row records
 * that the stage was queued, so a second run sends nothing more.
 */
export async function queueExpiryReminders(run: Runner, tenantId: string, now: Date): Promise<number> {
  const candidates = await run(sql`
    select package.id, package.expires_at, package.reminded_14_at is not null as sent14, package.reminded_3_at is not null as sent3,
      (select coalesce(sum(credit."change"), 0) from customer_credits as credit where credit.tenant_id = package.tenant_id and credit.customer_package_id = package.id) as remaining
    from customer_packages as package
    where package.tenant_id = ${tenantId} and package.expires_at > ${now.toISOString()}::timestamptz and package.expires_at <= ${new Date(now.getTime() + 14 * 86_400_000).toISOString()}::timestamptz
    order by package.expires_at limit 500`);
  let queued = 0;
  for (const row of candidates) {
    const stage = reminderDue({ expiresAt: asDate(row.expires_at), now, remaining: asNumber(row.remaining), sent14: row.sent14 === true, sent3: row.sent3 === true });
    if (!stage) continue;
    const id = asString(row.id);
    await run(sql`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      values (${tenantId}, 'customer_package', ${id}, ${EXPIRY_REMINDER_EVENT}, ${JSON.stringify({ customerPackageId: id, stage })}::text::jsonb, ${`${EXPIRY_REMINDER_EVENT}:${id}:${stage}`})
      on conflict (tenant_id, dedupe_key) do nothing`);
    // A 3-day reminder also covers the 14-day one for a package bought late.
    await run(stage === 3
      ? sql`update customer_packages set reminded_3_at = ${now.toISOString()}::timestamptz, reminded_14_at = coalesce(reminded_14_at, ${now.toISOString()}::timestamptz) where tenant_id = ${tenantId} and id = ${id}`
      : sql`update customer_packages set reminded_14_at = ${now.toISOString()}::timestamptz where tenant_id = ${tenantId} and id = ${id}`);
    queued += 1;
  }
  return queued;
}
