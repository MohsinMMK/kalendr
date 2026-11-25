import "server-only";

import { and, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";

import { withTenant } from "@/db/client";
import { auditEvents, handoverNotes } from "@/db/schema";

import { ApiError } from "./api-error";
import { can, type StaffContext } from "./staff-context";

/** How far back Today looks for notes from earlier shifts. */
const HANDOVER_WINDOW_MS = 48 * 60 * 60 * 1000;

export const handoverNoteInputSchema = z.object({
  body: z.string().trim().min(1).max(280),
});

export interface HandoverNoteView {
  id: string;
  text: string;
  author: string;
  at: string;
  /** Whether the person asking may remove it: its author, or an owner or admin. */
  canRemove: boolean;
}

function requireDeskAccess(context: StaffContext): void {
  if (!can(context, "appointments.status") && !can(context, "appointments.book")) {
    throw new ApiError(403, "forbidden", "You don't have permission to write handover notes.");
  }
}

function canRemove(context: StaffContext, authorUserId: string | null): boolean {
  return context.role === "owner" || context.role === "admin" || (authorUserId !== null && authorUserId === context.userId);
}

/** Notes from the last two days, newest first. */
export async function listHandoverNotes(context: StaffContext): Promise<HandoverNoteView[]> {
  if (context.preview) return [];
  const since = new Date(Date.now() - HANDOVER_WINDOW_MS);
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.select().from(handoverNotes)
      .where(and(eq(handoverNotes.tenantId, context.tenantId), gte(handoverNotes.createdAt, since)))
      .orderBy(desc(handoverNotes.createdAt))
      .limit(50);
    return rows.map((row) => ({
      id: row.id, text: row.body, author: row.authorName, at: row.createdAt.toISOString(),
      canRemove: canRemove(context, row.authorUserId),
    }));
  });
}

export async function addHandoverNote(context: StaffContext, input: z.infer<typeof handoverNoteInputSchema>): Promise<HandoverNoteView> {
  requireDeskAccess(context);
  if (context.preview) {
    return { id: crypto.randomUUID(), text: input.body, author: context.userName, at: new Date().toISOString(), canRemove: true };
  }
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.insert(handoverNotes).values({
      tenantId: context.tenantId, authorUserId: context.userId, authorName: context.userName.slice(0, 120), body: input.body,
    }).returning();
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
      action: "handover.note_added", outcome: "success", metadata: { noteId: row.id },
    });
    return { id: row.id, text: row.body, author: row.authorName, at: row.createdAt.toISOString(), canRemove: true };
  });
}

export async function removeHandoverNote(context: StaffContext, id: string): Promise<{ id: string }> {
  requireDeskAccess(context);
  if (context.preview) return { id };
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.select().from(handoverNotes)
      .where(and(eq(handoverNotes.tenantId, context.tenantId), eq(handoverNotes.id, id)));
    if (!row) throw new ApiError(404, "handover_note_not_found", "That handover note is already gone.");
    if (!canRemove(context, row.authorUserId)) {
      throw new ApiError(403, "forbidden", "Only the note's author, the owner or an admin can remove it.");
    }
    await transaction.delete(handoverNotes).where(and(eq(handoverNotes.tenantId, context.tenantId), eq(handoverNotes.id, id)));
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
      action: "handover.note_removed", outcome: "success", metadata: { noteId: id },
    });
    return { id };
  });
}
