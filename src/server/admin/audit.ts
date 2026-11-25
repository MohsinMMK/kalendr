import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { adminAuditRowSchema, type AdminAuditRow } from "@/lib/admin-contracts";

import { adminCall, isoTime } from "./db";

const rowSchema = z.object({
  id: z.string(),
  admin_user_id: z.string(),
  tenant_id: z.string().nullable(),
  action: z.string(),
  reason: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  occurred_at: isoTime,
});

export async function listAudit(adminUserId: string, tenantId: string | null, limit: number): Promise<AdminAuditRow[]> {
  const rows = await adminCall((database) => database.execute(sql`select * from admin_list_audit(${adminUserId}, ${tenantId}, ${limit})`));
  return z.array(rowSchema).parse([...rows]).map((row) => adminAuditRowSchema.parse({
    id: row.id, adminUserId: row.admin_user_id, tenantId: row.tenant_id, action: row.action, reason: row.reason, metadata: row.metadata, occurredAt: row.occurred_at,
  }));
}
