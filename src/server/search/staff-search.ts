import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { dateKeyIn } from "@/lib/business-page";
import { searchIsOwnOnly, searchKindsFor, type SearchHit, type SearchKind, type StaffSearchResult } from "@/lib/search";
import { normaliseSearchQuery, SEARCH_MIN_LENGTH } from "@/lib/search";

import { allowedLocationIds, visibleCustomerCondition } from "../location-scope";
import type { StaffContext } from "../staff-context";
import { withoutSearchText } from "./scrub";

interface HitRow extends Record<string, unknown> {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string;
  at: Date | string | null;
  ref: string | null;
}

/** Used for a team member with no linked profile: it matches no customer and no appointment. */
const NO_PRACTITIONER = "none";

/** The most the search function returns per kind; a location-limited person asks for this many, then keeps their own. */
const SEARCH_CEILING = 20;

/**
 * Staff search (feature 29): customers, appointments, services, team members, invoices and campaigns of the signed-in
 * business that this person's role can open. One database function does the matching (see migration 0074): it reads the
 * business from the same setting row-level security uses, takes only the kinds this role may open, and uses the text
 * indexes. The query text is never logged.
 */
export function searchStaff(context: StaffContext, rawQuery: string, limit = 5): Promise<StaffSearchResult> {
  return withoutSearchText(() => runSearch(context, rawQuery, limit));
}

async function runSearch(context: StaffContext, rawQuery: string, limit: number): Promise<StaffSearchResult> {
  const query = normaliseSearchQuery(rawQuery);
  const kinds = searchKindsFor(context.permissions);
  if (context.preview || kinds.length === 0 || query.length < SEARCH_MIN_LENGTH) return { hits: [] };

  const rows = await withTenant(context.tenantId, async (transaction) => {
    let practitioner: string | null = null;
    let timezone = "UTC";
    const [tenant] = await transaction.execute<{ timezone: string }>(sql`select timezone from tenants where id = ${context.tenantId}`);
    if (tenant) timezone = tenant.timezone;
    if (searchIsOwnOnly(context.role)) {
      const [own] = await transaction.execute<{ id: string }>(sql`select id from practitioners where tenant_id = ${context.tenantId} and auth_user_id = ${context.userId} limit 1`);
      practitioner = own?.id ?? NO_PRACTITIONER;
    }
    const kindList = sql.join(kinds.map((kind) => sql`${kind}`), sql`, `);
    const limited = allowedLocationIds(context) !== null;
    const found = await transaction.execute<HitRow>(sql`
      select kind, id, title, subtitle, at, ref from kalendr_staff_search(array[${kindList}]::text[], ${query}, ${practitioner}, ${limited ? SEARCH_CEILING : limit})
    `);
    return { found: limited ? await keepOwnLocations(transaction, context, [...found], limit) : found, timezone };
  });

  const hits = rows.found.map((row): SearchHit => {
    const at = row.at === null ? null : new Date(row.at);
    return {
      kind: row.kind,
      id: row.id,
      title: row.title,
      subtitle: row.subtitle,
      at: at ? at.toISOString() : null,
      day: at ? dateKeyIn(at, rows.timezone) : null,
      customerId: row.ref,
    };
  });
  return { hits };
}

/**
 * Drops hits from locations a limited person may not use, then keeps `limit` per kind. Customers follow the customer list
 * rule, bookings and invoices their location, services and team members the pickers' rule (no locations, or one in common).
 * Forms and campaigns are business-wide. When more than 20 better matches sit at other locations, fewer hits come back.
 */
async function keepOwnLocations(transaction: KalendrTransaction, context: StaffContext, rows: HitRow[], limit: number): Promise<HitRow[]> {
  const allowed = allowedLocationIds(context);
  if (!allowed) return rows;
  const list = sql.join(allowed.map((id) => sql`${id}`), sql`, `);
  const idsOf = (kind: SearchKind) => rows.filter((row) => row.kind === kind).map((row) => row.id);
  const kept = new Set<string>();
  const keep = async (kind: SearchKind, query: (ids: SQL) => SQL) => {
    const ids = idsOf(kind);
    if (!ids.length) return;
    const found = await transaction.execute<{ id: string }>(query(sql.join(ids.map((id) => sql`${id}`), sql`, `)));
    for (const row of found) kept.add(`${kind}:${row.id}`);
  };
  await keep("customer", (ids) => sql`select patient.id from patients as patient where patient.tenant_id = ${context.tenantId} and patient.id in (${ids}) and ${visibleCustomerCondition(context, sql`patient.id`) ?? sql`true`}`);
  await keep("appointment", (ids) => sql`select id from appointments where tenant_id = ${context.tenantId} and id in (${ids}) and location_id in (${list})`);
  await keep("invoice", (ids) => sql`select id from invoices where tenant_id = ${context.tenantId} and id in (${ids}) and location_id in (${list})`);
  await keep("service", (ids) => sql`
    select service.id from services as service where service.tenant_id = ${context.tenantId} and service.id in (${ids})
      and (not exists (select 1 from service_locations as reach where reach.tenant_id = service.tenant_id and reach.service_id = service.id)
        or exists (select 1 from service_locations as reach where reach.tenant_id = service.tenant_id and reach.service_id = service.id and reach.location_id in (${list})))`);
  await keep("person", (ids) => sql`
    select person.id from practitioners as person where person.tenant_id = ${context.tenantId} and person.id in (${ids})
      and (not exists (select 1 from practitioner_locations as reach where reach.tenant_id = person.tenant_id and reach.practitioner_id = person.id)
        or exists (select 1 from practitioner_locations as reach where reach.tenant_id = person.tenant_id and reach.practitioner_id = person.id and reach.location_id in (${list})))`);
  const scoped = new Set<SearchKind>(["customer", "appointment", "invoice", "service", "person"]);
  const perKind = new Map<SearchKind, number>();
  return rows.filter((row) => {
    if (scoped.has(row.kind) && !kept.has(`${row.kind}:${row.id}`)) return false;
    const count = perKind.get(row.kind) ?? 0;
    if (count >= limit) return false;
    perKind.set(row.kind, count + 1);
    return true;
  });
}
