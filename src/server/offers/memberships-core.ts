/**
 * Membership lifecycle (feature 25), written against `Runner` so the provider's webhook (through the worker), the desk's
 * manual renewal and the nightly grace sweep all share it. A renewal adds the period's credits once, an invoice and the
 * payment; a failed one starts 7 days' grace, then benefits pause. No "server-only": the worker imports this.
 */
import { sql } from "drizzle-orm";

import { textArray } from "./sql";
import { asDate, asNumber, asString, type Runner } from "../workflows/runner";
import { insertInvoice } from "../invoicing/issue-core";
import { defaultServiceTax, loadTaxSettings } from "../invoicing/tax";

export type MembershipEvent =
  | { kind: "renewed"; periodStart: Date; periodEnd: Date; amountMinor: number; method: "cash" | "upi" | "card" | "bank" | "other"; actorUserId?: string | null }
  | { kind: "payment_failed" }
  | { kind: "ended"; reason: "cancelled" | "paused" };

export type MembershipOutcome = "applied" | "duplicate" | "unknown_membership" | "already_applied";

export interface MembershipRef {
  tenantId: string;
  provider: string;
  providerSubscriptionId: string;
  /** The provider's event id. Desk renewals make one up from the membership and period. */
  eventId: string;
}

async function locationFor(run: Runner, tenantId: string, patientId: string): Promise<string> {
  const [recent] = await run(sql`select location_id from appointments where tenant_id = ${tenantId} and patient_id = ${patientId} order by starts_at desc limit 1`);
  if (recent) return asString(recent.location_id);
  const [first] = await run(sql`select id from locations where tenant_id = ${tenantId} and is_active order by created_at limit 1`);
  if (!first) throw new Error("The business has no location to book a membership payment against");
  return asString(first.id);
}

/**
 * Applies one subscription event. Two guards stop it acting twice: the provider's event id is unique, and a period is only
 * ever applied once (its credit package has a unique (membership, period start), and an earlier period end is ignored).
 */
export async function applyMembershipEvent(run: Runner, ref: MembershipRef, event: MembershipEvent, now: Date): Promise<MembershipOutcome> {
  const [membership] = await run(sql`
    select m.id, m.patient_id, m.status, m.current_period_end, m.plan_id from customer_memberships m
    where m.tenant_id = ${ref.tenantId} and m.provider = ${ref.provider} and m.provider_subscription_id = ${ref.providerSubscriptionId} for update`);
  if (!membership) return "unknown_membership";
  const membershipId = asString(membership.id);
  const seen = await run(sql`
    insert into membership_events (tenant_id, provider, provider_event_id, type, membership_id)
    values (${ref.tenantId}, ${ref.provider}, ${ref.eventId}, ${event.kind}, ${membershipId})
    on conflict (provider, provider_event_id) do nothing returning id`);
  if (seen.length === 0) return "duplicate";

  if (event.kind === "payment_failed") {
    await run(sql`
      update customer_memberships set status = 'past_due', past_due_since = coalesce(past_due_since, ${now.toISOString()}::timestamptz), updated_at = now()
      where tenant_id = ${ref.tenantId} and id = ${membershipId} and status in ('active', 'past_due')`);
    return "applied";
  }
  if (event.kind === "ended") {
    await run(sql`
      update customer_memberships set status = ${event.reason}, ended_at = case when ${event.reason} = 'cancelled' then ${now.toISOString()}::timestamptz else ended_at end, updated_at = now()
      where tenant_id = ${ref.tenantId} and id = ${membershipId} and status <> 'cancelled'`);
    return "applied";
  }

  // A period that is not later than the one already applied is a repeat, whatever event id it came with.
  if (event.periodEnd <= asDate(membership.current_period_end)) return "already_applied";
  const [plan] = await run(sql`select name, price_minor, credits_per_period, service_ids from membership_plans where tenant_id = ${ref.tenantId} and id = ${asString(membership.plan_id)}`);
  const patientId = asString(membership.patient_id);
  const credits = asNumber(plan?.credits_per_period);
  if (credits > 0) {
    const created = await run(sql`
      insert into customer_packages (tenant_id, patient_id, membership_id, period_start, source, name, credits_total, price_minor, service_ids, bought_at, expires_at)
      values (${ref.tenantId}, ${patientId}, ${membershipId}, ${event.periodStart.toISOString()}::timestamptz, 'membership', ${`${asString(plan?.name)} membership`}, ${credits}, ${event.amountMinor},
        ${textArray(plan?.service_ids as string[])}, ${event.periodStart.toISOString()}::timestamptz, ${event.periodEnd.toISOString()}::timestamptz)
      on conflict (tenant_id, membership_id, period_start) where membership_id is not null do nothing returning id`);
    const packageId = created[0] ? asString(created[0].id) : null;
    if (packageId) {
      await run(sql`
        insert into customer_credits (tenant_id, customer_package_id, "change", kind, reason, dedupe_key)
        values (${ref.tenantId}, ${packageId}, ${credits}, 'renewal', 'Membership renewed', ${`membership:${membershipId}:${event.periodStart.toISOString()}`})
        on conflict do nothing`);
    } else {
      // This period's credits were already given: nothing more to record.
      return "already_applied";
    }
  }
  await run(sql`
    update customer_memberships set status = 'active', past_due_since = null, current_period_end = greatest(current_period_end, ${event.periodEnd.toISOString()}::timestamptz), updated_at = now()
    where tenant_id = ${ref.tenantId} and id = ${membershipId} and status <> 'cancelled'`);
  if (event.amountMinor > 0) {
    const settings = await loadTaxSettings(run, ref.tenantId);
    const locationId = await locationFor(run, ref.tenantId, patientId);
    const [patient] = await run(sql`select first_name, last_name from patients where tenant_id = ${ref.tenantId} and id = ${patientId}`);
    const invoice = await insertInvoice(run, {
      tenantId: ref.tenantId, patientId, locationId, source: "membership", description: `${asString(plan?.name)} membership`, unitPriceMinor: event.amountMinor,
      tax: defaultServiceTax(settings), pricesIncludeTax: settings.pricesIncludeTax, settings,
      buyer: { name: `${asString(patient?.first_name)} ${asString(patient?.last_name)}`.trim() }, issuedByUserId: event.actorUserId ?? null, issuedAt: event.periodStart > now ? now : event.periodStart,
    });
    await run(sql`
      insert into payments (tenant_id, patient_id, location_id, invoice_id, amount_minor, currency, method, recorded_by_user_id)
      values (${ref.tenantId}, ${patientId}, ${locationId}, ${invoice.id}, ${event.amountMinor}, ${invoice.currency}, ${event.method}, ${event.actorUserId ?? null})`);
  }
  return "applied";
}

/** Memberships whose failed renewal ran past 7 days: benefits pause. Credits already granted stay, but cannot be spent while paused. */
export async function pauseLapsedMemberships(run: Runner, tenantId: string, now: Date): Promise<number> {
  const paused = await run(sql`
    update customer_memberships set status = 'paused', updated_at = now()
    where tenant_id = ${tenantId} and status = 'past_due' and past_due_since <= ${new Date(now.getTime() - 7 * 86_400_000).toISOString()}::timestamptz returning id`);
  return paused.length;
}
