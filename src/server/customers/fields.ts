import "server-only";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { customerFieldDefinitions, customerFieldValues } from "@/db/schema";
import {
  MAX_FIELDS_PER_BUSINESS, isChoiceKind, type CustomerFieldDefinition, type CustomerFieldValue, type FieldKind,
} from "@/lib/customer-contracts";
import { kindOf, normaliseFieldValue } from "@/lib/customer-field-values";
import { ApiError } from "@/server/api-error";
import { andVisibleCustomer } from "@/server/location-scope";
import { requirePermission, type StaffContext } from "@/server/staff-context";

import { auditCustomer, loadVisibleCustomer } from "./access";
import { convertStoredValues } from "./field-conversion";

type DefinitionRow = typeof customerFieldDefinitions.$inferSelect;

/** The most value rows one table read returns; a business past this sees the first customers' answers only. */
export const MAX_GRID_VALUES = 20_000;

function toDefinition(row: DefinitionRow): CustomerFieldDefinition {
  return { id: row.id, label: row.label, kind: kindOf(row.kind), choices: row.choices, position: row.position, archived: row.archivedAt !== null, version: row.version };
}

/** Defining, changing and removing fields shapes every customer's profile, so it is for owners and admins even when `customers.manage` is given wider. */
function requireFieldManager(context: StaffContext): void {
  requirePermission(context, "customers.manage");
  if (context.role !== "owner" && context.role !== "admin") {
    throw new ApiError(403, "forbidden", "Only an owner or an admin can add or change extra fields.");
  }
}

function fieldExists(): ApiError {
  return new ApiError(409, "field_exists", "You already have a field with that name.", { label: ["You already have a field with that name."] });
}

export async function listFieldDefinitions(context: StaffContext, options: { includeArchived?: boolean } = {}): Promise<CustomerFieldDefinition[]> {
  if (context.preview) return [];
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.select().from(customerFieldDefinitions)
      .where(eq(customerFieldDefinitions.tenantId, context.tenantId)).orderBy(asc(customerFieldDefinitions.position), asc(customerFieldDefinitions.label));
    return rows.filter((row) => options.includeArchived || row.archivedAt === null).map(toDefinition);
  });
}

async function nextPositionAndCount(transaction: KalendrTransaction, tenantId: string): Promise<{ total: number; next: number }> {
  // One lock per business so two people adding a field at once cannot both slip past the cap.
  await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`customer-fields:${tenantId}`}, 0))`);
  const [counts] = await transaction.execute<{ total: number; next: number }>(sql`
    select count(*) filter (where archived_at is null)::int as total, coalesce(max(position), -1) + 1 as next from customer_field_definitions where tenant_id = ${tenantId}
  `);
  return { total: Number(counts?.total ?? 0), next: Number(counts?.next ?? 0) };
}

export async function createFieldDefinition(context: StaffContext, input: { label: string; kind: FieldKind; choices: string[] }): Promise<CustomerFieldDefinition> {
  requireFieldManager(context);
  if (context.preview) throw new ApiError(400, "preview_only", "Extra fields need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    const counts = await nextPositionAndCount(transaction, context.tenantId);
    if (counts.total >= MAX_FIELDS_PER_BUSINESS) throw new ApiError(409, "too_many_fields", `You can add up to ${MAX_FIELDS_PER_BUSINESS} extra fields.`);
    const [created] = await transaction.insert(customerFieldDefinitions).values({
      tenantId: context.tenantId, label: input.label, kind: input.kind, choices: isChoiceKind(input.kind) ? input.choices : [], position: counts.next,
    }).onConflictDoNothing().returning();
    if (!created) throw fieldExists();
    await auditCustomer(transaction, context, "customer.field.created", null, { fieldId: created.id, kind: created.kind });
    return toDefinition(created);
  });
}

export interface FieldUpdateInput {
  label?: string;
  kind?: FieldKind;
  choices?: string[];
  renames?: Record<string, string>;
  position?: number;
  archived?: boolean;
  version: number;
}

export interface FieldUpdateResult {
  definition: CustomerFieldDefinition;
  /** How many saved answers no longer fit the new kind or choices and were removed. */
  cleared: number;
}

function choiceProblem(message: string): ApiError {
  return new ApiError(400, "validation_error", message, { choices: [message] });
}

/** What the field becomes: its kind, its list of choices and the renames that apply. Throws a plain sentence when the combination makes no sense. */
function planShape(existing: DefinitionRow, input: FieldUpdateInput): { kind: FieldKind; choices: string[]; renames: Record<string, string> } {
  const kind = input.kind ?? kindOf(existing.kind);
  const renames = input.renames ?? {};
  if (!isChoiceKind(kind)) {
    if (input.choices && input.choices.length > 0) throw choiceProblem("Only a choice field has choices.");
    if (Object.keys(renames).length > 0) throw choiceProblem("Only a choice field has choices to rename.");
    return { kind, choices: [], renames: {} };
  }
  const choices = input.choices ?? (isChoiceKind(kindOf(existing.kind)) ? existing.choices : []);
  if (choices.length < 2) throw choiceProblem("Add at least two choices.");
  if (new Set(choices.map((choice) => choice.toLowerCase())).size !== choices.length) throw choiceProblem("Each choice must be different.");
  for (const [from, to] of Object.entries(renames)) {
    if (!isChoiceKind(kindOf(existing.kind)) || !existing.choices.includes(from) || !choices.includes(to)) throw choiceProblem("A renamed choice must be one you had, and become one you keep.");
  }
  return { kind, choices, renames };
}

export async function updateFieldDefinition(context: StaffContext, fieldId: string, input: FieldUpdateInput): Promise<FieldUpdateResult> {
  requireFieldManager(context);
  if (context.preview) throw new ApiError(400, "preview_only", "Extra fields need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    const [existing] = await transaction.select().from(customerFieldDefinitions)
      .where(and(eq(customerFieldDefinitions.tenantId, context.tenantId), eq(customerFieldDefinitions.id, fieldId))).for("update");
    if (!existing) throw new ApiError(404, "field_not_found", "That field no longer exists.");
    if (existing.version !== input.version) throw new ApiError(409, "version_conflict", "Someone else changed this field. Reload and try again.");
    const plan = planShape(existing, input);
    if (input.label) {
      const [clash] = await transaction.execute<{ id: string }>(sql`select id from customer_field_definitions where tenant_id = ${context.tenantId} and lower(label) = lower(${input.label}) and id <> ${fieldId}`);
      if (clash) throw fieldExists();
    }
    if (input.archived === false && existing.archivedAt) {
      const counts = await nextPositionAndCount(transaction, context.tenantId);
      if (counts.total >= MAX_FIELDS_PER_BUSINESS) throw new ApiError(409, "too_many_fields", `You can add up to ${MAX_FIELDS_PER_BUSINESS} extra fields.`);
    }
    const before = { kind: kindOf(existing.kind), choices: existing.choices, label: existing.label };
    const after = { kind: plan.kind, choices: plan.choices, label: input.label ?? existing.label };
    const reshaped = before.kind !== after.kind || JSON.stringify(before.choices) !== JSON.stringify(after.choices) || Object.keys(plan.renames).length > 0;
    const cleared = reshaped ? await convertStoredValues(transaction, context.tenantId, fieldId, before, after, plan.renames) : 0;
    const [updated] = await transaction.update(customerFieldDefinitions).set({
      ...(input.label ? { label: input.label } : {}),
      kind: plan.kind,
      choices: plan.choices,
      ...(input.position !== undefined ? { position: input.position } : {}),
      ...(input.archived === undefined ? {} : { archivedAt: input.archived ? (existing.archivedAt ?? new Date()) : null }),
      version: existing.version + 1,
    }).where(and(eq(customerFieldDefinitions.tenantId, context.tenantId), eq(customerFieldDefinitions.id, fieldId))).returning();
    if (!updated) throw new ApiError(404, "field_not_found", "That field no longer exists.");
    // Ids, the kind and counts only: a field's name, its choices and its answers never reach the audit trail.
    await auditCustomer(transaction, context, "customer.field.updated", null, { fieldId, kind: updated.kind, kindChanged: before.kind !== after.kind, archived: updated.archivedAt !== null, cleared });
    return { definition: toDefinition(updated), cleared };
  });
}

export async function fieldValuesFor(context: StaffContext, patientId: string): Promise<CustomerFieldValue[]> {
  if (context.preview) return [];
  return withTenant(context.tenantId, async (transaction) => {
    await loadVisibleCustomer(transaction, context, patientId);
    const rows = await transaction.select({ fieldId: customerFieldValues.fieldId, value: customerFieldValues.value }).from(customerFieldValues)
      .where(and(eq(customerFieldValues.tenantId, context.tenantId), eq(customerFieldValues.patientId, patientId)));
    return rows;
  });
}

interface GridRow extends Record<string, unknown> {
  patient_id: string;
  field_id: string;
  value: string;
}

/**
 * Every answer for the customers this person may see, for a table: `{ [customerId]: { [fieldId]: value } }`. One query, capped
 * at MAX_GRID_VALUES rows. Merged-away and erased customers and archived fields are left out; a practitioner gets only the
 * customers they have had a visit with (the same rule as opening one profile).
 */
export async function listFieldValuesForGrid(context: StaffContext): Promise<Record<string, Record<string, string>>> {
  if (context.preview) return {};
  return withTenant(context.tenantId, async (transaction) => {
    const ownOnly = context.role === "practitioner" ? sql`and exists (
      select 1 from appointments as appointment
      join practitioners as practitioner on practitioner.tenant_id = appointment.tenant_id and practitioner.id = appointment.practitioner_id
      where appointment.tenant_id = stored.tenant_id and appointment.patient_id = stored.patient_id and practitioner.auth_user_id = ${context.userId}
    )` : sql``;
    const rows = await transaction.execute<GridRow>(sql`
      select stored.patient_id, stored.field_id, stored.value
      from customer_field_values as stored
      join customer_field_definitions as field on field.tenant_id = stored.tenant_id and field.id = stored.field_id and field.archived_at is null
      join patients as patient on patient.tenant_id = stored.tenant_id and patient.id = stored.patient_id and patient.merged_into_id is null and patient.erased_at is null
      where stored.tenant_id = ${context.tenantId} ${ownOnly} ${andVisibleCustomer(context, sql`stored.patient_id`)}
      order by stored.patient_id, stored.field_id
      limit ${MAX_GRID_VALUES}
    `);
    const byCustomer: Record<string, Record<string, string>> = {};
    for (const row of rows) (byCustomer[row.patient_id] ??= {})[row.field_id] = row.value;
    return byCustomer;
  });
}

/** Sets or clears several answers at once. Every value is checked against its field before any is saved. */
export async function setFieldValues(context: StaffContext, patientId: string, values: Record<string, string | null>): Promise<CustomerFieldValue[]> {
  requirePermission(context, "customers.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Extra fields need a database.");
  const ids = Object.keys(values);
  return withTenant(context.tenantId, async (transaction) => {
    await loadVisibleCustomer(transaction, context, patientId, { lock: true });
    // Read `for share` so a field's kind cannot change under these answers until they are saved.
    const definitions = ids.length === 0 ? [] : await transaction.select().from(customerFieldDefinitions)
      .where(and(eq(customerFieldDefinitions.tenantId, context.tenantId), inArray(customerFieldDefinitions.id, ids))).for("share");
    const byId = new Map(definitions.map((row) => [row.id, toDefinition(row)]));
    const fieldErrors: Record<string, string[]> = {};
    const toSet: { fieldId: string; value: string }[] = [];
    const toClear: string[] = [];
    for (const [fieldId, raw] of Object.entries(values)) {
      const definition = byId.get(fieldId);
      if (!definition || definition.archived) { fieldErrors[fieldId] = ["That field no longer exists."]; continue; }
      if (raw === null || raw.trim() === "") { toClear.push(fieldId); continue; }
      const result = normaliseFieldValue(definition, raw);
      if ("error" in result) fieldErrors[fieldId] = [result.error];
      else toSet.push({ fieldId, value: result.value });
    }
    if (Object.keys(fieldErrors).length > 0) throw new ApiError(400, "validation_error", "Please check the highlighted fields.", fieldErrors);
    for (const entry of toSet) {
      await transaction.insert(customerFieldValues).values({ tenantId: context.tenantId, patientId, fieldId: entry.fieldId, value: entry.value, updatedByUserId: context.userId })
        .onConflictDoUpdate({ target: [customerFieldValues.tenantId, customerFieldValues.patientId, customerFieldValues.fieldId], set: { value: entry.value, updatedByUserId: context.userId, updatedAt: new Date() } });
    }
    if (toClear.length > 0) {
      await transaction.delete(customerFieldValues).where(and(eq(customerFieldValues.tenantId, context.tenantId), eq(customerFieldValues.patientId, patientId), inArray(customerFieldValues.fieldId, toClear)));
    }
    // The answers themselves stay out of the audit trail; only which fields changed is recorded.
    await auditCustomer(transaction, context, "customer.fields.changed", patientId, { set: toSet.map((entry) => entry.fieldId), cleared: toClear });
    return transaction.select({ fieldId: customerFieldValues.fieldId, value: customerFieldValues.value }).from(customerFieldValues)
      .where(and(eq(customerFieldValues.tenantId, context.tenantId), eq(customerFieldValues.patientId, patientId)));
  });
}
