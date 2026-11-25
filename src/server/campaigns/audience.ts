/**
 * Who a campaign goes to (feature 28), in one place: the web app counts it for the owner, the worker's fan-out writes it,
 * and the send re-checks it one customer at a time. All three read the same rules, so what the owner is told is what happens.
 *
 * A customer is first picked by the campaign's rule or segment (the pool), then each one is given the first reason they
 * must be left out, or none. The order of the reasons is the order the owner reads them in the "left out" list.
 *
 * No "server-only": the worker uses this file.
 */
import { sql, type SQL } from "drizzle-orm";

import { CATCH_UP_DAYS, MARKETING_GAP_DAYS, leftOutReasons, type CampaignChannel, type CampaignKind, type CampaignRule, type LeftOutReason } from "../../lib/campaign-contracts";
import type { SegmentFilter } from "../../lib/segment-filter";
import { compileSegment } from "../customers/segment-sql";
import type { Row, Runner } from "../workflows/runner";
import { asString } from "../workflows/runner";

export interface AudienceCampaign {
  /** Empty while the owner is still building it. */
  id: string | null;
  kind: CampaignKind;
  channel: CampaignChannel;
  rule: CampaignRule | null;
  segmentFilter: SegmentFilter | null;
  serviceId: string | null;
}

export interface AudienceContext {
  tenantId: string;
  now: Date;
  /** The business's time zone: a birthday is "today" where the customer lives. */
  timeZone: string;
}

const DAY_MS = 86_400_000;

/** The business-local calendar day, as YYYY-MM-DD. */
export function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Month and day of "today" for birthdays. In a year with no 29 February, that birthday is greeted on the 28th. */
export function birthdayKey(at: Date, timeZone: string): { month: number; day: number; includeLeapDay: boolean; year: string } {
  const [year = "1970", month = "01", day = "01"] = localDay(at, timeZone).split("-");
  const y = Number(year);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return { month: Number(month), day: Number(day), includeLeapDay: !leap && Number(month) === 2 && Number(day) === 28, year };
}

const iso = (date: Date) => date.toISOString();

function futureScope(campaign: AudienceCampaign): { kind: "none" } | { kind: "any" } | { kind: "services"; ids: string[] } {
  const rule = campaign.rule;
  if (rule?.type === "recall") return { kind: "services", ids: rule.services.map((entry) => entry.serviceId) };
  if (rule?.type === "birthday") return { kind: "none" };
  if (rule) return { kind: "any" };
  return campaign.serviceId ? { kind: "services", ids: [campaign.serviceId] } : { kind: "none" };
}

/** The customers a campaign's rule or segment picks, as `patient_id, cycle` rows. Nothing about consent yet. */
export function poolSql(campaign: AudienceCampaign, context: AudienceContext): SQL {
  const base = { tenantId: context.tenantId, now: context.now };
  const rule = campaign.rule;
  if (!rule) {
    const { prefix, from } = compileSegment(campaign.segmentFilter ?? { all: [] }, base);
    return sql`${prefix} select p.id as patient_id, ''::text as cycle ${from}`;
  }
  const ago = (days: number) => sql`(${iso(context.now)}::timestamptz - make_interval(days => ${days}))`;
  switch (rule.type) {
    case "recall": {
      // Due once the interval has passed since their last visit for the service, and for a month after: each customer is caught once as they qualify.
      const due = rule.services.map((entry) => sql`(last_visit.service_id = ${entry.serviceId}
        and last_visit.at <= ${ago(entry.intervalDays)} and last_visit.at > ${ago(entry.intervalDays + CATCH_UP_DAYS)})`);
      const { prefix, from } = compileSegment({ all: [] }, base, sql`exists (
        select 1 from (
          select visit.service_id, max(visit.starts_at) as at from appointments as visit
          where visit.tenant_id = p.tenant_id and visit.patient_id = p.id and visit.status = 'completed' and not visit.is_test and not visit.is_sample
            and visit.service_id in (${sql.join(rule.services.map((entry) => sql`${entry.serviceId}`), sql`, `)})
          group by visit.service_id
        ) as last_visit where ${sql.join(due, sql` or `)}
      )`);
      return sql`${prefix} select p.id as patient_id, ''::text as cycle ${from}`;
    }
    case "birthday": {
      const key = birthdayKey(context.now, context.timeZone);
      const { prefix, from } = compileSegment({ all: [] }, base, sql`p.date_of_birth is not null and (
        (extract(month from p.date_of_birth) = ${key.month} and extract(day from p.date_of_birth) = ${key.day})
        ${key.includeLeapDay ? sql`or (extract(month from p.date_of_birth) = 2 and extract(day from p.date_of_birth) = 29)` : sql``}
      )`);
      return sql`${prefix} select p.id as patient_id, ${key.year}::text as cycle ${from}`;
    }
    case "win_back": {
      const { prefix, from } = compileSegment({ all: [] }, base, sql`(
        select max(visit.starts_at) from appointments as visit
        where visit.tenant_id = p.tenant_id and visit.patient_id = p.id and visit.status = 'completed' and not visit.is_test and not visit.is_sample
      ) between ${ago(rule.daysAway + CATCH_UP_DAYS)} and ${ago(rule.daysAway)}`);
      return sql`${prefix} select p.id as patient_id, ''::text as cycle ${from}`;
    }
    case "routing_abandoned": {
      const agoHours = (hours: number) => sql`(${iso(context.now)}::timestamptz - make_interval(hours => ${hours}))`;
      // Answered a routing form that sent them to book (feature 46), matched to this customer by an email they gave, and has not booked since.
      // Each response is its own cycle, so one unbooked answer is followed up once. The window is three days wide, like a recall's catch-up.
      const { prefix, from } = compileSegment({ all: [] }, base, sql`response.destination_type = 'service' and response.booked_at is null
        and response.answered_at <= ${agoHours(rule.hoursAfter)} and response.answered_at > ${agoHours(rule.hoursAfter + 72)}
        and not exists (select 1 from appointments as later where later.tenant_id = p.tenant_id and later.patient_id = p.id and later.created_at >= response.answered_at and not later.is_test and not later.is_sample)`,
      sql`join routing_responses as response on response.tenant_id = p.tenant_id and response.patient_id = p.id`);
      return sql`${prefix} select p.id as patient_id, response.id::text as cycle ${from}`;
    }
    case "package_expiring": {
      const { prefix, from } = compileSegment({ all: [] }, base, sql`package.expires_at > ${iso(context.now)}::timestamptz
        and package.expires_at <= ${iso(new Date(context.now.getTime() + rule.daysBefore * DAY_MS))}::timestamptz
        and (select coalesce(sum(credit."change"), 0) from customer_credits as credit where credit.tenant_id = package.tenant_id and credit.customer_package_id = package.id) > 0`,
      sql`join customer_packages as package on package.tenant_id = p.tenant_id and package.patient_id = p.id`);
      return sql`${prefix} select p.id as patient_id, package.id::text as cycle ${from}`;
    }
  }
}

/**
 * Gives every customer in `pool` the first reason to leave them out, or null when they may be sent to. `campaignId` lets
 * the "already sent" and "recent message" checks ignore this campaign's own row; `checkAlreadySent` is off when a send
 * re-checks itself, because its own row is, of course, already there.
 */
export function classifySql(pool: SQL, campaign: AudienceCampaign, context: AudienceContext, options: { checkAlreadySent: boolean }): SQL {
  const now = sql`${iso(context.now)}::timestamptz`;
  const scope = futureScope(campaign);
  const futureBooking = scope.kind === "none" ? sql`false` : sql`exists (
    select 1 from appointments as upcoming
    where upcoming.tenant_id = p.tenant_id and upcoming.patient_id = p.id and upcoming.status in ('requested', 'booked') and upcoming.starts_at > ${now}
      ${scope.kind === "services" ? sql`and upcoming.service_id in (${sql.join(scope.ids.map((id) => sql`${id}`), sql`, `)})` : sql``}
  )`;
  const channel = campaign.channel;
  const channelAgreed = channel === "email"
    ? sql`coalesce((select preference.opted_in from marketing_preferences as preference where preference.tenant_id = p.tenant_id and preference.patient_id = p.id and preference.channel = 'email'), true)`
    : sql`coalesce((select preference.opted_in from marketing_preferences as preference where preference.tenant_id = p.tenant_id and preference.patient_id = p.id and preference.channel = ${channel}), p.messaging_consent_at is not null)`;
  const hasContact = channel === "email"
    ? sql`(p.email like '%@%' and p.email not like '%.invalid')`
    : sql`(length(regexp_replace(p.phone, '\\D', '', 'g')) >= 8)`;
  const campaignId = campaign.id ?? "";
  return sql`
    with pool as (${pool})
    select pool.patient_id, pool.cycle,
      case
        when p.blocked_at is not null or p.erased_at is not null or p.merged_into_id is not null then 'blocked'
        when p.is_dependent or (p.date_of_birth is not null and p.date_of_birth > (${now}::date - interval '18 years')) then 'under_18'
        when not coalesce((
          select consent.granted from consent_records as consent
          where consent.tenant_id = p.tenant_id and consent.patient_id = p.id and consent.purpose = 'marketing_messages'
          order by consent.created_at desc, consent.id desc limit 1
        ), false) then 'no_marketing_consent'
        when not ${channelAgreed} then 'channel_not_agreed'
        when not ${hasContact} then 'no_contact'
        when ${futureBooking} then 'future_booking'
        when exists (
          select 1 from campaign_sends as recent
          where recent.tenant_id = p.tenant_id and recent.patient_id = p.id and recent.status in ('queued', 'sent')
            and coalesce(recent.sent_at, recent.updated_at) > ${now} - make_interval(days => ${MARKETING_GAP_DAYS})
            and not (recent.campaign_id = ${campaignId} and recent.cycle = pool.cycle)
        ) then 'recent_message'
        ${options.checkAlreadySent ? sql`when exists (
          select 1 from campaign_sends as earlier
          where earlier.tenant_id = p.tenant_id and earlier.campaign_id = ${campaignId} and earlier.patient_id = p.id and earlier.cycle = pool.cycle
        ) then 'already_sent'` : sql``}
        else null
      end as reason
    from pool join patients as p on p.tenant_id = ${context.tenantId} and p.id = pool.patient_id
  `;
}

export interface AudienceMember {
  patientId: string;
  cycle: string;
}

export interface AudienceResult {
  /** Everyone the rule or segment picks, before consent and limits. */
  matching: number;
  eligibleCount: number;
  /** Who would get it, up to the limit asked for. */
  eligible: AudienceMember[];
  leftOut: Record<LeftOutReason, number>;
}

function isLeftOutReason(value: string): value is LeftOutReason {
  return leftOutReasons.some((reason) => reason === value);
}

export function summarise(rows: Row[], limit?: number): AudienceResult {
  const leftOut: Record<LeftOutReason, number> = {
    blocked: 0, under_18: 0, no_marketing_consent: 0, channel_not_agreed: 0, no_contact: 0, future_booking: 0, recent_message: 0, already_sent: 0,
  };
  const eligible: AudienceMember[] = [];
  let eligibleCount = 0;
  for (const row of rows) {
    const reason = row.reason === null || row.reason === undefined ? null : asString(row.reason);
    if (reason === null) {
      eligibleCount += 1;
      if (limit === undefined || eligible.length < limit) eligible.push({ patientId: asString(row.patient_id), cycle: asString(row.cycle) });
    } else if (isLeftOutReason(reason)) {
      leftOut[reason] += 1;
    }
  }
  return { matching: rows.length, eligibleCount, eligible, leftOut };
}

/** The whole audience, with how many were left out and why. `limit` caps the eligible list (the counts are still complete). */
export async function loadAudience(run: Runner, campaign: AudienceCampaign, context: AudienceContext, options: { limit?: number } = {}): Promise<AudienceResult> {
  const rows = await run(sql`select classified.patient_id, classified.cycle, classified.reason from (${classifySql(poolSql(campaign, context), campaign, context, { checkAlreadySent: true })}) as classified order by classified.patient_id, classified.cycle`);
  return summarise(rows, options.limit);
}

/** Re-checks one customer at the moment of sending. Returns the reason to skip, or null when it may go. */
export async function recheckSend(run: Runner, campaign: AudienceCampaign, context: AudienceContext, member: AudienceMember): Promise<LeftOutReason | null> {
  const pool = sql`select ${member.patientId}::text as patient_id, ${member.cycle}::text as cycle`;
  const [row] = await run(classifySql(pool, campaign, context, { checkAlreadySent: false }));
  if (!row) return "blocked";
  const reason = row.reason === null || row.reason === undefined ? null : asString(row.reason);
  return reason !== null && isLeftOutReason(reason) ? reason : null;
}
