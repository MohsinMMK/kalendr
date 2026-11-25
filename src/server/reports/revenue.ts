import { sql } from "drizzle-orm";

import { ApiError } from "../api-error";
import type { ReportResult, ReportTable } from "../../lib/reports";
import { appointmentWhere, bookingsHref, loadCurrency, num, PAYMENT_FROM, paymentWhere, rangeOf, type ReportContext } from "./common";

const METHODS: Record<string, string> = { cash: "Cash", upi: "UPI", card: "Card", bank: "Bank transfer", other: "Other" };

/**
 * Money in, money back, and money still owed. Payments and refunds are rows that are never edited; this adds them up and keeps
 * refunds on their own line instead of netting them into the payments. Needs `reports.revenue`.
 */
export async function revenueReport(context: ReportContext): Promise<ReportResult> {
  const { run, scope } = context;
  if (!scope.canSeeRevenue) throw new ApiError(403, "forbidden", "You don't have permission to see revenue.");
  const range = rangeOf(context.params);
  const where = paymentWhere(scope, range);
  const [paid] = await run(sql`select coalesce(sum(p.amount_minor), 0) as total, count(*) as count from ${PAYMENT_FROM} where ${where}`);
  const refundWhere = paymentWhere(scope, range, sql`r.created_at`);
  const refundFrom = sql`payment_refunds r
    join payments p on p.tenant_id = r.tenant_id and p.id = r.payment_id
    left join appointments a on a.tenant_id = p.tenant_id and a.id = p.appointment_id
    join locations l on l.tenant_id = p.tenant_id and l.id = coalesce(a.location_id, p.location_id)`;
  const [refunded] = await run(sql`select coalesce(sum(r.amount_minor), 0) as total from ${refundFrom} where ${refundWhere} and not r.is_test`);
  const byDay = await run(sql`select to_char(p.created_at at time zone l.timezone, 'YYYY-MM-DD') as day, sum(p.amount_minor) as total from ${PAYMENT_FROM} where ${where} group by 1 order by 1`);
  const byService = await run(sql`
    select coalesce(s.name, 'Other sales') as name, sum(p.amount_minor) as total, count(*) as count
    from ${PAYMENT_FROM} left join services s on s.tenant_id = a.tenant_id and s.id = a.service_id
    where ${where} group by 1 order by total desc, 1`);
  const byStaff = await run(sql`
    select coalesce(pr.name, 'Other sales') as name, sum(p.amount_minor) as total, count(*) as count
    from ${PAYMENT_FROM} left join practitioners pr on pr.tenant_id = a.tenant_id and pr.id = a.practitioner_id
    where ${where} group by 1 order by total desc, 1`);
  const byMethod = await run(sql`select p.method::text as method, sum(p.amount_minor) as total, count(*) as count from ${PAYMENT_FROM} where ${where} group by 1 order by total desc`);
  // Owed: what the visit costs less what was paid and given back, for visits in the range that happened and are not yet paid up.
  const [owed] = await run(sql`
    select coalesce(sum(greatest(a.price_minor - coalesce(paid.total, 0) + coalesce(back.total, 0), 0)), 0) as total, count(*) filter (where a.price_minor - coalesce(paid.total, 0) + coalesce(back.total, 0) > 0) as visits
    from appointments a join locations l on l.tenant_id = a.tenant_id and l.id = a.location_id
    left join lateral (select sum(p.amount_minor) as total from payments p where p.tenant_id = a.tenant_id and p.appointment_id = a.id and not p.is_test) paid on true
    left join lateral (select sum(r.amount_minor) as total from payment_refunds r join payments p on p.tenant_id = r.tenant_id and p.id = r.payment_id where p.tenant_id = a.tenant_id and p.appointment_id = a.id and not r.is_test) back on true
    where ${appointmentWhere(scope, range)} and a.status in ('completed', 'checked_in') and a.price_minor > 0`);

  const gross = num(paid?.total);
  const back = num(refunded?.total);
  const table = (key: string, title: string, label: string, rows: typeof byService, labelOf: (value: string) => string = (value) => value): ReportTable => ({
    key, title, columns: [{ key: "name", label }, { key: "count", label: "Payments", format: "count" }, { key: "total", label: "Received", format: "money" }],
    rows: rows.map((row) => ({ name: labelOf(String(row.name ?? row.method)), count: num(row.count), total: num(row.total) })),
  });
  return {
    report: "revenue", range, currency: await loadCurrency(run, scope.tenantId), scopedToPerson: Boolean(scope.practitionerId),
    metrics: [
      { key: "received", label: "Received", value: gross, format: "money", formula: "Received: payments taken in the period, before refunds. Test payments are left out." },
      { key: "refunds", label: "Refunds", value: back, format: "money", formula: "Refunds: money given back in the period. Shown on its own line, never taken out of the payments." },
      { key: "net", label: "Net revenue", value: gross - back, format: "money", formula: "Net revenue: received less refunds." },
      { key: "outstanding", label: "Outstanding", value: num(owed?.total), format: "money", formula: "Outstanding: price of visits in the period that are checked in or completed, less what was paid and not refunded.", href: bookingsHref(context, "past") },
    ],
    charts: [{ key: "by_day", title: "Received by day", kind: "bar", xKey: "day", series: [{ key: "total", label: "Received", format: "money" }], rows: byDay.map((row) => ({ day: String(row.day), total: num(row.total) })) }],
    tables: [table("by_service", "By service", "Service", byService), table("by_staff", "By staff member", "Staff member", byStaff), table("by_method", "By payment method", "Method", byMethod, (value) => METHODS[value] ?? value)],
  };
}
