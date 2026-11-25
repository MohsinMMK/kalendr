import "server-only";

import { sql } from "drizzle-orm";

import { getDatabase } from "@/db/client";
import { auth, authIsConfigured } from "@/lib/auth";
import { chooseMembership, readActiveBusinessSlug, type OwnBusiness } from "@/lib/active-business";
import type { StaffRole } from "@/lib/permissions";

import { ApiError } from "./api-error";

/**
 * The businesses one login works in, for the switcher. This reads the session and the access function only, never
 * `getStaffContext`: that one refuses a business whose security policy the person has not met yet (a second factor,
 * say), and the switcher must still work then, so they can leave that business for another one.
 */
interface AccessRow extends Record<string, unknown> {
  slug: string;
  name: string;
  role: StaffRole;
}

/** Everything the switcher shows, in a stable order. `current` marks the business named by `requestedSlug`, else the remembered one, else the first. */
export async function listOwnBusinesses(userId: string, cookieHeader: string | null | undefined, requestedSlug?: string): Promise<OwnBusiness[]> {
  const database = getDatabase();
  if (!database) return [];
  const rows = await database.execute<AccessRow>(sql`select slug, name, role from kalendr_resolve_staff_access(${userId})`);
  const open = chooseMembership(rows, { requestedSlug, cookieSlug: readActiveBusinessSlug(cookieHeader) });
  return rows.map((row) => ({ slug: row.slug, name: row.name, role: row.role, current: row.slug === open?.slug }));
}

/** The signed-in person behind these headers, with no business chosen. */
export async function requireSessionUserId(requestHeaders: Headers): Promise<string> {
  if (!authIsConfigured) throw new ApiError(503, "auth_unavailable", "Staff sign-in is not configured.");
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) throw new ApiError(401, "unauthorized", "Sign in is required.");
  return session.user.id;
}

/**
 * Checks that this person really is an active member of the business they ask to open. The route then remembers it in the
 * cookie. A business that is not theirs is a plain 403 with the same words as any other access refusal, and says nothing
 * about whether it exists.
 */
export async function requireOwnBusiness(userId: string, slug: string): Promise<OwnBusiness> {
  const businesses = await listOwnBusinesses(userId, null);
  const found = businesses.find((business) => business.slug === slug);
  if (!found) throw new ApiError(403, "forbidden", "You don't have access to that business.");
  return found;
}

/**
 * The businesses a signed-in person could open instead of the one that is refusing them (a second factor not set up, a
 * profile not linked). Empty when they have only one, or no session: those screens must never fail because of this list.
 */
export async function otherBusinessesFor(requestHeaders: Headers): Promise<OwnBusiness[]> {
  try {
    const userId = await requireSessionUserId(requestHeaders);
    const all = await listOwnBusinesses(userId, requestHeaders.get("cookie"));
    return all.length > 1 ? all.filter((business) => !business.current) : [];
  } catch {
    return [];
  }
}
