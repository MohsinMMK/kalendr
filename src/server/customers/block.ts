import "server-only";

import { and, eq } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { patients } from "@/db/schema";
import { ApiError } from "@/server/api-error";
import { requirePermission, type StaffContext } from "@/server/staff-context";
import type { KalendrTransaction } from "@/db/client";
import { sql } from "drizzle-orm";

import { auditCustomer, customerWords, loadVisibleCustomer } from "./access";

/**
 * A blocked customer cannot book online: the booking page says "please call us". Staff still see them, and can still
 * book them at the desk, so a block is a signal and not a deletion. The reason is stored on the profile and shown to
 * staff; it is never copied into the audit trail.
 */
export async function blockCustomer(context: StaffContext, patientId: string, reason: string): Promise<{ blockedAt: string }> {
  requirePermission(context, "customers.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Blocking needs a database.");
  return withTenant(context.tenantId, async (transaction) => {
    const customer = await loadVisibleCustomer(transaction, context, patientId, { lock: true });
    const now = new Date();
    const blockedAt = customer.blockedAt ?? now;
    await transaction.update(patients)
      .set({ blockedAt, blockReason: reason, blockedByUserId: customer.blockedAt ? undefined : context.userId, updatedAt: now })
      .where(and(eq(patients.tenantId, context.tenantId), eq(patients.id, patientId)));
    // Blocking twice only updates the reason; the first block's time and person stay.
    if (!customer.blockedAt) await auditCustomer(transaction, context, "customer.blocked", patientId);
    return { blockedAt: blockedAt.toISOString() };
  });
}

export async function unblockCustomer(context: StaffContext, patientId: string): Promise<{ blockedAt: null }> {
  requirePermission(context, "customers.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Blocking needs a database.");
  return withTenant(context.tenantId, async (transaction) => {
    const customer = await loadVisibleCustomer(transaction, context, patientId, { lock: true });
    if (customer.blockedAt) {
      await transaction.update(patients).set({ blockedAt: null, blockReason: null, blockedByUserId: null, updatedAt: new Date() })
        .where(and(eq(patients.tenantId, context.tenantId), eq(patients.id, patientId)));
      await auditCustomer(transaction, context, "customer.unblocked", patientId);
    }
    return { blockedAt: null };
  });
}

/**
 * Called inside a public booking, before anything is kept: throws when the contact belongs to a blocked customer.
 * It matches the same email and phone a returning customer is found by, so a block cannot be dodged with a new name.
 */
export async function assertNotBlocked(transaction: KalendrTransaction, tenantId: string, contact: { email?: string | null; phone?: string | null }): Promise<void> {
  const email = contact.email?.trim().toLowerCase() ?? "";
  const digits = (contact.phone ?? "").replace(/\D/g, "");
  if (!email && digits.length < 6) return;
  const rows = await transaction.execute<{ id: string }>(sql`
    select id from patients
    where tenant_id = ${tenantId} and blocked_at is not null and merged_into_id is null and erased_at is null
      and ((${email} <> '' and lower(email) = ${email})
        or (${digits.length >= 6} and right(regexp_replace(phone, '\\D', '', 'g'), 10) = right(${digits}, 10)))
    limit 1
  `);
  if (rows.length > 0) {
    const words = await customerWords(transaction, tenantId);
    throw new ApiError(403, "customer_blocked", `We can't take this booking online. Please call us to book your ${words.appointment}.`);
  }
}
