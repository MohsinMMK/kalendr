import "server-only";

import { eq, sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents, tenants } from "@/db/schema";
import { EMAIL_CODE_MINUTES } from "@/lib/booking-intake";
import type { ReplyToInput, ReplyToView } from "@/lib/reply-to";

import { ApiError } from "./api-error";
import { checkCodeIn, queueCodeIn } from "./email-check";
import { type StaffContext, requirePermission } from "./staff-context";

/**
 * The address customers' replies to confirmation emails reach (feature 50). Setting one sends a 6-digit code to it through
 * the outbox (the same check the booking page uses); only the right code stores it, so a typo can never send replies
 * into the void or to a stranger. The old address keeps working until the new one is proved. The address is never logged
 * and never put in audit metadata.
 */

export async function getReplyTo(context: StaffContext): Promise<ReplyToView> {
  requirePermission(context, "settings.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.select({ email: tenants.replyToEmail, verifiedAt: tenants.replyToVerifiedAt }).from(tenants).where(eq(tenants.id, context.tenantId));
    return { email: row?.email ?? null, verifiedAt: row?.verifiedAt?.toISOString() ?? null };
  });
}

export async function sendReplyToCode(context: StaffContext, email: string): Promise<{ sent: true; expiresInMinutes: number }> {
  requirePermission(context, "settings.manage");
  await withTenant(context.tenantId, async (transaction) => {
    await queueCodeIn(transaction, context.tenantId, email);
    await transaction.insert(auditEvents).values({ tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "reply_to.code_sent", outcome: "success", metadata: {} });
  });
  return { sent: true, expiresInMinutes: EMAIL_CODE_MINUTES };
}

export async function verifyReplyTo(context: StaffContext, email: string, code: string): Promise<ReplyToView> {
  requirePermission(context, "settings.manage");
  // A wrong guess is counted and kept, so this commits first and refuses after.
  const outcome = await withTenant(context.tenantId, async (transaction) => {
    const checked = await checkCodeIn(transaction, context.tenantId, email, code);
    if (checked.kind === "ok") {
      await transaction.update(tenants).set({ replyToEmail: email.trim().toLowerCase(), replyToVerifiedAt: new Date() }).where(eq(tenants.id, context.tenantId));
      await transaction.insert(auditEvents).values({ tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "reply_to.verified", outcome: "success", metadata: {} });
    }
    return checked.kind;
  });
  if (outcome === "locked") throw new ApiError(429, "too_many_attempts", "Too many wrong codes. Ask for a new code and try again.");
  if (outcome !== "ok") throw new ApiError(400, "invalid_code", "That code isn't right or has expired. Check it, or ask for a new one.");
  return getReplyTo(context);
}

export async function clearReplyTo(context: StaffContext): Promise<ReplyToView> {
  requirePermission(context, "settings.manage");
  await withTenant(context.tenantId, async (transaction) => {
    await transaction.execute(sql`update tenants set reply_to_email = null, reply_to_verified_at = null where id = ${context.tenantId}`);
    await transaction.insert(auditEvents).values({ tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "reply_to.removed", outcome: "success", metadata: {} });
  });
  return { email: null, verifiedAt: null };
}

export async function applyReplyTo(context: StaffContext, input: ReplyToInput): Promise<{ sent: true; expiresInMinutes: number } | ReplyToView> {
  return input.action === "send" ? sendReplyToCode(context, input.email) : verifyReplyTo(context, input.email, input.code);
}
