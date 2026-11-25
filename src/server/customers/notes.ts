import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { customerNotes } from "@/db/schema";
import type { CustomerNote } from "@/lib/customer-contracts";
import { ApiError } from "@/server/api-error";
import { claimKey, finishKey } from "@/server/idempotent";
import { can, requirePermission, type StaffContext } from "@/server/staff-context";

import { auditCustomer, loadVisibleCustomer } from "./access";

/**
 * Internal notes: attributed and dated. They are not clinical records (those live in the protected records area with
 * their own permission), and their text never goes into the audit trail.
 */

export const MAX_NOTES_PER_CUSTOMER = 500;

function toNote(row: typeof customerNotes.$inferSelect): CustomerNote {
  return {
    id: row.id,
    body: row.body,
    pinned: row.pinned,
    authorName: row.authorName,
    authorUserId: row.authorUserId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Pinned notes first, then newest first. */
export async function listNotes(context: StaffContext, patientId: string): Promise<CustomerNote[]> {
  if (context.preview) return [];
  return withTenant(context.tenantId, async (transaction) => {
    await loadVisibleCustomer(transaction, context, patientId);
    const rows = await transaction.select().from(customerNotes)
      .where(and(eq(customerNotes.tenantId, context.tenantId), eq(customerNotes.patientId, patientId)))
      .orderBy(desc(customerNotes.pinned), desc(customerNotes.createdAt), desc(customerNotes.id)).limit(MAX_NOTES_PER_CUSTOMER);
    return rows.map(toNote);
  });
}

/** Only one note per customer is pinned at the top of the profile: pinning another moves the pin. */
async function unpinOthers(transaction: Parameters<Parameters<typeof withTenant>[1]>[0], tenantId: string, patientId: string, keepId: string): Promise<void> {
  await transaction.execute(sql`update customer_notes set pinned = false, updated_at = now() where tenant_id = ${tenantId} and patient_id = ${patientId} and pinned and id <> ${keepId}`);
}

export async function createNote(context: StaffContext, patientId: string, input: { body: string; pinned: boolean }, idempotencyKey: string): Promise<CustomerNote> {
  requirePermission(context, "customers.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Notes need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    const claim = await claimKey<CustomerNote>(transaction, context.tenantId, "staff.customer.note.create", idempotencyKey, { patientId, input });
    if ("replay" in claim) return claim.replay;
    await loadVisibleCustomer(transaction, context, patientId, { lock: true });
    const [{ total } = { total: 0 }] = await transaction.execute<{ total: number }>(sql`select count(*)::int as total from customer_notes where tenant_id = ${context.tenantId} and patient_id = ${patientId}`);
    if (Number(total) >= MAX_NOTES_PER_CUSTOMER) throw new ApiError(409, "too_many_notes", "This profile has as many notes as it can hold. Delete an old one first.");
    const [created] = await transaction.insert(customerNotes).values({
      tenantId: context.tenantId, patientId, authorUserId: context.userId, authorName: context.userName.slice(0, 120), body: input.body, pinned: input.pinned,
    }).returning();
    if (!created) throw new Error("Note insert did not return a row");
    if (input.pinned) await unpinOthers(transaction, context.tenantId, patientId, created.id);
    await auditCustomer(transaction, context, "customer.note.created", patientId, { noteId: created.id, pinned: input.pinned });
    const note = toNote(created);
    await finishKey(transaction, claim.claimId, note);
    return note;
  });
}

export async function updateNote(
  context: StaffContext,
  patientId: string,
  noteId: string,
  input: { body?: string; pinned?: boolean; version: number },
): Promise<CustomerNote> {
  requirePermission(context, "customers.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Notes need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    await loadVisibleCustomer(transaction, context, patientId);
    const [existing] = await transaction.select().from(customerNotes)
      .where(and(eq(customerNotes.tenantId, context.tenantId), eq(customerNotes.patientId, patientId), eq(customerNotes.id, noteId))).for("update");
    if (!existing) throw new ApiError(404, "note_not_found", "That note no longer exists.");
    if (existing.version !== input.version) throw new ApiError(409, "version_conflict", "Someone changed this note. Reload it and try again.");
    // Anyone who manages customers may pin; only the author or a manager changes the words.
    if (input.body !== undefined && existing.authorUserId !== context.userId && !can(context, "settings.manage")) {
      throw new ApiError(403, "forbidden", "Only the person who wrote a note, or a manager, can change its words.");
    }
    const [updated] = await transaction.update(customerNotes).set({
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      version: existing.version + 1,
      updatedAt: new Date(),
    }).where(and(eq(customerNotes.tenantId, context.tenantId), eq(customerNotes.id, noteId))).returning();
    if (!updated) throw new ApiError(404, "note_not_found", "That note no longer exists.");
    if (input.pinned) await unpinOthers(transaction, context.tenantId, patientId, noteId);
    await auditCustomer(transaction, context, "customer.note.updated", patientId, { noteId, textChanged: input.body !== undefined, pinned: updated.pinned });
    return toNote(updated);
  });
}

export async function deleteNote(context: StaffContext, patientId: string, noteId: string): Promise<{ deleted: true }> {
  requirePermission(context, "customers.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Notes need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    await loadVisibleCustomer(transaction, context, patientId);
    const [existing] = await transaction.select({ authorUserId: customerNotes.authorUserId }).from(customerNotes)
      .where(and(eq(customerNotes.tenantId, context.tenantId), eq(customerNotes.patientId, patientId), eq(customerNotes.id, noteId))).for("update");
    if (!existing) throw new ApiError(404, "note_not_found", "That note no longer exists.");
    if (existing.authorUserId !== context.userId && !can(context, "settings.manage")) {
      throw new ApiError(403, "forbidden", "Only the person who wrote a note, or a manager, can delete it.");
    }
    await transaction.delete(customerNotes).where(and(eq(customerNotes.tenantId, context.tenantId), eq(customerNotes.id, noteId)));
    await auditCustomer(transaction, context, "customer.note.deleted", patientId, { noteId });
    return { deleted: true };
  });
}
