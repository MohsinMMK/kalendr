import "server-only";

import { eq } from "drizzle-orm";

import { getDatabase } from "@/db/client";
import { authUsers } from "@/db/schema";
import { auth } from "@/lib/auth";

export interface PasswordLinkPerson {
  name: string;
  email: string;
  /** They have chosen a password before, so this is a reset rather than a first sign-in. */
  hasPassword: boolean;
}

/**
 * Looks up who an invite or reset link belongs to, so the page can greet them by name.
 * Returns null for a link that is unknown, already used or expired. Goes through Better Auth's
 * adapter because tokens are stored hashed; Better Auth checks the token again on submit.
 */
export async function findPasswordLink(token: string): Promise<PasswordLinkPerson | null> {
  const database = getDatabase();
  if (!database || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  const context = await auth.$context;
  const verification = await context.internalAdapter.findVerificationValue(`reset-password:${token}`);
  if (!verification || new Date(verification.expiresAt) <= new Date()) return null;
  const [row] = await database
    .select({ name: authUsers.name, email: authUsers.email, passwordSetAt: authUsers.passwordSetAt })
    .from(authUsers)
    .where(eq(authUsers.id, verification.value))
    .limit(1);
  return row ? { name: row.name, email: row.email, hasPassword: Boolean(row.passwordSetAt) } : null;
}
