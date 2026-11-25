/**
 * Crediting bookings to campaigns, and the numbers on a campaign's page (feature 28).
 *
 * Every campaign message links to the booking page with the campaign's code as utm_campaign, which the booking already
 * records. A booking made within 7 days of the message, by that customer, through that link is credited to the campaign.
 * "That customer" also matches a booking made under a new customer record with the same email or phone, because the
 * booking page only reuses a record when name, email and phone all match.
 *
 * No "server-only": the worker credits bookings every minute.
 */
import { sql } from "drizzle-orm";

import { ATTRIBUTION_DAYS, type CampaignStats } from "../../lib/campaign-contracts";
import { asNumber, asString, type Runner } from "../workflows/runner";

const ENDED = ["cancelled", "declined", "expired", "entered_in_error"];

/** Credits each sent message with its first qualifying booking. Safe to run any number of times. */
export async function attributeBookings(run: Runner, tenantId: string, now: Date = new Date()): Promise<number> {
  const credited = await run(sql`
    update campaign_sends as send set booked_appointment_id = found.appointment_id, booked_at = found.created_at, updated_at = now()
    from (
      select distinct on (candidate.id) candidate.id as send_id, appointment.id as appointment_id, appointment.created_at
      from campaign_sends as candidate
      join campaigns as campaign on campaign.tenant_id = candidate.tenant_id and campaign.id = candidate.campaign_id
      join patients as recipient on recipient.tenant_id = candidate.tenant_id and recipient.id = candidate.patient_id
      join appointments as appointment on appointment.tenant_id = candidate.tenant_id and appointment.utm_campaign = campaign.code
      join patients as booker on booker.tenant_id = appointment.tenant_id and booker.id = appointment.patient_id
      where candidate.tenant_id = ${tenantId} and candidate.status = 'sent' and candidate.booked_appointment_id is null
        and candidate.sent_at > ${new Date(now.getTime() - 60 * 86_400_000).toISOString()}::timestamptz
        and appointment.created_at >= candidate.sent_at
        and appointment.created_at <= candidate.sent_at + make_interval(days => ${ATTRIBUTION_DAYS})
        and appointment.status not in (${sql.join(ENDED.map((status) => sql`${status}`), sql`, `)})
        and not appointment.is_test and not appointment.is_sample
        and (booker.id = recipient.id
          or (recipient.email like '%@%' and lower(booker.email) = lower(recipient.email))
          or (kalendr_normalize_phone(recipient.phone) <> '' and kalendr_normalize_phone(booker.phone) = kalendr_normalize_phone(recipient.phone)))
      order by candidate.id, appointment.created_at
    ) as found
    where send.tenant_id = ${tenantId} and send.id = found.send_id and send.booked_appointment_id is null
    returning send.id
  `);
  return credited.length;
}

const empty = (currency: string): CampaignStats => ({ planned: 0, sent: 0, delivered: 0, failed: 0, skipped: 0, booked: 0, unsubscribed: 0, revenueMinor: 0, currency });

/** Sent, delivered, booked, revenue and unsubscribed for each campaign (or one). Revenue is money received net of refunds. */
export async function campaignStats(run: Runner, tenantId: string, campaignId?: string): Promise<{ get(campaignId: string): CampaignStats }> {
  const [tenant] = await run(sql`select currency from tenants where id = ${tenantId}`);
  const currency = asString(tenant?.currency) || "INR";
  const rows = await run(sql`
    select send.campaign_id,
      count(*)::int as planned,
      count(*) filter (where send.status = 'sent')::int as sent,
      count(*) filter (where send.status = 'sent' and exists (
        select 1 from notifications as note
        where note.tenant_id = send.tenant_id and note.semantic_key in (send.channel || ':' || send.id, 'local:campaign:' || send.id) and note.status = 'delivered'
      ))::int as delivered,
      count(*) filter (where send.status = 'failed')::int as failed,
      count(*) filter (where send.status = 'skipped')::int as skipped,
      count(*) filter (where send.booked_appointment_id is not null)::int as booked,
      count(*) filter (where send.unsubscribed_at is not null)::int as unsubscribed,
      coalesce(sum((
        select coalesce(sum(payment.amount_minor), 0) - coalesce(sum((select sum(refund.amount_minor) from payment_refunds as refund where refund.tenant_id = payment.tenant_id and refund.payment_id = payment.id and not refund.is_test)), 0)
        from payments as payment where payment.tenant_id = send.tenant_id and payment.appointment_id = send.booked_appointment_id and not payment.is_test
      )), 0)::bigint as revenue_minor
    from campaign_sends as send
    where send.tenant_id = ${tenantId} ${campaignId ? sql`and send.campaign_id = ${campaignId}` : sql``}
    group by send.campaign_id
  `);
  const stats = new Map<string, CampaignStats>();
  for (const row of rows) {
    stats.set(asString(row.campaign_id), {
      planned: asNumber(row.planned), sent: asNumber(row.sent), delivered: asNumber(row.delivered), failed: asNumber(row.failed),
      skipped: asNumber(row.skipped), booked: asNumber(row.booked), unsubscribed: asNumber(row.unsubscribed), revenueMinor: asNumber(row.revenue_minor), currency,
    });
  }
  return { get: (id) => stats.get(id) ?? empty(currency) };
}
