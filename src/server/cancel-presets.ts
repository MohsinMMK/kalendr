import { and, asc, eq, sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { profileWords } from "@/lib/terminology";
import { loadBusinessProfileIn } from "@/server/business-profile";
import { auditEvents, cancelNotePresets } from "@/db/schema";
import { MAX_CANCEL_PRESETS, type CancelPreset } from "@/lib/cancel-policy";
import { ApiError } from "@/server/api-error";
import { requirePermission, type StaffContext } from "@/server/staff-context";

/** The quick reasons staff pick when they cancel ("Doctor unwell"). Anyone who books can read them; managers edit them. */

function toPreset(row: { id: string; label: string; sortOrder: number }): CancelPreset {
  return { id: row.id, label: row.label, sortOrder: row.sortOrder };
}

export async function listCancelPresets(context: StaffContext): Promise<CancelPreset[]> {
  requirePermission(context, "appointments.book");
  if (context.preview) return [];
  return withTenant(context.tenantId, async (transaction) => {
    await seedDefaultPresets(transaction, context.tenantId);
    const rows = await transaction.select().from(cancelNotePresets)
      .where(eq(cancelNotePresets.tenantId, context.tenantId))
      .orderBy(asc(cancelNotePresets.sortOrder), asc(cancelNotePresets.label));
    return rows.map(toPreset);
  });
}

export async function createCancelPreset(context: StaffContext, input: { label: string }): Promise<CancelPreset> {
  requirePermission(context, "settings.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Reasons need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    // One lock per business keeps two people adding the twentieth reason at once from both succeeding.
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`cancel-presets:${context.tenantId}`}, 0))`);
    const existing = await transaction.select({ id: cancelNotePresets.id, sortOrder: cancelNotePresets.sortOrder }).from(cancelNotePresets).where(eq(cancelNotePresets.tenantId, context.tenantId));
    if (existing.length >= MAX_CANCEL_PRESETS) throw new ApiError(409, "too_many_presets", `You can keep up to ${MAX_CANCEL_PRESETS} cancellation reasons.`);
    const [created] = await transaction.insert(cancelNotePresets).values({
      tenantId: context.tenantId, label: input.label, sortOrder: existing.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1,
    }).onConflictDoNothing().returning();
    if (!created) throw new ApiError(409, "preset_exists", "You already have a reason with that name.", { label: ["You already have a reason with that name."] });
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "settings.cancel_preset.created", outcome: "success", metadata: { presetId: created.id },
    });
    return toPreset(created);
  });
}

export async function deleteCancelPreset(context: StaffContext, presetId: string): Promise<{ deleted: boolean }> {
  requirePermission(context, "settings.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Reasons need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    const removed = await transaction.delete(cancelNotePresets)
      .where(and(eq(cancelNotePresets.tenantId, context.tenantId), eq(cancelNotePresets.id, presetId))).returning({ id: cancelNotePresets.id });
    if (removed.length === 0) throw new ApiError(404, "preset_not_found", "That cancellation reason no longer exists.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "settings.cancel_preset.deleted", outcome: "success", metadata: { presetId },
    });
    return { deleted: true };
  });
}

/**
 * The two quick reasons the spec asks for, in the business's own words ("Doctor unwell", "Clinic closed"). They are
 * made once, the first time anyone reads the list, for a business that never had or removed reasons of its own:
 * deleting them all later does not bring them back, because the audit trail remembers a reason was removed.
 */
export async function seedDefaultPresets(transaction: KalendrTransaction, tenantId: string): Promise<void> {
  await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`cancel-presets:${tenantId}`}, 0))`);
  const [state] = await transaction.execute<{ presets: number; touched: boolean }>(sql`
    select (select count(*)::int from cancel_note_presets where tenant_id = ${tenantId}) as presets,
      exists (select 1 from audit_events where tenant_id = ${tenantId} and action in ('settings.cancel_preset.created', 'settings.cancel_preset.deleted', 'settings.cancel_preset.seeded')) as touched
  `);
  if (!state || state.presets > 0 || state.touched) return;
  const words = profileWords(await loadBusinessProfileIn(transaction, tenantId));
  await transaction.insert(cancelNotePresets).values([
    { tenantId, label: `${words.Practitioner} unwell`, sortOrder: 0 },
    { tenantId, label: `${words.Business} closed`, sortOrder: 1 },
  ]).onConflictDoNothing();
  await transaction.insert(auditEvents).values({ tenantId, actorType: "system", action: "settings.cancel_preset.seeded", outcome: "success", metadata: { count: 2 } });
}
