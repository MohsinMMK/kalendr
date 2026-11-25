import "server-only";

import { sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { tagColorOf, type CustomerSummary } from "@/lib/customer-contracts";
import { outstandingFor } from "@/server/invoicing/invoice";
import type { StaffContext } from "@/server/staff-context";

import { canSeeMoney, loadVisibleCustomer } from "./access";
import { averageGapDays } from "./stats";

interface FactsRow extends Record<string, unknown> {
  visits: number;
  no_shows: number;
  package_credits: number;
  net_minor: number | null;
  marketing_granted: boolean | null;
}

interface VisitRow extends Record<string, unknown> {
  id: string;
  starts_at: Date | string;
  service_name: string;
}

/**
 * What staff need in the first three seconds: who, when they were last and next here, how often they come and miss,
 * what they owe, what they have left on a package, their tags and the pinned note. Lifetime value and the average gap
 * between visits are worked out here every time and never stored. Money is left out for people who cannot see payments.
 */
export async function loadCustomerSummary(context: StaffContext, patientId: string): Promise<CustomerSummary> {
  return withTenant(context.tenantId, async (transaction) => {
    const customer = await loadVisibleCustomer(transaction, context, patientId);
    const now = new Date();
    const money = canSeeMoney(context);
    const [next] = await transaction.execute<VisitRow>(sql`
      select a.id, a.starts_at, s.name as service_name from appointments as a
      join services as s on s.tenant_id = a.tenant_id and s.id = a.service_id
      where a.tenant_id = ${context.tenantId} and a.patient_id = ${patientId} and a.status in ('requested', 'booked') and a.starts_at > ${now.toISOString()}::timestamptz
      order by a.starts_at asc limit 1
    `);
    const [last] = await transaction.execute<VisitRow>(sql`
      select a.id, a.starts_at, s.name as service_name from appointments as a
      join services as s on s.tenant_id = a.tenant_id and s.id = a.service_id
      where a.tenant_id = ${context.tenantId} and a.patient_id = ${patientId} and a.status = 'completed' and not a.is_sample
      order by a.starts_at desc limit 1
    `);
    const [facts] = await transaction.execute<FactsRow>(sql`
      select
        (select count(*)::int from appointments where tenant_id = ${context.tenantId} and patient_id = ${patientId} and status = 'completed' and not is_test and not is_sample) as visits,
        (select count(*)::int from appointments where tenant_id = ${context.tenantId} and patient_id = ${patientId} and status = 'no_show' and not is_test and not is_sample) as no_shows,
        (select coalesce(sum(credit."change"), 0)::int from customer_credits as credit join customer_packages as package
          on package.tenant_id = credit.tenant_id and package.id = credit.customer_package_id
          where package.tenant_id = ${context.tenantId} and package.patient_id = ${patientId} and package.expires_at > ${now.toISOString()}::timestamptz) as package_credits,
        (select sum(payment.amount_minor) - coalesce(sum((select sum(refund.amount_minor) from payment_refunds as refund where refund.tenant_id = payment.tenant_id and refund.payment_id = payment.id and not refund.is_test)), 0)
          from payments as payment left join appointments as a on a.tenant_id = payment.tenant_id and a.id = payment.appointment_id
          where payment.tenant_id = ${context.tenantId} and coalesce(payment.patient_id, a.patient_id) in (select id from patients where tenant_id = ${context.tenantId} and (id = ${patientId} or merged_into_id = ${patientId})) and not payment.is_test) as net_minor,
        (select consent.granted from consent_records as consent where consent.tenant_id = ${context.tenantId} and consent.patient_id = ${patientId} and consent.purpose = 'marketing_messages'
          order by consent.created_at desc, consent.id desc limit 1) as marketing_granted
    `);
    const visitTimes = await transaction.execute<{ starts_at: Date | string }>(sql`
      select starts_at from appointments where tenant_id = ${context.tenantId} and patient_id = ${patientId} and status = 'completed' and not is_test and not is_sample
      order by starts_at desc limit 200
    `);
    const tags = await transaction.execute<{ id: string; name: string; color: string }>(sql`
      select tag.id, tag.name, tag.color from customer_tag_links as link join customer_tags as tag on tag.tenant_id = link.tenant_id and tag.id = link.tag_id
      where link.tenant_id = ${context.tenantId} and link.patient_id = ${patientId} order by lower(tag.name)
    `);
    const [pinned] = await transaction.execute<{ id: string; body: string; author_name: string; updated_at: Date | string }>(sql`
      select id, body, author_name, updated_at from customer_notes where tenant_id = ${context.tenantId} and patient_id = ${patientId} and pinned order by updated_at desc limit 1
    `);
    const [blocker] = customer.blockedAt ? await transaction.execute<{ reason: string | null; by_name: string | null }>(sql`
      select p.block_reason as reason, u.name as by_name from patients as p left join auth_users as u on u.id = p.blocked_by_user_id
      where p.tenant_id = ${context.tenantId} and p.id = ${patientId}
    `) : [];
    const [merge] = await transaction.execute<{ id: string; undo_until: Date | string }>(sql`
      select id, undo_until from customer_merges
      where tenant_id = ${context.tenantId} and kept_patient_id = ${patientId} and undone_at is null and undo_until > ${now.toISOString()}::timestamptz and snapshot_ciphertext is not null
      order by merged_at desc limit 1
    `);
    // Invoices are never edited either, so what a merged-in profile owes still sits on it.
    const family = await transaction.execute<{ id: string }>(sql`select id from patients where tenant_id = ${context.tenantId} and (id = ${patientId} or merged_into_id = ${patientId})`);
    let dueMinor = 0;
    if (money) for (const member of family) dueMinor += (await outstandingFor(transaction, context.tenantId, member.id, context)).dueMinor;
    const owed = money ? { dueMinor } : null;
    const [tenant] = await transaction.execute<{ currency: string }>(sql`select currency from tenants where id = ${context.tenantId}`);

    const asVisit = (row: VisitRow | undefined) => (row ? { id: row.id, startsAt: new Date(row.starts_at).toISOString(), serviceName: row.service_name } : null);
    return {
      id: customer.id,
      name: `${customer.firstName} ${customer.lastName}`.trim(),
      phone: customer.phone,
      email: customer.email,
      nextVisit: asVisit(next),
      lastVisit: asVisit(last),
      visits: Number(facts?.visits ?? 0),
      noShows: Number(facts?.no_shows ?? 0),
      balanceOwedMinor: owed ? owed.dueMinor : null,
      lifetimeValueMinor: money ? Number(facts?.net_minor ?? 0) : null,
      currency: tenant?.currency ?? "INR",
      averageGapDays: averageGapDays(visitTimes.map((row) => new Date(row.starts_at))),
      packageCredits: Math.max(0, Number(facts?.package_credits ?? 0)),
      tags: tags.map((tag) => ({ id: tag.id, name: tag.name, color: tagColorOf(tag.color) })),
      pinnedNote: pinned ? { id: pinned.id, body: pinned.body, authorName: pinned.author_name, updatedAt: new Date(pinned.updated_at).toISOString() } : null,
      blocked: customer.blockedAt ? { at: customer.blockedAt.toISOString(), reason: blocker?.reason ?? "", byName: blocker?.by_name ?? null } : null,
      marketingConsent: facts?.marketing_granted === true,
      recentMerge: merge ? { id: merge.id, undoUntil: new Date(merge.undo_until).toISOString() } : null,
    };
  });
}
