/**
 * First step of a breach investigation: which businesses, customers and staff the audit log shows activity for in a
 * time window. It calls kalendr_breach_affected(), a SECURITY DEFINER function that only the worker role may run and
 * that returns ids and times, never names, contacts or content. The admin console action that will call this is
 * feature 15 (not built yet). See docs/INCIDENT_RUNBOOK.md for the whole procedure.
 *
 * No "server-only" import: it runs with the worker's database connection.
 */
import type postgres from "postgres";

export type AffectedKind = "tenant" | "customer" | "staff_user";

export interface AffectedSubject {
  tenantId: string;
  kind: AffectedKind;
  subjectId: string;
  firstSeen: Date;
  lastSeen: Date;
}

const MAX_WINDOW_DAYS = 92;

export function validateWindow(from: Date, to: Date): void {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw new Error("The end of the window must be after its start.");
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 24 * 60 * 60 * 1_000) throw new Error(`A window can be at most ${MAX_WINDOW_DAYS} days. Run it in parts.`);
}

/** Everything the audit log shows in [from, to), grouped by business. Run it with the worker role's connection. */
export async function listBreachAffected(database: postgres.Sql, from: Date, to: Date): Promise<AffectedSubject[]> {
  validateWindow(from, to);
  const rows = await database<{ tenant_id: string; kind: AffectedKind; subject_id: string; first_seen: Date; last_seen: Date }[]>`
    select tenant_id, kind, subject_id, first_seen, last_seen from kalendr_breach_affected(${from}, ${to})
    order by tenant_id, kind, subject_id
  `;
  return rows.map((row) => ({ tenantId: row.tenant_id, kind: row.kind, subjectId: row.subject_id, firstSeen: row.first_seen, lastSeen: row.last_seen }));
}

/** Counts per business, for the 72-hour report. */
export function summariseAffected(rows: readonly AffectedSubject[]): { tenantId: string; customers: number; staff: number }[] {
  const byTenant = new Map<string, { tenantId: string; customers: number; staff: number }>();
  for (const row of rows) {
    const entry = byTenant.get(row.tenantId) ?? { tenantId: row.tenantId, customers: 0, staff: 0 };
    if (row.kind === "customer") entry.customers += 1;
    if (row.kind === "staff_user") entry.staff += 1;
    byTenant.set(row.tenantId, entry);
  }
  return [...byTenant.values()];
}
