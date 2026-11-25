/**
 * Turns a validated segment filter into one parameterised query (feature 27). The filter's values only ever reach
 * the database as bound parameters; the one piece of text that is not a parameter (the comparison operator) comes
 * from a fixed map, never from the filter. Nothing in this file builds SQL by joining strings from input.
 *
 * Shared by the segment screens and by campaigns (feature 28), so "who is in this segment" has one definition.
 * No "server-only": the worker's campaign fan-out uses it too.
 */
import { sql, type SQL } from "drizzle-orm";

import { segmentFilterSchema, type SegmentCondition, type SegmentFilter } from "../../lib/segment-filter";

export interface SegmentContext {
  tenantId: string;
  now: Date;
}

export interface CompiledSegment {
  /** Zero or one WITH clause holding the aggregates the conditions need (visits, spend). */
  prefix: SQL;
  /** `from patients as p ... where ...`. The patient row is always aliased `p`. */
  from: SQL;
}

const operators = { gt: ">", gte: ">=", lt: "<", lte: "<=", eq: "=" } as const;

function compare(left: SQL, op: keyof typeof operators, right: number): SQL {
  return sql`${left} ${sql.raw(operators[op])} ${right}`;
}

function inList(values: readonly string[]): SQL {
  return sql.join(values.map((value) => sql`${value}`), sql`, `);
}

function isoDate(date: string): SQL {
  return sql`${date}::date`;
}

/** The latest completed visit, per customer. A test booking or an onboarding sample never counts. */
function visitStats(tenantId: string): SQL {
  return sql`visit_stats as (
    select appointment.patient_id, count(*)::int as visit_count, max(appointment.starts_at) as last_visit
    from appointments as appointment
    where appointment.tenant_id = ${tenantId} and appointment.status = 'completed' and not appointment.is_test and not appointment.is_sample
    group by appointment.patient_id
  )`;
}

/**
 * Money received from each customer, net of refunds. A payment belongs to a customer directly (a package sale) or
 * through its visit. Test-mode money is left out, as it is from every other total.
 */
function spendStats(tenantId: string): SQL {
  return sql`spend_stats as (
    select coalesce(owner.merged_into_id, owner.id) as patient_id,
      sum(payment.amount_minor) - coalesce(sum(refunds.amount), 0) as net_minor
    from payments as payment
    left join appointments as appointment on appointment.tenant_id = payment.tenant_id and appointment.id = payment.appointment_id
    join patients as owner on owner.tenant_id = payment.tenant_id and owner.id = coalesce(payment.patient_id, appointment.patient_id)
    left join lateral (
      select sum(refund.amount_minor) as amount from payment_refunds as refund
      where refund.tenant_id = payment.tenant_id and refund.payment_id = payment.id and not refund.is_test
    ) as refunds on true
    where payment.tenant_id = ${tenantId} and not payment.is_test
    group by 1
  )`;
}

function conditionSql(condition: SegmentCondition, context: SegmentContext): SQL {
  const dayAgo = (days: number) => sql`(${context.now.toISOString()}::timestamptz - make_interval(days => ${days}))`;
  switch (condition.field) {
    case "lastVisit":
      switch (condition.op) {
        case "olderThanDays": return sql`visit_stats.last_visit < ${dayAgo(condition.days ?? 0)}`;
        case "withinDays": return sql`visit_stats.last_visit >= ${dayAgo(condition.days ?? 0)}`;
        case "before": return sql`visit_stats.last_visit < ${isoDate(condition.date ?? "1970-01-01")}`;
        case "after": return sql`visit_stats.last_visit >= ${isoDate(condition.date ?? "1970-01-01")}`;
        case "never": return sql`visit_stats.last_visit is null`;
      }
      break;
    case "visits":
      return compare(sql`coalesce(visit_stats.visit_count, 0)`, condition.op, condition.value);
    case "service": {
      const used = sql`exists (
        select 1 from appointments as used
        where used.tenant_id = p.tenant_id and used.patient_id = p.id and used.status = 'completed'
          and not used.is_test and not used.is_sample and used.service_id in (${inList(condition.serviceIds)})
      )`;
      return condition.op === "used" ? used : sql`not ${used}`;
    }
    case "tag": {
      const has = sql`exists (
        select 1 from customer_tag_links as link
        where link.tenant_id = p.tenant_id and link.patient_id = p.id and link.tag_id in (${inList(condition.tagIds)})
      )`;
      return condition.op === "has" ? has : sql`not ${has}`;
    }
    case "spend":
      return compare(sql`coalesce(spend_stats.net_minor, 0)`, condition.op, condition.valueMinor);
    case "futureBooking": {
      const upcoming = sql`exists (
        select 1 from appointments as upcoming
        where upcoming.tenant_id = p.tenant_id and upcoming.patient_id = p.id
          and upcoming.status in ('requested', 'booked') and upcoming.starts_at > ${context.now.toISOString()}::timestamptz
      )`;
      return condition.value ? upcoming : sql`not ${upcoming}`;
    }
    case "birthdayMonth":
      return sql`extract(month from p.date_of_birth) = ${condition.month}`;
    case "marketingConsent": {
      const granted = sql`coalesce((
        select consent.granted from consent_records as consent
        where consent.tenant_id = p.tenant_id and consent.patient_id = p.id and consent.purpose = 'marketing_messages'
        order by consent.created_at desc, consent.id desc limit 1
      ), false)`;
      return condition.value ? granted : sql`not ${granted}`;
    }
  }
  return sql`true`;
}

/**
 * The customers a filter selects. A customer who was merged into another, erased, or made by onboarding as a sample
 * is never part of any segment. `extraWhere` and `extraJoin` let a caller (a campaign's audience) narrow it further in the same query.
 */
export function compileSegment(filter: SegmentFilter, context: SegmentContext, extraWhere?: SQL, extraJoin?: SQL): CompiledSegment {
  const parsed = segmentFilterSchema.parse(filter);
  const needsVisits = parsed.all.some((condition) => condition.field === "lastVisit" || condition.field === "visits");
  const needsSpend = parsed.all.some((condition) => condition.field === "spend");
  const ctes = [needsVisits ? visitStats(context.tenantId) : null, needsSpend ? spendStats(context.tenantId) : null].filter((part): part is SQL => part !== null);
  const joins = [
    needsVisits ? sql`left join visit_stats on visit_stats.patient_id = p.id` : null,
    needsSpend ? sql`left join spend_stats on spend_stats.patient_id = p.id` : null,
    extraJoin ?? null,
  ].filter((part): part is SQL => part !== null);
  const conditions = [
    sql`p.tenant_id = ${context.tenantId}`,
    sql`p.merged_into_id is null`,
    sql`p.erased_at is null`,
    sql`not p.is_test`,
    ...parsed.all.map((condition) => conditionSql(condition, context)),
    ...(extraWhere ? [extraWhere] : []),
  ];
  return {
    prefix: ctes.length > 0 ? sql`with ${sql.join(ctes, sql`, `)}` : sql``,
    from: sql`from patients as p ${sql.join(joins, sql` `)} where ${sql.join(conditions, sql` and `)}`,
  };
}

export function countSegmentSql(filter: SegmentFilter, context: SegmentContext): SQL {
  const { prefix, from } = compileSegment(filter, context);
  return sql`${prefix} select count(*)::int as count ${from}`;
}
