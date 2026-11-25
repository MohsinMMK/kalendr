import "server-only";

import { sql } from "drizzle-orm";

import { adminAbuseSchema, type AdminAbuse } from "@/lib/admin-contracts";

import { adminCall } from "./db";

export async function abuseOverview(adminUserId: string): Promise<AdminAbuse> {
  const rows = await adminCall((database) => database.execute<{ overview: unknown }>(sql`select admin_abuse_overview(${adminUserId}) as overview`));
  return adminAbuseSchema.parse(rows[0]?.overview);
}
