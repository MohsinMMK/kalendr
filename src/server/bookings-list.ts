import { sql, type SQL } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import {
  bookingSources,
  defaultSortFor,
  type BookingFilter,
  type BookingPage,
  type BookingQuery,
  type BookingRow,
  type BookingTab,
} from "@/lib/bookings-list";
import { appointmentStatusSchema } from "@/lib/contracts";
import { ApiError } from "@/server/api-error";
import { locationCondition } from "@/server/location-scope";
import { countSeries } from "@/server/series-count";
import { requirePermission, type StaffContext } from "@/server/staff-context";

/**
 * The bookings list (feature 43). One function turns a validated filter object into one parameterised query; nothing
 * here builds SQL from text the caller typed, only from values bound as parameters. Paging is a cursor on
 * (starts_at, id), so page 500 costs the same as page 1 and a booking added in the meantime never shifts a page.
 */

const LIVE_UPCOMING = ["booked", "checked_in", "reschedule_requested"] as const;
const ENDED = ["cancelled", "declined", "expired", "entered_in_error"] as const;

function inList(values: readonly string[]): SQL {
  return sql.join(values.map((value) => sql`${value}`), sql`, `);
}

/** Which bookings a tab holds, as a condition on `appointment`. `now` is a parameter so the same rule is testable. */
export function tabCondition(tab: BookingTab, now: Date): SQL {
  const at = now.toISOString();
  switch (tab) {
    case "upcoming":
      return sql`(appointment.status::text in (${inList(LIVE_UPCOMING)}) and appointment.ends_at >= ${at}::timestamptz)`;
    case "needs_approval":
      return sql`appointment.status::text = 'requested'`;
    case "past":
      return sql`(appointment.status::text in ('completed', 'no_show') or (appointment.status::text in ('booked', 'checked_in') and appointment.ends_at < ${at}::timestamptz))`;
    case "cancelled":
      return sql`appointment.status::text in (${inList(ENDED)})`;
  }
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** The filters that do not depend on the tab. Each present filter is one bound condition. */
export function filterConditions(filter: BookingFilter): SQL[] {
  const conditions: SQL[] = [];
  if (filter.practitionerIds?.length) conditions.push(sql`appointment.practitioner_id in (${inList(filter.practitionerIds)})`);
  if (filter.serviceIds?.length) conditions.push(sql`appointment.service_id in (${inList(filter.serviceIds)})`);
  if (filter.locationIds?.length) conditions.push(sql`appointment.location_id in (${inList(filter.locationIds)})`);
  if (filter.statuses?.length) conditions.push(sql`appointment.status::text in (${inList(filter.statuses.filter((status) => appointmentStatusSchema.safeParse(status).success))})`);
  if (filter.sources?.length) conditions.push(sql`appointment.booking_source::text in (${inList(filter.sources.filter((source) => (bookingSources as readonly string[]).includes(source)))})`);
  if (filter.from) conditions.push(sql`appointment.starts_at >= ${filter.from}::timestamptz`);
  if (filter.to) conditions.push(sql`appointment.starts_at < ${filter.to}::timestamptz`);
  if (filter.utmSource) conditions.push(sql`appointment.utm_source = ${filter.utmSource}`);
  if (filter.utmCampaign) conditions.push(sql`appointment.utm_campaign = ${filter.utmCampaign}`);
  if (filter.q) {
    const text = filter.q.trim();
    const digits = text.replace(/\D/g, "");
    const byName = sql`(patient.first_name || ' ' || patient.last_name) ilike ${`%${escapeLike(text)}%`}`;
    // A phone number is matched on its digits only, whatever spaces or dashes were typed or stored.
    conditions.push(digits.length >= 3 && digits.length >= text.replace(/[\s()+-]/g, "").length
      ? sql`(${byName} or kalendr_normalize_phone(patient.phone) like ${`%${digits}%`})`
      : byName);
  }
  return conditions;
}

interface Cursor { startsAt: string; id: string }

export function encodeCursor(startsAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([startsAt.toISOString(), id]), "utf8").toString("base64url");
}

export function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string" && !Number.isNaN(Date.parse(parsed[0])) && parsed[1].length <= 160) {
      return { startsAt: new Date(parsed[0]).toISOString(), id: parsed[1] };
    }
  } catch {
    // Falls through to the refusal below.
  }
  throw new ApiError(400, "validation_error", "That page link is not valid any more. Go back to the first page.", { cursor: ["That page link is not valid."] });
}

interface ListRow extends Record<string, unknown> {
  id: string;
  version: number;
  starts_at: Date | string;
  ends_at: Date | string;
  status: BookingRow["status"];
  booking_source: BookingRow["bookingSource"];
  patient_id: string;
  first_name: string;
  last_name: string;
  phone: string;
  service_id: string;
  service_name: string;
  practitioner_id: string;
  practitioner_name: string;
  location_id: string;
  location_name: string;
  price_minor: number | null;
  referrer_host: string | null;
  utm_source: string | null;
  utm_campaign: string | null;
  reschedule_requested_at: Date | string | null;
  proposed_count: number | null;
}

const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

function toRow(row: ListRow): BookingRow {
  return {
    id: row.id,
    version: Number(row.version),
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    status: row.status,
    bookingSource: row.booking_source,
    customer: { id: row.patient_id, name: `${row.first_name} ${row.last_name}`.trim(), phone: row.phone },
    service: { id: row.service_id, name: row.service_name },
    practitioner: { id: row.practitioner_id, name: row.practitioner_name },
    location: { id: row.location_id, name: row.location_name },
    priceMinor: row.price_minor === null ? null : Number(row.price_minor),
    referrerHost: row.referrer_host,
    utmSource: row.utm_source,
    utmCampaign: row.utm_campaign,
    rescheduleRequestedAt: row.reschedule_requested_at ? iso(row.reschedule_requested_at) : null,
    proposedCount: Number(row.proposed_count ?? 0),
  };
}

/**
 * What a limited person may see of `appointment`: a practitioner sees their own bookings only, and anyone limited to some
 * locations sees those locations only (both rules apply together). Everyone else who may read the list sees the whole business.
 */
export async function scopeFor(transaction: KalendrTransaction, context: StaffContext): Promise<SQL | null> {
  const parts: SQL[] = [];
  const location = locationCondition(context, sql`appointment.location_id`);
  if (location) parts.push(location);
  if (context.role === "practitioner") {
    const own = await transaction.execute<{ id: string }>(sql`select id from practitioners where tenant_id = ${context.tenantId} and auth_user_id = ${context.userId} limit 1`);
    parts.push(own[0] ? sql`appointment.practitioner_id = ${own[0].id}` : sql`false`);
  }
  return parts.length > 0 ? sql.join(parts, sql` and `) : null;
}

export const fromClause = sql`
  from appointments as appointment
  join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
  join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
  join practitioners as practitioner on practitioner.tenant_id = appointment.tenant_id and practitioner.id = appointment.practitioner_id
  join locations as location on location.tenant_id = appointment.tenant_id and location.id = appointment.location_id
`;

export interface ListOptions {
  /** For tests; the clock otherwise. */
  now?: Date;
}

export async function listBookings(context: StaffContext, query: BookingQuery, options: ListOptions = {}): Promise<BookingPage> {
  requirePermission(context, "appointments.status");
  if (context.preview) throw new ApiError(400, "preview_only", "The bookings list needs a database.");
  const now = options.now ?? new Date();
  const sort = query.sort ?? defaultSortFor(query.tab);
  const cursor = decodeCursor(query.cursor);
  return withTenant(context.tenantId, async (transaction) => {
    const scope = await scopeFor(transaction, context);
    const shared = [sql`appointment.tenant_id = ${context.tenantId}`, ...filterConditions(query), ...(scope ? [scope] : [])];
    const where = sql.join([...shared, tabCondition(query.tab, now)], sql` and `);
    const ascending = sort === "asc";
    // Row-value comparison on (starts_at, id) is what the list indexes serve.
    const after = cursor
      ? (ascending
        ? sql` and (appointment.starts_at, appointment.id) > (${cursor.startsAt}::timestamptz, ${cursor.id})`
        : sql` and (appointment.starts_at, appointment.id) < (${cursor.startsAt}::timestamptz, ${cursor.id})`)
      : sql``;
    const order = ascending ? sql`order by appointment.starts_at asc, appointment.id asc` : sql`order by appointment.starts_at desc, appointment.id desc`;
    const rows = await transaction.execute<ListRow>(sql`
      select appointment.id, appointment.version, appointment.starts_at, appointment.ends_at, appointment.status, appointment.booking_source,
        appointment.patient_id, patient.first_name, patient.last_name, patient.phone,
        appointment.service_id, service.name as service_name, appointment.practitioner_id, practitioner.name as practitioner_name,
        appointment.location_id, location.name as location_name, appointment.price_minor,
        appointment.referrer_host, appointment.utm_source, appointment.utm_campaign, appointment.reschedule_requested_at,
        coalesce(cardinality(appointment.proposed_starts), 0) as proposed_count
      ${fromClause}
      where ${where}${after}
      ${order}
      limit ${query.limit + 1}
    `);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    const next = rows.length > query.limit && last ? encodeCursor(new Date(last.starts_at), last.id) : null;

    // The tab counts are asked for once, with the first page; later pages only need rows.
    if (cursor) return { rows: page.map(toRow), nextCursor: next, counts: null };
    const sharedWhere = sql.join(shared, sql` and `);
    const [counts] = await transaction.execute<{ upcoming: number; needs_approval: number; past: number; cancelled: number }>(sql`
      select
        count(*) filter (where ${tabCondition("upcoming", now)})::int as upcoming,
        count(*) filter (where ${tabCondition("needs_approval", now)})::int as needs_approval,
        count(*) filter (where ${tabCondition("past", now)})::int as past,
        count(*) filter (where ${tabCondition("cancelled", now)})::int as cancelled
      ${query.q ? fromClause : sql`from appointments as appointment`}
      where ${sharedWhere}
    `);
    return {
      rows: page.map(toRow),
      nextCursor: next,
      repeatingCount: await countSeries(transaction, context, query), // the Repeating tab's badge (feature 17)
      counts: {
        upcoming: Number(counts?.upcoming ?? 0),
        needs_approval: Number(counts?.needs_approval ?? 0),
        past: Number(counts?.past ?? 0),
        cancelled: Number(counts?.cancelled ?? 0),
      },
    };
  });
}
