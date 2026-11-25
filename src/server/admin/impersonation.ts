import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { adminCall, isoTime } from "./db";
import { createOpaqueToken, sha256 } from "../crypto";

export interface StartedImpersonation { sessionId: string; endsAt: string; token: string }

/** The token is 256 random bits; only its SHA-256 reaches the database, so a database read cannot start a session. */
export async function startImpersonation(adminUserId: string, tenantId: string, reason: string, write: boolean): Promise<StartedImpersonation> {
  const token = createOpaqueToken();
  const rows = await adminCall((database) => database.execute(sql`select * from admin_start_impersonation(${adminUserId}, ${tenantId}, ${reason}, ${write}, ${sha256(token)})`));
  const row = z.array(z.object({ session_id: z.string(), ends_at: isoTime })).parse([...rows])[0];
  if (!row) throw new Error("admin_start_impersonation returned nothing");
  return { sessionId: row.session_id, endsAt: row.ends_at, token };
}

export async function endImpersonation(adminUserId: string, sessionId: string): Promise<boolean> {
  const rows = await adminCall((database) => database.execute<{ ended: boolean }>(sql`select admin_end_impersonation(${adminUserId}, ${sessionId}) as ended`));
  return rows[0]?.ended === true;
}

export interface ResolvedImpersonation { sessionId: string; tenantId: string; writeAccess: boolean; endsAt: Date; reason: string }

const resolvedSchema = z.object({ session_id: z.string(), tenant_id: z.string(), write_access: z.boolean(), ends_at: z.union([z.date(), z.string()]), reason: z.string() });

/** The live session for this operator and cookie token, or null once it ended or ran out. Expiry is decided in the database clock. */
export async function resolveImpersonation(adminUserId: string, token: string): Promise<ResolvedImpersonation | null> {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
  const rows = await adminCall((database) => database.execute(sql`select * from admin_resolve_impersonation(${adminUserId}, ${sha256(token)})`));
  const row = z.array(resolvedSchema).parse([...rows])[0];
  return row ? { sessionId: row.session_id, tenantId: row.tenant_id, writeAccess: row.write_access, endsAt: new Date(row.ends_at), reason: row.reason } : null;
}

const recentViews = new Map<string, number>();

/**
 * Notes one page or API view of the business, path only (the database function drops any query string). At most one
 * row per session and path per minute in this process, and a failure is swallowed: recording must never block the view.
 */
export function recordImpersonationView(adminUserId: string, sessionId: string, path: string, now: number = Date.now()): void {
  const clean = path.split("?")[0]?.slice(0, 200) ?? "";
  const key = `${sessionId}:${clean}`;
  const last = recentViews.get(key);
  if (last !== undefined && now - last < 60_000) return;
  if (recentViews.size > 5_000) for (const [stored, at] of recentViews) if (now - at >= 60_000) recentViews.delete(stored);
  recentViews.set(key, now);
  void adminCall((database) => database.execute(sql`select admin_record_impersonation_view(${adminUserId}, ${sessionId}, ${clean})`)).catch(() => undefined);
}
