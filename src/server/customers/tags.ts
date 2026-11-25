import "server-only";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { customerTagLinks, customerTags } from "@/db/schema";
import { MAX_TAGS_PER_BUSINESS, tagColorOf, type CustomerTag, type TagInput } from "@/lib/customer-contracts";
import { ApiError } from "@/server/api-error";
import { requirePermission, type StaffContext } from "@/server/staff-context";

import { auditCustomer, loadVisibleCustomer } from "./access";

function toTag(row: { id: string; name: string; color: string }, count: number): CustomerTag {
  return { id: row.id, name: row.name, color: tagColorOf(row.color), count };
}

/** Every tag with how many customers carry it. Any staff member can read the list, so the profile can show names. */
export async function listTags(context: StaffContext): Promise<CustomerTag[]> {
  if (context.preview) return [];
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.execute<{ id: string; name: string; color: string; count: number }>(sql`
      select tag.id, tag.name, tag.color,
        (select count(*)::int from customer_tag_links as link join patients as p on p.tenant_id = link.tenant_id and p.id = link.patient_id
          where link.tenant_id = tag.tenant_id and link.tag_id = tag.id and p.merged_into_id is null and p.erased_at is null) as count
      from customer_tags as tag where tag.tenant_id = ${context.tenantId} order by lower(tag.name)
    `);
    return rows.map((row) => toTag(row, Number(row.count)));
  });
}

export async function createTag(context: StaffContext, input: TagInput): Promise<CustomerTag> {
  requirePermission(context, "customers.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Tags need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`customer-tags:${context.tenantId}`}, 0))`);
    const [{ total } = { total: 0 }] = await transaction.execute<{ total: number }>(sql`select count(*)::int as total from customer_tags where tenant_id = ${context.tenantId}`);
    if (Number(total) >= MAX_TAGS_PER_BUSINESS) throw new ApiError(409, "too_many_tags", `You can keep up to ${MAX_TAGS_PER_BUSINESS} tags.`);
    const [created] = await transaction.insert(customerTags).values({ tenantId: context.tenantId, name: input.name, color: input.color }).onConflictDoNothing().returning();
    if (!created) throw new ApiError(409, "tag_exists", "You already have a tag with that name.", { name: ["You already have a tag with that name."] });
    await auditCustomer(transaction, context, "customer.tag.created", null, { tagId: created.id });
    return toTag(created, 0);
  });
}

export async function updateTag(context: StaffContext, tagId: string, input: Partial<TagInput>): Promise<CustomerTag> {
  requirePermission(context, "customers.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Tags need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    if (input.name) {
      const [clash] = await transaction.execute<{ id: string }>(sql`select id from customer_tags where tenant_id = ${context.tenantId} and lower(name) = lower(${input.name}) and id <> ${tagId}`);
      if (clash) throw new ApiError(409, "tag_exists", "You already have a tag with that name.", { name: ["You already have a tag with that name."] });
    }
    const [updated] = await transaction.update(customerTags).set({ ...(input.name ? { name: input.name } : {}), ...(input.color ? { color: input.color } : {}) })
      .where(and(eq(customerTags.tenantId, context.tenantId), eq(customerTags.id, tagId))).returning();
    if (!updated) throw new ApiError(404, "tag_not_found", "That tag no longer exists.");
    await auditCustomer(transaction, context, "customer.tag.updated", null, { tagId });
    return toTag(updated, 0);
  });
}

export async function deleteTag(context: StaffContext, tagId: string): Promise<{ deleted: true }> {
  requirePermission(context, "customers.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Tags need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    const removed = await transaction.delete(customerTags).where(and(eq(customerTags.tenantId, context.tenantId), eq(customerTags.id, tagId))).returning({ id: customerTags.id });
    if (removed.length === 0) throw new ApiError(404, "tag_not_found", "That tag no longer exists.");
    await auditCustomer(transaction, context, "customer.tag.deleted", null, { tagId });
    return { deleted: true };
  });
}

/** The tags on one customer. */
export async function customerTagsFor(context: StaffContext, patientId: string): Promise<Omit<CustomerTag, "count">[]> {
  if (context.preview) return [];
  return withTenant(context.tenantId, async (transaction) => {
    await loadVisibleCustomer(transaction, context, patientId);
    const rows = await transaction.select({ id: customerTags.id, name: customerTags.name, color: customerTags.color }).from(customerTagLinks)
      .innerJoin(customerTags, and(eq(customerTags.tenantId, customerTagLinks.tenantId), eq(customerTags.id, customerTagLinks.tagId)))
      .where(and(eq(customerTagLinks.tenantId, context.tenantId), eq(customerTagLinks.patientId, patientId))).orderBy(asc(customerTags.name));
    return rows.map((row) => ({ id: row.id, name: row.name, color: tagColorOf(row.color) }));
  });
}

/** Replaces a customer's tags with exactly this set. Saying the same set again changes nothing. */
export async function setCustomerTags(context: StaffContext, patientId: string, tagIds: readonly string[]): Promise<Omit<CustomerTag, "count">[]> {
  requirePermission(context, "customers.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Tags need a database.");
  const wanted = [...new Set(tagIds)];
  return withTenant(context.tenantId, async (transaction) => {
    await loadVisibleCustomer(transaction, context, patientId, { lock: true });
    if (wanted.length > 0) {
      const known = await transaction.select({ id: customerTags.id }).from(customerTags).where(and(eq(customerTags.tenantId, context.tenantId), inArray(customerTags.id, wanted)));
      if (known.length !== wanted.length) throw new ApiError(400, "tag_not_found", "One of those tags no longer exists. Reload and try again.");
    }
    const current = (await transaction.select({ tagId: customerTagLinks.tagId }).from(customerTagLinks)
      .where(and(eq(customerTagLinks.tenantId, context.tenantId), eq(customerTagLinks.patientId, patientId)))).map((row) => row.tagId);
    const added = wanted.filter((id) => !current.includes(id));
    const removed = current.filter((id) => !wanted.includes(id));
    if (removed.length > 0) {
      await transaction.delete(customerTagLinks).where(and(eq(customerTagLinks.tenantId, context.tenantId), eq(customerTagLinks.patientId, patientId), inArray(customerTagLinks.tagId, removed)));
    }
    if (added.length > 0) {
      await transaction.insert(customerTagLinks).values(added.map((tagId) => ({ tenantId: context.tenantId, patientId, tagId, createdByUserId: context.userId }))).onConflictDoNothing();
    }
    if (added.length > 0 || removed.length > 0) {
      await auditCustomer(transaction, context, "customer.tags.changed", patientId, { added, removed });
    }
    const rows = wanted.length === 0 ? [] : await transaction.select({ id: customerTags.id, name: customerTags.name, color: customerTags.color }).from(customerTags)
      .where(and(eq(customerTags.tenantId, context.tenantId), inArray(customerTags.id, wanted))).orderBy(asc(customerTags.name));
    return rows.map((row) => ({ id: row.id, name: row.name, color: tagColorOf(row.color) }));
  });
}
