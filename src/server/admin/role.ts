import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "@/db/client";
import { platformRoles, type PlatformRole } from "@/lib/admin-contracts";

const roleSchema = z.enum(platformRoles);

/** The operator role for this user id, or null. Goes through `admin_whoami`: the runtime role cannot read platform_admins. */
export async function lookupPlatformRole(userId: string): Promise<PlatformRole | null> {
  const database = getDatabase();
  if (!database) return null;
  const rows = await database.execute<{ role: string | null }>(sql`select admin_whoami(${userId}) as role`);
  const parsed = roleSchema.safeParse(rows[0]?.role);
  return parsed.success ? parsed.data : null;
}
