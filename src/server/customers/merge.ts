import "server-only";

import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { customerMerges } from "@/db/schema";
import { UNDO_WINDOW_DAYS, type DuplicatePair, type MergeResult } from "@/lib/customer-contracts";
import { ApiError } from "@/server/api-error";
import { claimKey, finishKey } from "@/server/idempotent";
import { visibleCustomerCondition } from "@/server/location-scope";
import { openSecret, sealSecret, secretKeyVersion } from "@/server/keys/secrets";
import { loadRecordKeys } from "@/server/record-crypto";
import { assertNotReadOnlyImpersonation, requirePermission, requireRecentStepUp, type StaffContext } from "@/server/staff-context";

import { auditCustomer, customerNotFound, customerWords, loadVisibleCustomer } from "./access";

/**
 * Merging two profiles of the same person (feature 27).
 *
 * Everything that can be edited moves to the kept profile in one transaction: appointments, repeating series, forms,
 * recalls, waitlist places, packages, memberships, records, the inbox thread, notes, tags and extra fields. Money rows
 * (payments, invoices, coupon uses) are never edited, so they stay where they were written; every figure that reads a
 * customer's money follows `patients.merged_into_id`, which makes them part of the kept profile at once. Consent
 * records are never edited either: the kept profile keeps its own answers, and the merged one's are not carried over.
 *
 * The merged profile's own details (phone, email) are sealed into a snapshot with the ids of everything that moved,
 * which is what lets staff undo the merge for 30 days. After that a daily job drops the snapshot.
 */

/** Tables whose rows are moved by id. Fixed names, never from input. */
const MOVE_TABLES = [
  "appointments", "appointment_series", "booking_reports", "customer_memberships", "customer_packages", "forms",
  "push_subscriptions", "recalls", "visit_records", "waitlist_entries", "customer_notes",
] as const;

/** Moved only where the kept profile does not already have the same row (a thread per channel, a seat per session). */
const GUARDED_TABLES: Record<string, (kept: string) => SQL> = {
  message_threads: (kept) => sql`not exists (select 1 from message_threads as other where other.tenant_id = message_threads.tenant_id and other.patient_id = ${kept} and other.channel = message_threads.channel)`,
  class_enrolments: (kept) => sql`not exists (select 1 from class_enrolments as other where other.tenant_id = class_enrolments.tenant_id and other.patient_id = ${kept} and other.session_id = class_enrolments.session_id)`,
};

const snapshotSchema = z.object({
  merged: z.object({ phone: z.string(), email: z.string() }),
  moved: z.record(z.string(), z.array(z.string())),
  tagsAdded: z.array(z.string()),
  fieldsAdded: z.array(z.string()),
  keptBefore: z.object({ dateOfBirth: z.string().nullable(), blockedAt: z.string().nullable(), blockReason: z.string().nullable(), blockedByUserId: z.string().nullable() }),
});
type Snapshot = z.infer<typeof snapshotSchema>;

interface PatientRow extends Record<string, unknown> {
  id: string;
  phone: string;
  email: string;
  date_of_birth: string | null;
  blocked_at: Date | string | null;
  block_reason: string | null;
  blocked_by_user_id: string | null;
  merged_into_id: string | null;
  erased_at: Date | string | null;
  is_test: boolean;
}

async function moveRows(transaction: KalendrTransaction, tenantId: string, table: string, from: string, to: string, guard?: SQL): Promise<string[]> {
  const rows = await transaction.execute<{ id: string }>(sql`
    update ${sql.raw(`"${table}"`)} set patient_id = ${to}
    where tenant_id = ${tenantId} and patient_id = ${from} ${guard ? sql`and ${guard}` : sql``}
    returning id
  `);
  return rows.map((row) => row.id);
}

export async function mergeCustomers(context: StaffContext, input: { keepId: string; mergeId: string }, idempotencyKey: string): Promise<MergeResult> {
  assertNotReadOnlyImpersonation(context);
  requirePermission(context, "customers.merge");
  requireRecentStepUp(context);
  if (context.preview) throw new ApiError(400, "preview_only", "Merging needs a database.");
  return withTenant(context.tenantId, async (transaction) => {
    const claim = await claimKey<MergeResult>(transaction, context.tenantId, "staff.customer.merge", idempotencyKey, input);
    if ("replay" in claim) return claim.replay;
    const words = await customerWords(transaction, context.tenantId);
    // Lock in a fixed order, so two people merging the same pair from opposite ends cannot deadlock.
    const locked = await transaction.execute<PatientRow>(sql`
      select id, phone, email, date_of_birth, blocked_at, block_reason, blocked_by_user_id, merged_into_id, erased_at, is_test
      from patients where tenant_id = ${context.tenantId} and id in (${input.keepId}, ${input.mergeId}) order by id for update
    `);
    const kept = locked.find((row) => row.id === input.keepId);
    const merged = locked.find((row) => row.id === input.mergeId);
    if (!kept || !merged) throw customerNotFound(words);
    // Both profiles must be ones this person can open: a branch-limited person can't merge in a customer from another branch.
    // A merged-away side is let through here so the 409 below still answers it.
    await loadVisibleCustomer(transaction, context, kept.id, { allowMerged: true });
    await loadVisibleCustomer(transaction, context, merged.id, { allowMerged: true });
    if (kept.merged_into_id || merged.merged_into_id) throw new ApiError(409, "already_merged", `One of these ${words.customers} was already merged into another profile. Reload and try again.`);
    if (kept.erased_at || merged.erased_at) throw new ApiError(409, "customer_erased", `A ${words.customer} whose data was erased can't be merged.`);
    if (kept.is_test !== merged.is_test) throw new ApiError(409, "test_customer", `A sample ${words.customer} can't be merged with a real one.`);

    await loadRecordKeys(transaction, context.tenantId, { forWrite: true });
    const moved: Record<string, string[]> = {};
    for (const table of MOVE_TABLES) moved[table] = await moveRows(transaction, context.tenantId, table, merged.id, kept.id);
    for (const [table, guard] of Object.entries(GUARDED_TABLES)) moved[table] = await moveRows(transaction, context.tenantId, table, merged.id, kept.id, guard(kept.id));

    const tagsAdded = (await transaction.execute<{ tag_id: string }>(sql`
      insert into customer_tag_links (tenant_id, patient_id, tag_id, created_by_user_id)
      select tenant_id, ${kept.id}, tag_id, ${context.userId} from customer_tag_links where tenant_id = ${context.tenantId} and patient_id = ${merged.id}
      on conflict do nothing returning tag_id
    `)).map((row) => row.tag_id);
    const fieldsAdded = (await transaction.execute<{ field_id: string }>(sql`
      insert into customer_field_values (tenant_id, patient_id, field_id, value, updated_by_user_id)
      select tenant_id, ${kept.id}, field_id, value, ${context.userId} from customer_field_values where tenant_id = ${context.tenantId} and patient_id = ${merged.id}
      on conflict do nothing returning field_id
    `)).map((row) => row.field_id);

    // The kept profile adopts a birth date it lacked, and a block from either side (a block is a safety signal, never dropped by a merge).
    const adoptBlock = !kept.blocked_at && merged.blocked_at;
    await transaction.execute(sql`
      update patients set
        date_of_birth = coalesce(date_of_birth, ${merged.date_of_birth}::date),
        ${adoptBlock ? sql`blocked_at = ${merged.blocked_at ? new Date(merged.blocked_at).toISOString() : null}::timestamptz, block_reason = ${merged.block_reason}, blocked_by_user_id = ${merged.blocked_by_user_id},` : sql``}
        updated_at = now()
      where tenant_id = ${context.tenantId} and id = ${kept.id}
    `);
    // The merged row stays (its consents and money cannot move) but loses its contact details, so it is never found again as a returning customer.
    await transaction.execute(sql`
      update patients set merged_into_id = ${kept.id}, merged_at = now(), phone = '', email = ${`merged-${merged.id}@merged.invalid`}, updated_at = now()
      where tenant_id = ${context.tenantId} and id = ${merged.id}
    `);

    const snapshot: Snapshot = {
      merged: { phone: merged.phone, email: merged.email },
      moved, tagsAdded, fieldsAdded,
      keptBefore: { dateOfBirth: kept.date_of_birth, blockedAt: kept.blocked_at ? new Date(kept.blocked_at).toISOString() : null, blockReason: kept.block_reason, blockedByUserId: kept.blocked_by_user_id },
    };
    const sealed = sealSecret(context.tenantId, "customer.merge-snapshot", JSON.stringify(snapshot));
    const undoUntil = new Date(Date.now() + UNDO_WINDOW_DAYS * 86_400_000);
    const [merge] = await transaction.insert(customerMerges).values({
      tenantId: context.tenantId, keptPatientId: kept.id, mergedPatientId: merged.id, mergedByUserId: context.userId,
      undoUntil, snapshotCiphertext: sealed, snapshotKeyVersion: secretKeyVersion(sealed),
    }).returning({ id: customerMerges.id });
    if (!merge) throw new Error("Merge insert did not return a row");

    const [counts] = await transaction.execute<{ payments: number; invoices: number }>(sql`
      select
        (select count(*)::int from payments as p left join appointments as a on a.tenant_id = p.tenant_id and a.id = p.appointment_id
          where p.tenant_id = ${context.tenantId} and not p.is_test and (p.patient_id = ${merged.id} or p.appointment_id in (select jsonb_array_elements_text(${JSON.stringify(moved.appointments ?? [])}::jsonb)))) as payments,
        (select count(*)::int from invoices where tenant_id = ${context.tenantId} and patient_id = ${merged.id}) as invoices
    `);
    const result: MergeResult = {
      mergeId: merge.id, keptId: kept.id, undoUntil: undoUntil.toISOString(),
      moved: {
        appointments: moved.appointments?.length ?? 0,
        payments: Number(counts?.payments ?? 0),
        invoices: Number(counts?.invoices ?? 0),
        other: Object.entries(moved).filter(([table]) => table !== "appointments").reduce((total, [, ids]) => total + ids.length, 0),
      },
    };
    await auditCustomer(transaction, context, "customer.merged", kept.id, { mergeId: merge.id, mergedId: merged.id, moved: result.moved });
    await finishKey(transaction, claim.claimId, result);
    return result;
  });
}

export async function undoMerge(context: StaffContext, mergeId: string): Promise<{ restoredId: string }> {
  assertNotReadOnlyImpersonation(context);
  requirePermission(context, "customers.merge");
  requireRecentStepUp(context);
  if (context.preview) throw new ApiError(400, "preview_only", "Merging needs a database.");
  return withTenant(context.tenantId, async (transaction) => {
    const [merge] = await transaction.select().from(customerMerges)
      .where(and(eq(customerMerges.tenantId, context.tenantId), eq(customerMerges.id, mergeId))).for("update");
    if (!merge) throw new ApiError(404, "merge_not_found", "We could not find that merge.");
    if (merge.undoneAt) throw new ApiError(409, "merge_undone", "This merge was already undone.");
    if (merge.undoUntil.getTime() < Date.now() || !merge.snapshotCiphertext) {
      throw new ApiError(410, "undo_expired", `A merge can be undone for ${UNDO_WINDOW_DAYS} days. That time has passed.`);
    }
    await loadRecordKeys(transaction, context.tenantId, { forWrite: true });
    let snapshot: Snapshot;
    try {
      snapshot = snapshotSchema.parse(JSON.parse(openSecret(context.tenantId, "customer.merge-snapshot", merge.snapshotCiphertext)));
    } catch {
      throw new ApiError(500, "snapshot_unreadable", "This merge can't be undone because its saved details could not be read.");
    }
    const rows = await transaction.execute<PatientRow>(sql`
      select id, phone, email, date_of_birth, blocked_at, block_reason, blocked_by_user_id, merged_into_id, erased_at, is_test
      from patients where tenant_id = ${context.tenantId} and id in (${merge.keptPatientId}, ${merge.mergedPatientId}) order by id for update
    `);
    const mergedRow = rows.find((row) => row.id === merge.mergedPatientId);
    if (!mergedRow || mergedRow.merged_into_id !== merge.keptPatientId) {
      throw new ApiError(409, "merge_changed", "This profile was merged again since. Undo the later merge first.");
    }
    // Only rows still on the kept profile go back: one that moved on again since stays where staff last put it.
    for (const [table, ids] of Object.entries(snapshot.moved)) {
      if (ids.length === 0) continue;
      if (!([...MOVE_TABLES, ...Object.keys(GUARDED_TABLES)] as string[]).includes(table)) continue;
      await transaction.execute(sql`
        update ${sql.raw(`"${table}"`)} set patient_id = ${merge.mergedPatientId}
        where tenant_id = ${context.tenantId} and patient_id = ${merge.keptPatientId} and id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
      `);
    }
    if (snapshot.tagsAdded.length > 0) {
      await transaction.execute(sql`delete from customer_tag_links where tenant_id = ${context.tenantId} and patient_id = ${merge.keptPatientId} and tag_id in (select jsonb_array_elements_text(${JSON.stringify(snapshot.tagsAdded)}::jsonb))`);
    }
    if (snapshot.fieldsAdded.length > 0) {
      await transaction.execute(sql`delete from customer_field_values where tenant_id = ${context.tenantId} and patient_id = ${merge.keptPatientId} and field_id in (select jsonb_array_elements_text(${JSON.stringify(snapshot.fieldsAdded)}::jsonb))`);
    }
    await transaction.execute(sql`
      update patients set merged_into_id = null, merged_at = null, phone = ${snapshot.merged.phone}, email = ${snapshot.merged.email}, updated_at = now()
      where tenant_id = ${context.tenantId} and id = ${merge.mergedPatientId}
    `);
    // The kept profile gets back the birth date and block it had before.
    await transaction.execute(sql`
      update patients set date_of_birth = ${snapshot.keptBefore.dateOfBirth}::date,
        blocked_at = ${snapshot.keptBefore.blockedAt}::timestamptz, block_reason = ${snapshot.keptBefore.blockReason}, blocked_by_user_id = ${snapshot.keptBefore.blockedByUserId}, updated_at = now()
      where tenant_id = ${context.tenantId} and id = ${merge.keptPatientId}
    `);
    await transaction.update(customerMerges).set({ undoneAt: new Date(), undoneByUserId: context.userId, snapshotCiphertext: null })
      .where(and(eq(customerMerges.tenantId, context.tenantId), eq(customerMerges.id, mergeId)));
    await auditCustomer(transaction, context, "customer.merge.undone", merge.keptPatientId, { mergeId, restoredId: merge.mergedPatientId });
    return { restoredId: merge.mergedPatientId };
  });
}

interface PairRow extends Record<string, unknown> {
  a_id: string;
  b_id: string;
  reasons: string[];
}

interface SideRow extends Record<string, unknown> {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  date_of_birth: string | null;
  visits: number;
  last_visit: Date | string | null;
}

/**
 * Pairs that look like the same person: the same phone number or email (never for a dependant, who shares a parent's),
 * or a similar name with the same birth date. Each rule is a join on equal keys, so it stays fast on a large list.
 */
export async function suggestDuplicates(context: StaffContext, limit = 30): Promise<DuplicatePair[]> {
  requirePermission(context, "customers.manage");
  if (context.preview) return [];
  return withTenant(context.tenantId, async (transaction) => {
    const live = (alias: string) => sql.raw(`${alias}.tenant_id = '${context.tenantId.replace(/'/g, "''")}' and ${alias}.merged_into_id is null and ${alias}.erased_at is null and not ${alias}.is_test`);
    // A branch-limited person is only offered pairs where both profiles are customers they can open.
    const visibleA = visibleCustomerCondition(context, sql`candidates.a_id`);
    const visibleB = visibleCustomerCondition(context, sql`candidates.b_id`);
    const visiblePair = visibleA && visibleB ? sql`${visibleA} and ${visibleB}` : null;
    const pairs = await transaction.execute<PairRow>(sql`
      with phone_key as (
        select id, right(regexp_replace(phone, '\\D', '', 'g'), 10) as key from patients as p
        where ${live("p")} and not is_dependent and length(regexp_replace(phone, '\\D', '', 'g')) >= 7
      ), candidates as (
        select a.id as a_id, b.id as b_id, 'Same phone number' as reason from phone_key as a join phone_key as b on a.key = b.key and a.id < b.id
        union all
        select a.id, b.id, 'Same email address' from patients as a join patients as b on lower(a.email) = lower(b.email) and a.id < b.id and a.tenant_id = b.tenant_id
        where ${live("a")} and ${live("b")} and a.email <> '' and not a.is_dependent and not b.is_dependent and a.email not like '%@merged.invalid'
        union all
        select a.id, b.id, 'Similar name and the same birth date' from patients as a join patients as b on a.date_of_birth = b.date_of_birth and a.id < b.id and a.tenant_id = b.tenant_id
        where ${live("a")} and ${live("b")} and a.date_of_birth is not null
          and similarity(lower(a.first_name || ' ' || a.last_name), lower(b.first_name || ' ' || b.last_name)) >= 0.55
      )
      select a_id, b_id, array_agg(distinct reason) as reasons from candidates
      where true ${visiblePair ? sql`and ${visiblePair}` : sql``}
      group by a_id, b_id order by count(distinct reason) desc, a_id limit ${limit}
    `);
    if (pairs.length === 0) return [];
    const ids = [...new Set(pairs.flatMap((pair) => [pair.a_id, pair.b_id]))];
    const sides = await transaction.execute<SideRow>(sql`
      select p.id, p.first_name, p.last_name, p.phone, p.email, p.date_of_birth,
        (select count(*)::int from appointments as a where a.tenant_id = p.tenant_id and a.patient_id = p.id and a.status = 'completed') as visits,
        (select max(a.starts_at) from appointments as a where a.tenant_id = p.tenant_id and a.patient_id = p.id and a.status = 'completed') as last_visit
      from patients as p where p.tenant_id = ${context.tenantId} and p.id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
    `);
    const byId = new Map(sides.map((row) => [row.id, {
      id: row.id, name: `${row.first_name} ${row.last_name}`.trim(), phone: row.phone, email: row.email, dateOfBirth: row.date_of_birth,
      visits: Number(row.visits), lastVisitAt: row.last_visit ? new Date(row.last_visit).toISOString() : null,
    }]));
    return pairs.flatMap((pair) => {
      const a = byId.get(pair.a_id);
      const b = byId.get(pair.b_id);
      return a && b ? [{ reasons: pair.reasons, a, b }] : [];
    });
  });
}
