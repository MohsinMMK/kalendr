import "server-only";

import { sql } from "drizzle-orm";

import { getDatabase } from "@/db/client";

/**
 * Whether a new session must be refused because the person's company requires company sign-in. A session made by company sign-in
 * is fine, and so is one re-issued to a person who already holds a live session (Better Auth does that when a second factor is
 * enrolled, removed or checked and when a password changes): that session was made by an allowed way, and refusing its
 * replacement would lock an admin out the moment they enrol.
 */
export function mustRefuseNewSession(input: { path: string; heldSessionUserId: string | null; userId: string; companySignInRequired: boolean }): boolean {
  if (!input.companySignInRequired) return false;
  if (input.path.startsWith("/sso/")) return false;
  return input.heldSessionUserId !== input.userId;
}

/**
 * True when a business this person belongs to makes their email domain use company sign-in, and they are not that
 * business's break-glass owner. A session made any other way (password, link, Google, passkey) is refused for them.
 */
export async function companySignInRequiredFor(userId: string): Promise<boolean> {
  const database = getDatabase();
  if (!database) return false;
  const rows = await database.execute<{ tenant_id: string; break_glass: boolean }>(sql`select * from kalendr_sso_required_for_user(${userId})`);
  return rows.some((row) => !row.break_glass);
}
