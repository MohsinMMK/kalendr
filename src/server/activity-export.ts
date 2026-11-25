import "server-only";

import { sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents } from "@/db/schema";

import { listActivity, type ActivityFilters } from "./staff-activity";
import { assertNotImpersonating, requirePermission, requireRecentStepUp, type StaffContext } from "./staff-context";

const maxRows = 5000;
const batch = 500;

/** A spreadsheet runs a cell that starts with these as a formula, so the cell is made plain text first. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The activity log as a CSV the owner can hand an auditor: what the filters on the screen show, oldest limit 5,000 rows. */
export async function exportActivityCsv(context: StaffContext, filters: Omit<ActivityFilters, "cursor" | "pageSize">): Promise<string> {
  requirePermission(context, "audit.view");
  assertNotImpersonating(context);
  requireRecentStepUp(context);
  const lines = [["When", "Who", "What", "Details", "Outcome"].map(csvCell).join(",")];
  let cursor: string | null = null;
  let written = 0;
  do {
    const page = await listActivity(context, { ...filters, cursor, pageSize: batch });
    for (const entry of page.entries) {
      lines.push([entry.occurredAt, entry.actor, entry.summary, entry.changes.join("; "), entry.outcome].map(csvCell).join(","));
      written += 1;
    }
    cursor = page.nextCursor;
  } while (cursor && written < maxRows);
  if (!context.preview) {
    await withTenant(context.tenantId, (transaction) => transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "audit.exported", outcome: "success",
      metadata: { rows: written, truncated: cursor !== null },
    }));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export interface ActivityPerson { userId: string; name: string }

/** Everyone who has acted in this business, for the "who" filter. Names only, no addresses. */
export async function listActivityPeople(context: StaffContext): Promise<ActivityPerson[]> {
  requirePermission(context, "audit.view");
  if (context.preview) return [];
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.execute<{ user_id: string; name: string }>(sql`
      select auth_users.id as user_id, auth_users.name
      from memberships join auth_users on auth_users.id = memberships.user_id
      where memberships.tenant_id = ${context.tenantId}
      order by auth_users.name`);
    return rows.map((row) => ({ userId: row.user_id, name: row.name }));
  });
}

