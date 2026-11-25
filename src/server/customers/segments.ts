import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { customerSegments } from "@/db/schema";
import { segmentFilterSchema, type SegmentFilter, type SegmentInput, type SegmentMember, type SegmentSummary, type SegmentUpdate } from "@/lib/segment-filter";
import { ApiError } from "@/server/api-error";
import { can, requirePermission, type StaffContext } from "@/server/staff-context";

import { auditCustomer, customerWords } from "./access";
import { compileSegment, countSegmentSql } from "./segment-sql";

export const MAX_SEGMENTS = 50;

/** Reading segments is for the people who manage customers or run campaigns; writing is for managers of customers. */
function requireSegmentReader(context: StaffContext): void {
  if (!can(context, "customers.manage") && !can(context, "campaigns.manage")) requirePermission(context, "customers.manage");
}

export async function countSegmentIn(transaction: KalendrTransaction, tenantId: string, filter: SegmentFilter, now: Date = new Date()): Promise<number> {
  const rows = await transaction.execute<{ count: number }>(countSegmentSql(filter, { tenantId, now }));
  return Number(rows[0]?.count ?? 0);
}

function parseStoredFilter(value: unknown): SegmentFilter {
  const parsed = segmentFilterSchema.safeParse(value);
  // A filter that no longer parses (a service was removed and a rule changed) reads as "everyone is out" rather than "everyone is in".
  return parsed.success ? parsed.data : { all: [{ field: "visits", op: "lt", value: 0 }] };
}

/** The count shown while an owner builds a segment, before anything is saved. */
export async function previewSegmentCount(context: StaffContext, filter: SegmentFilter): Promise<{ count: number }> {
  requireSegmentReader(context);
  if (context.preview) return { count: 0 };
  return withTenant(context.tenantId, async (transaction) => ({ count: await countSegmentIn(transaction, context.tenantId, filter) }));
}

export async function listSegments(context: StaffContext): Promise<SegmentSummary[]> {
  requireSegmentReader(context);
  if (context.preview) return [];
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.select().from(customerSegments)
      .where(eq(customerSegments.tenantId, context.tenantId)).orderBy(asc(customerSegments.name));
    const now = new Date();
    const summaries: SegmentSummary[] = [];
    for (const row of rows) {
      const filter = parseStoredFilter(row.filter);
      summaries.push({ id: row.id, name: row.name, filter, version: row.version, count: await countSegmentIn(transaction, context.tenantId, filter, now), updatedAt: row.updatedAt.toISOString() });
    }
    return summaries;
  });
}

export async function getSegment(context: StaffContext, segmentId: string): Promise<SegmentSummary> {
  requireSegmentReader(context);
  if (context.preview) throw new ApiError(400, "preview_only", "Segments need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.select().from(customerSegments)
      .where(and(eq(customerSegments.tenantId, context.tenantId), eq(customerSegments.id, segmentId)));
    if (!row) throw new ApiError(404, "segment_not_found", "That segment no longer exists.");
    const filter = parseStoredFilter(row.filter);
    return { id: row.id, name: row.name, filter, version: row.version, count: await countSegmentIn(transaction, context.tenantId, filter), updatedAt: row.updatedAt.toISOString() };
  });
}

export async function createSegment(context: StaffContext, input: SegmentInput): Promise<SegmentSummary> {
  requirePermission(context, "customers.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Segments need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    // One lock per business keeps two people adding the fifty-first segment at once from both succeeding.
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`segments:${context.tenantId}`}, 0))`);
    const [{ total } = { total: 0 }] = await transaction.execute<{ total: number }>(sql`select count(*)::int as total from customer_segments where tenant_id = ${context.tenantId}`);
    if (Number(total) >= MAX_SEGMENTS) throw new ApiError(409, "too_many_segments", `You can keep up to ${MAX_SEGMENTS} saved segments.`);
    const [created] = await transaction.insert(customerSegments).values({
      tenantId: context.tenantId, name: input.name, filter: input.filter, createdByUserId: context.userId,
    }).onConflictDoNothing().returning();
    if (!created) throw new ApiError(409, "segment_exists", "You already have a segment with that name.", { name: ["You already have a segment with that name."] });
    await auditCustomer(transaction, context, "customer.segment.created", null, { segmentId: created.id });
    return { id: created.id, name: created.name, filter: input.filter, version: created.version, count: await countSegmentIn(transaction, context.tenantId, input.filter), updatedAt: created.updatedAt.toISOString() };
  });
}

export async function updateSegment(context: StaffContext, segmentId: string, input: SegmentUpdate): Promise<SegmentSummary> {
  requirePermission(context, "customers.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Segments need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    const [existing] = await transaction.select().from(customerSegments)
      .where(and(eq(customerSegments.tenantId, context.tenantId), eq(customerSegments.id, segmentId))).for("update");
    if (!existing) throw new ApiError(404, "segment_not_found", "That segment no longer exists.");
    if (existing.version !== input.version) throw new ApiError(409, "version_conflict", "Someone else changed this segment. Reload it and try again.");
    const [clash] = await transaction.execute<{ id: string }>(sql`
      select id from customer_segments where tenant_id = ${context.tenantId} and lower(name) = lower(${input.name}) and id <> ${segmentId}
    `);
    if (clash) throw new ApiError(409, "segment_exists", "You already have a segment with that name.", { name: ["You already have a segment with that name."] });
    const [updated] = await transaction.update(customerSegments)
      .set({ name: input.name, filter: input.filter, version: existing.version + 1, updatedAt: new Date() })
      .where(and(eq(customerSegments.tenantId, context.tenantId), eq(customerSegments.id, segmentId))).returning();
    if (!updated) throw new ApiError(404, "segment_not_found", "That segment no longer exists.");
    await auditCustomer(transaction, context, "customer.segment.updated", null, { segmentId });
    return { id: updated.id, name: updated.name, filter: input.filter, version: updated.version, count: await countSegmentIn(transaction, context.tenantId, input.filter), updatedAt: updated.updatedAt.toISOString() };
  });
}

export async function deleteSegment(context: StaffContext, segmentId: string): Promise<{ deleted: true }> {
  requirePermission(context, "customers.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Segments need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    // A campaign that uses the segment keeps working from its own copy of the audience, so deleting is safe, but say so.
    const removed = await transaction.delete(customerSegments)
      .where(and(eq(customerSegments.tenantId, context.tenantId), eq(customerSegments.id, segmentId))).returning({ id: customerSegments.id });
    if (removed.length === 0) throw new ApiError(404, "segment_not_found", "That segment no longer exists.");
    await auditCustomer(transaction, context, "customer.segment.deleted", null, { segmentId });
    return { deleted: true };
  });
}

interface MemberRow extends Record<string, unknown> {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  sort_last: string;
  sort_first: string;
}

function encodeCursor(row: Pick<MemberRow, "sort_last" | "sort_first" | "id">): string {
  return Buffer.from(JSON.stringify([row.sort_last, row.sort_first, row.id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): [string, string, string] | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return Array.isArray(value) && value.length === 3 && value.every((part) => typeof part === "string") ? [value[0], value[1], value[2]] : null;
  } catch {
    return null;
  }
}

/** One page of the customers a filter selects, in name order. */
export async function listSegmentMembers(
  context: StaffContext,
  filter: SegmentFilter,
  options: { limit: number; cursor?: string },
): Promise<{ members: SegmentMember[]; nextCursor: string | null }> {
  requireSegmentReader(context);
  if (context.preview) return { members: [], nextCursor: null };
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  if (options.cursor && !cursor) throw new ApiError(400, "invalid_cursor", "That page link is not valid.");
  const { prefix, from } = compileSegment(filter, { tenantId: context.tenantId, now: new Date() }, cursor
    ? sql`(lower(p.last_name), lower(p.first_name), p.id) > (${cursor[0]}, ${cursor[1]}, ${cursor[2]})`
    : undefined);
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.execute<MemberRow>(sql`
      ${prefix} select p.id, p.first_name, p.last_name, p.email, p.phone, lower(p.last_name) as sort_last, lower(p.first_name) as sort_first
      ${from} order by lower(p.last_name), lower(p.first_name), p.id limit ${options.limit + 1}
    `);
    const page = rows.slice(0, options.limit);
    const last = page[page.length - 1];
    return {
      members: page.map((row) => ({ id: row.id, name: `${row.first_name} ${row.last_name}`.trim(), email: row.email, phone: row.phone })),
      nextCursor: rows.length > options.limit && last ? encodeCursor(last) : null,
    };
  });
}

export async function segmentWords(context: StaffContext) {
  return withTenant(context.tenantId, (transaction) => customerWords(transaction, context.tenantId));
}
