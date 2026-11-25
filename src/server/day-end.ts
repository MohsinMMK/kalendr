import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { withTenant, type KalendrTransaction as TenantTransaction } from "@/db/client";
import { auditEvents, dayCloses, tenants } from "@/db/schema";
import { MAX_PAYMENT_MINOR } from "@/lib/money";

import { ApiError } from "./api-error";
import { andLocation, assertLocationAllowed } from "./location-scope";
import { canonicalJsonHash } from "./crypto";
import { claimKey, finishKey } from "./idempotent";
import { ledgerMethods, type PaymentMethod } from "./payments";
import { isPreviewMode } from "./preview-repository";
import { requirePermission, type StaffContext } from "./staff-context";

const daySchema = z.iso.date();
const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export const dayEndQuerySchema = z.strictObject({
  day: daySchema.optional(),
  locationId: idSchema.optional(),
});

export const closeDayInputSchema = z.strictObject({
  day: daySchema,
  locationId: idSchema.optional(),
  /** What the desk counted in the cash drawer. */
  cashCountedMinor: z.number().int().min(0).max(MAX_PAYMENT_MINOR),
  note: z.string().trim().max(300).optional(),
});

export interface DaySummary {
  day: string;
  locationId: string;
  locationName: string;
  currency: string;
  visits: {
    /** Booked for the day, leaving out requests never confirmed and entries made in error. */
    total: number;
    seen: number;
    noShows: number;
    /** Checked in, then left before being seen. */
    left: number;
    cancelled: number;
    /** Still booked or waiting: not seen, not marked a no-show. */
    open: number;
    walkIns: number;
    avgWaitMinutes: number | null;
    avgVisitMinutes: number | null;
  };
  money: {
    byMethod: Record<PaymentMethod, number>;
    takenMinor: number;
    refundedMinor: number;
    netMinor: number;
    /** Cash taken less cash given back: what should be in the drawer. */
    cashExpectedMinor: number;
    /** Still due on the day's visits. */
    owedMinor: number;
    owedCount: number;
  };
}

export interface DayCloseView {
  at: string;
  byName: string;
  cashCountedMinor: number;
  cashExpectedMinor: number;
  note: string | null;
  /** The day as it stood at closing. */
  summary: DaySummary;
}

export interface DayEnd {
  /** Today where this location is, so the screen knows which days can be closed. */
  today: string;
  /** The day as it stands now. */
  summary: DaySummary;
  close: DayCloseView | null;
  /** Money or visits moved after the day was closed, such as a late refund. */
  changedSinceClose: boolean;
}

const CLOSE_ROUTE = "staff.day_end.close";

function refusePreview(context: StaffContext): void {
  if (context.preview || isPreviewMode()) throw new ApiError(409, "preview_only", "Closing the day needs the real database. The preview keeps no money.");
}

type Location = { id: string; name: string; timezone: string; today: string };

/** The named location, or the first one this person may use. A limited person naming another branch is refused (403). */
async function findLocation(transaction: TenantTransaction, context: StaffContext, locationId?: string): Promise<Location> {
  assertLocationAllowed(context, locationId);
  const tenantId = context.tenantId;
  const [row] = await transaction.execute<Location>(sql`
    select id, name, timezone, (now() at time zone timezone)::date::text as today
    from locations
    where tenant_id = ${tenantId} ${locationId ? sql`and id = ${locationId}` : sql``} ${andLocation(context, sql`id`)}
    order by created_at asc
    limit 1
  `);
  if (!row) throw new ApiError(404, "location_not_found", "That location could not be found.");
  return row;
}

const count = (value: unknown): number => Number(value ?? 0);
const minutes = (seconds: unknown): number | null => (seconds === null || seconds === undefined ? null : Math.round(Number(seconds) / 60));

/** Visits and money for one location on one local day. Days start and end at local midnight. */
async function summarise(transaction: TenantTransaction, tenantId: string, location: Location, day: string): Promise<DaySummary> {
  const start = sql`(${day}::date::timestamp at time zone ${location.timezone})`;
  const end = sql`((${day}::date + 1)::timestamp at time zone ${location.timezone})`;
  const [tenant] = await transaction.select({ currency: tenants.currency }).from(tenants).where(eq(tenants.id, tenantId));

  const [visits] = await transaction.execute(sql`
    select
      count(*) filter (where status not in ('requested', 'entered_in_error', 'pending_payment', 'expired')) as total,
      count(*) filter (where status = 'completed') as seen,
      count(*) filter (where status = 'no_show') as no_shows,
      count(*) filter (where status = 'cancelled' and checked_in_at is not null) as left_unseen,
      count(*) filter (where status = 'cancelled' and checked_in_at is null) as cancelled,
      count(*) filter (where status in ('booked', 'checked_in')) as still_open,
      avg(extract(epoch from visit_started_at - checked_in_at)) filter (where visit_started_at >= checked_in_at) as avg_wait,
      avg(extract(epoch from completed_at - visit_started_at)) filter (where status = 'completed' and completed_at >= visit_started_at) as avg_visit
    from appointments
    where tenant_id = ${tenantId} and location_id = ${location.id} and starts_at >= ${start} and starts_at < ${end}
  `);
  const [walkIns] = await transaction.execute(sql`
    select count(*) as walk_ins from queue_tickets
    where tenant_id = ${tenantId} and location_id = ${location.id} and created_at >= ${start} and created_at < ${end}
  `);
  const taken = await transaction.execute<{ method: PaymentMethod; total: string }>(sql`
    select p.method::text as method, sum(p.amount_minor) as total
    from payments p left join appointments a on a.tenant_id = p.tenant_id and a.id = p.appointment_id
    where p.tenant_id = ${tenantId} and coalesce(a.location_id, p.location_id) = ${location.id} and p.created_at >= ${start} and p.created_at < ${end} and not p.is_test
    group by 1
  `);
  const refunded = await transaction.execute<{ method: PaymentMethod; total: string }>(sql`
    select p.method::text as method, sum(r.amount_minor) as total
    from payment_refunds r
    join payments p on p.tenant_id = r.tenant_id and p.id = r.payment_id
    left join appointments a on a.tenant_id = p.tenant_id and a.id = p.appointment_id
    where r.tenant_id = ${tenantId} and coalesce(a.location_id, p.location_id) = ${location.id} and r.created_at >= ${start} and r.created_at < ${end} and not r.is_test
    group by 1
  `);
  const [owed] = await transaction.execute(sql`
    select count(*) filter (where due > 0) as owed_count, coalesce(sum(due), 0) as owed
    from (
      select greatest(0, a.price_minor - greatest(0,
        coalesce((select sum(p.amount_minor) from payments p where p.tenant_id = a.tenant_id and p.appointment_id = a.id), 0)
        - coalesce((select sum(r.amount_minor) from payment_refunds r join payments p on p.tenant_id = r.tenant_id and p.id = r.payment_id
                    where r.tenant_id = a.tenant_id and p.appointment_id = a.id), 0)
      )) as due
      from appointments a
      where a.tenant_id = ${tenantId} and a.location_id = ${location.id} and a.starts_at >= ${start} and a.starts_at < ${end}
        and a.status in ('booked', 'checked_in', 'completed') and a.price_minor > 0
    ) dues
  `);

  const byMethod = Object.fromEntries(ledgerMethods.map((method) => [method, 0])) as Record<PaymentMethod, number>;
  for (const row of taken) byMethod[row.method] = count(row.total);
  const refundsByMethod = Object.fromEntries(refunded.map((row) => [row.method, count(row.total)])) as Partial<Record<PaymentMethod, number>>;
  const takenMinor = Object.values(byMethod).reduce((total, value) => total + value, 0);
  const refundedMinor = Object.values(refundsByMethod).reduce((total, value) => total + (value ?? 0), 0);

  return {
    day,
    locationId: location.id,
    locationName: location.name,
    currency: tenant?.currency ?? "INR",
    visits: {
      total: count(visits?.total),
      seen: count(visits?.seen),
      noShows: count(visits?.no_shows),
      left: count(visits?.left_unseen),
      cancelled: count(visits?.cancelled),
      open: count(visits?.still_open),
      walkIns: count(walkIns?.walk_ins),
      avgWaitMinutes: minutes(visits?.avg_wait),
      avgVisitMinutes: minutes(visits?.avg_visit),
    },
    money: {
      byMethod,
      takenMinor,
      refundedMinor,
      netMinor: takenMinor - refundedMinor,
      cashExpectedMinor: Math.max(0, byMethod.cash - (refundsByMethod.cash ?? 0)),
      owedMinor: count(owed?.owed),
      owedCount: count(owed?.owed_count),
    },
  };
}

/** True when what was saved at closing no longer matches the day as it stands. */
export function summaryChanged(saved: DaySummary, now: DaySummary): boolean {
  // Postgres keeps jsonb keys in its own order, so compare values, not text.
  return canonicalJsonHash({ money: saved.money, visits: saved.visits }) !== canonicalJsonHash({ money: now.money, visits: now.visits });
}

async function loadDayEnd(transaction: TenantTransaction, tenantId: string, location: Location, day: string): Promise<DayEnd> {
  const summary = await summarise(transaction, tenantId, location, day);
  const [row] = await transaction.select().from(dayCloses)
    .where(and(eq(dayCloses.tenantId, tenantId), eq(dayCloses.locationId, location.id), eq(dayCloses.day, day)));
  const close: DayCloseView | null = row ? {
    at: row.createdAt.toISOString(),
    byName: row.closedByName,
    cashCountedMinor: row.cashCountedMinor,
    cashExpectedMinor: row.cashExpectedMinor,
    note: row.note,
    summary: row.summary as unknown as DaySummary,
  } : null;
  return { today: location.today, summary, close, changedSinceClose: close ? summaryChanged(close.summary, summary) : false };
}

/** The day-end summary for one location, with the saved close when the day has been closed. */
export async function getDayEnd(context: StaffContext, query: z.infer<typeof dayEndQuerySchema>): Promise<DayEnd> {
  requirePermission(context, "payments.close_day");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const location = await findLocation(transaction, context, query.locationId);
    return loadDayEnd(transaction, context.tenantId, location, query.day ?? location.today);
  });
}

/** Closes the day: saves the totals and the cash count once. A closed day cannot be closed again or changed. */
export async function closeDay(context: StaffContext, input: z.infer<typeof closeDayInputSchema>, idempotencyKey: string): Promise<DayEnd> {
  requirePermission(context, "payments.close_day");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const claim = await claimKey<DayEnd>(transaction, context.tenantId, CLOSE_ROUTE, idempotencyKey, input);
    if ("replay" in claim) return claim.replay;
    const location = await findLocation(transaction, context, input.locationId);
    if (input.day > location.today) throw new ApiError(409, "day_not_over", "That day hasn't happened yet.");
    const summary = await summarise(transaction, context.tenantId, location, input.day);
    const [row] = await transaction.insert(dayCloses).values({
      tenantId: context.tenantId,
      locationId: location.id,
      day: input.day,
      summary: summary as unknown as Record<string, unknown>,
      cashExpectedMinor: summary.money.cashExpectedMinor,
      cashCountedMinor: input.cashCountedMinor,
      note: input.note || null,
      closedByUserId: context.userId,
      closedByName: context.userName.slice(0, 120) || "Staff",
    }).onConflictDoNothing().returning({ id: dayCloses.id });
    if (!row) throw new ApiError(409, "day_already_closed", "This day is already closed.");
    // Amounts only. The note is free text the desk typed, so it stays out of the activity log.
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
      action: "day.closed", outcome: "success",
      metadata: {
        dayCloseId: row.id, day: input.day, locationId: location.id, currency: summary.currency,
        netMinor: summary.money.netMinor, cashExpectedMinor: summary.money.cashExpectedMinor, cashCountedMinor: input.cashCountedMinor,
      },
    });
    const after = await loadDayEnd(transaction, context.tenantId, location, input.day);
    await finishKey(transaction, claim.claimId, after);
    return after;
  });
}
