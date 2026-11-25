import "server-only";

import { sql } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import { auditEvents } from "@/db/schema";
import { profileWords, type TermWords } from "@/lib/terminology";
import { ApiError } from "@/server/api-error";
import { loadBusinessProfileIn } from "@/server/business-profile";
import { customerVisibleHere } from "@/server/location-scope";
import { can, type StaffContext } from "@/server/staff-context";

export async function customerWords(transaction: KalendrTransaction, tenantId: string): Promise<TermWords> {
  return profileWords(await loadBusinessProfileIn(transaction, tenantId));
}

export function customerNotFound(words: Pick<TermWords, "customer">): ApiError {
  return new ApiError(404, "customer_not_found", `We could not find that ${words.customer}.`);
}

export interface VisibleCustomer {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  dateOfBirth: string | null;
  blockedAt: Date | null;
  mergedIntoId: string | null;
  erasedAt: Date | null;
}

interface PatientRow extends Record<string, unknown> {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  date_of_birth: string | null;
  blocked_at: Date | string | null;
  merged_into_id: string | null;
  erased_at: Date | string | null;
}

/**
 * Loads one customer for a staff member and refuses when they may not see them: a person who sees only their own
 * customers (a practitioner) is refused unless they have had a visit with this one. A merged-away profile reads as
 * missing, so it can never be opened or changed by a stale link.
 */
export async function loadVisibleCustomer(
  transaction: KalendrTransaction,
  context: StaffContext,
  patientId: string,
  options: { lock?: boolean; allowMerged?: boolean } = {},
): Promise<VisibleCustomer> {
  const rows = await transaction.execute<PatientRow>(sql`
    select id, first_name, last_name, phone, email, date_of_birth, blocked_at, merged_into_id, erased_at
    from patients where tenant_id = ${context.tenantId} and id = ${patientId}
    ${options.lock ? sql`for update` : sql``}
  `);
  const row = rows[0];
  if (!row || (row.merged_into_id && !options.allowMerged)) throw customerNotFound(await customerWords(transaction, context.tenantId));
  if (context.role === "practitioner") {
    const [own] = await transaction.execute<{ id: string }>(sql`
      select appointment.id from appointments as appointment
      join practitioners as practitioner on practitioner.tenant_id = appointment.tenant_id and practitioner.id = appointment.practitioner_id
      where appointment.tenant_id = ${context.tenantId} and appointment.patient_id = ${patientId} and practitioner.auth_user_id = ${context.userId}
      limit 1
    `);
    if (!own) throw customerNotFound(await customerWords(transaction, context.tenantId));
  }
  // Someone limited to some locations opens only the customers seen at those locations (or not seen anywhere yet).
  if (!(await customerVisibleHere(transaction, context, patientId))) throw customerNotFound(await customerWords(transaction, context.tenantId));
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    email: row.email,
    dateOfBirth: row.date_of_birth,
    blockedAt: row.blocked_at ? new Date(row.blocked_at) : null,
    mergedIntoId: row.merged_into_id,
    erasedAt: row.erased_at ? new Date(row.erased_at) : null,
  };
}

/** Who may read money on a profile: the same people who may take payments. */
export function canSeeMoney(context: Pick<StaffContext, "permissions">): boolean {
  return can(context, "payments.collect") || can(context, "invoices.issue");
}

/** One audit row for a customer change. The customer's id goes in, never their name, contact or a note's text. */
export async function auditCustomer(
  transaction: KalendrTransaction,
  context: Pick<StaffContext, "tenantId" | "userId">,
  action: string,
  patientId: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await transaction.insert(auditEvents).values({
    tenantId: context.tenantId,
    actorUserId: context.userId,
    actorType: "staff",
    action,
    outcome: "success",
    metadata: { ...(patientId ? { patientId } : {}), ...metadata },
  });
}
