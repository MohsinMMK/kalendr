import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { operatorInputSchema, operatorRowSchema, type OperatorRow } from "@/lib/admin-contracts";

import { adminCall, isoTime } from "./db";

const rowSchema = z.object({ user_id: z.string(), role: z.enum(["support", "billing", "super"]), is_active: z.boolean(), created_at: isoTime });

/** Ids and roles only: the operator list never shows an address. */
export async function listOperators(adminUserId: string): Promise<OperatorRow[]> {
  const rows = await adminCall((database) => database.execute(sql`select * from admin_list_platform_admins(${adminUserId})`));
  return z.array(rowSchema).parse([...rows]).map((row) => operatorRowSchema.parse({ userId: row.user_id, role: row.role, isActive: row.is_active, createdAt: row.created_at }));
}

/** Adds or changes an operator by the email of an existing user. False when no such user exists. */
export async function setOperator(adminUserId: string, input: z.infer<typeof operatorInputSchema>): Promise<boolean> {
  const rows = await adminCall((database) => database.execute<{ done: boolean }>(sql`select admin_set_platform_admin(${adminUserId}, ${input.email}, ${input.role}, ${input.active}) as done`));
  if (rows[0]?.done !== true) return false;
  // The database function records who changed whom; this adds why, which only the app has.
  await adminCall((database) => database.execute(sql`select admin_record_action(${adminUserId}, null, 'admin.operator.reason', ${input.reason}, ${JSON.stringify({ role: input.role, active: input.active })}::jsonb)`));
  return true;
}
