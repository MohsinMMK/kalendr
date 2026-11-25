import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import { customerFieldValues } from "@/db/schema";
import { convertFieldValue, encodeMultiValue, parseMultiValue, type FieldShape } from "@/lib/customer-field-values";

const BATCH = 1_000;

/** A stored choice or multiple-choice value after the owner renamed some options. Other kinds are left alone. */
function renamed(kind: FieldShape["kind"], stored: string, renames: Record<string, string>): string {
  if (kind === "choice") return renames[stored] ?? stored;
  if (kind !== "multichoice") return stored;
  const picked = parseMultiValue(stored).map((choice) => renames[choice] ?? choice);
  return encodeMultiValue([...new Set(picked)]);
}

function chunks<T>(items: T[]): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += BATCH) batches.push(items.slice(index, index + BATCH));
  return batches;
}

/**
 * Rewrites every stored value of one field after its kind or choices changed: renames first (so a renamed option keeps its
 * people), then the kind conversion. A value that no longer fits is deleted. The caller holds the definition row locked, and
 * setting values reads that row `for share`, so nothing can write an old-shaped value meanwhile. Returns how many were cleared.
 */
export async function convertStoredValues(
  transaction: KalendrTransaction,
  tenantId: string,
  fieldId: string,
  from: FieldShape,
  to: FieldShape,
  renames: Record<string, string>,
): Promise<number> {
  const rows = await transaction.select({ patientId: customerFieldValues.patientId, value: customerFieldValues.value }).from(customerFieldValues)
    .where(and(eq(customerFieldValues.tenantId, tenantId), eq(customerFieldValues.fieldId, fieldId)));
  const changed: { patient_id: string; value: string }[] = [];
  const cleared: string[] = [];
  for (const row of rows) {
    const next = convertFieldValue(from, to, renamed(from.kind, row.value, renames));
    if (next === null) cleared.push(row.patientId);
    else if (next !== row.value) changed.push({ patient_id: row.patientId, value: next });
  }
  for (const batch of chunks(cleared)) {
    await transaction.delete(customerFieldValues)
      .where(and(eq(customerFieldValues.tenantId, tenantId), eq(customerFieldValues.fieldId, fieldId), inArray(customerFieldValues.patientId, batch)));
  }
  for (const batch of chunks(changed)) {
    await transaction.execute(sql`
      update customer_field_values as stored set value = changes.value, updated_at = now()
      from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) as changes(patient_id text, value text)
      where stored.tenant_id = ${tenantId} and stored.field_id = ${fieldId} and stored.patient_id = changes.patient_id
    `);
  }
  return cleared.length;
}
