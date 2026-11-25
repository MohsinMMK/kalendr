import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { appointments, auditEvents, formDefinitionServices, formDefinitions, forms, services } from "@/db/schema";
import {
  checkFormAnswers,
  formDefinitionDraftSchema,
  formForService,
  type FormAnswers,
  type FormDefinition,
  type FormDefinitionDraft,
  type FormField,
  type PublicFormDefinition,
} from "@/lib/booking-forms";

import { ApiError } from "./api-error";
import { createOpaqueToken } from "./crypto";
import { loadRecordKeys, openText, sealText, writeKeyVersion } from "./record-crypto";
import { assertAppointmentVisibleHere } from "./location-scope";
import { requirePermission, type StaffContext } from "./staff-context";

/** Stored with each response so a later key change can tell which key sealed it. */
export const formResponseKeyVersion = "records-v1";

/** A booking's answers as staff read them, with the exact questions they answered. */
export interface AppointmentFormAnswers {
  name: string;
  key: string;
  version: number;
  fields: FormField[];
  answers: FormAnswers;
  submittedAt: string | null;
}

/** The form a booking must fill in, resolved on the server. */
export type BookingFormDefinition = Pick<FormDefinition, "id" | "key" | "version" | "name" | "fields">;

interface PreviewFormResponse {
  definition: BookingFormDefinition;
  answers: FormAnswers;
  submittedAt: string;
}

interface PreviewFormStore {
  /** Every version, newest last. */
  definitions: FormDefinition[];
  responses: Map<string, PreviewFormResponse>;
}

const previewGlobals = globalThis as typeof globalThis & { kalendrPreviewForms?: PreviewFormStore };

function previewStore(): PreviewFormStore {
  previewGlobals.kalendrPreviewForms ??= { definitions: [], responses: new Map() };
  return previewGlobals.kalendrPreviewForms;
}

export function resetPreviewFormsForTests(): void {
  previewGlobals.kalendrPreviewForms = { definitions: [], responses: new Map() };
}

function parseDraft(input: unknown): FormDefinitionDraft {
  const parsed = formDefinitionDraftSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.join(".") || "form";
    (fieldErrors[path] ??= []).push(issue.message);
  }
  throw new ApiError(422, "form_definition_invalid", parsed.error.issues[0]?.message ?? "Check the form and try again.", fieldErrors);
}

/** Stored fields went through the same checks when saved; this only guards against a hand-edited row. */
function storedFields(value: unknown): FormField[] {
  const parsed = formDefinitionDraftSchema.safeParse({ name: "stored", fields: value });
  return parsed.success ? parsed.data.fields : [];
}

function requireFormEditor(context: StaffContext): void {
  requirePermission(context, "settings.manage");
}

function latestPreviewVersions(): FormDefinition[] {
  const latest = new Map<string, FormDefinition>();
  for (const definition of previewStore().definitions) latest.set(definition.key, definition);
  return [...latest.values()];
}

// ---------- Reading definitions ----------

interface DefinitionRow extends Record<string, unknown> {
  id: string;
  key: string;
  version: number;
  name: string;
  description: string;
  fields: unknown;
  is_active: boolean;
  applies_to_all: boolean;
  updated_at: Date | string;
  service_ids: string[] | null;
  overrides: Record<string, Record<string, boolean>> | null;
}

function definitionFromRow(row: DefinitionRow): FormDefinition {
  return {
    id: row.id,
    key: row.key,
    version: row.version,
    name: row.name,
    description: row.description,
    fields: storedFields(row.fields),
    isActive: row.is_active,
    appliesToAll: row.applies_to_all,
    serviceIds: row.service_ids ?? [],
    ...(row.overrides && Object.keys(row.overrides).length > 0 ? { requiredOverrides: row.overrides } : {}),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function currentDefinitionsIn(transaction: KalendrTransaction, tenantId: string, activeOnly: boolean): Promise<FormDefinition[]> {
  const rows = await transaction.execute<DefinitionRow>(sql`
    select definition.id, definition.key, definition.version, definition.name, definition.description,
      definition.fields, definition.is_active, definition.applies_to_all, definition.updated_at,
      coalesce(array_agg(link.service_id) filter (where link.service_id is not null), '{}') as service_ids,
      (select jsonb_object_agg(overrides.service_id, overrides.required_overrides)
        from form_definition_services as overrides
        where overrides.tenant_id = definition.tenant_id and overrides.form_definition_id = definition.id and overrides.required_overrides <> '{}'::jsonb) as overrides
    from form_definitions as definition
    left join form_definition_services as link
      on link.tenant_id = definition.tenant_id and link.form_definition_id = definition.id
    where definition.tenant_id = ${tenantId} and definition.is_current
      ${activeOnly ? sql`and definition.is_active` : sql``}
    group by definition.id
    order by definition.updated_at desc
  `);
  return rows.map(definitionFromRow);
}

function toPublic(definition: FormDefinition): PublicFormDefinition {
  const { id, key, version, name, description, fields, appliesToAll, serviceIds, requiredOverrides } = definition;
  return { id, key, version, name, description, fields, appliesToAll, serviceIds, ...(requiredOverrides ? { requiredOverrides } : {}) };
}

/** The forms a public booking page may show: the current, switched-on version of each. Newest first. */
export async function loadPublicFormsIn(transaction: KalendrTransaction, tenantId: string): Promise<PublicFormDefinition[]> {
  return (await currentDefinitionsIn(transaction, tenantId, true)).map(toPublic);
}

export function previewPublicForms(): PublicFormDefinition[] {
  return latestPreviewVersions().filter((definition) => definition.isActive).reverse().map(toPublic);
}

/** Every form's current version, switched off ones included, for the builder. */
export async function listStaffForms(context: StaffContext): Promise<FormDefinition[]> {
  requireFormEditor(context);
  if (context.preview) return latestPreviewVersions().reverse();
  return withTenant(context.tenantId, (transaction) => currentDefinitionsIn(transaction, context.tenantId, false));
}

// ---------- Saving definitions ----------

async function assertServicesExist(transaction: KalendrTransaction, tenantId: string, serviceIds: string[]): Promise<void> {
  if (serviceIds.length === 0) return;
  const rows = await transaction
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.tenantId, tenantId), inArray(services.id, serviceIds)));
  if (rows.length !== new Set(serviceIds).size) {
    throw new ApiError(422, "form_definition_invalid", "One of the chosen services no longer exists.", { serviceIds: ["One of the chosen services no longer exists."] });
  }
}

async function insertVersion(
  transaction: KalendrTransaction,
  context: StaffContext,
  key: string,
  version: number,
  draft: FormDefinitionDraft,
): Promise<FormDefinition> {
  await assertServicesExist(transaction, context.tenantId, draft.serviceIds);
  const [row] = await transaction.insert(formDefinitions).values({
    tenantId: context.tenantId,
    key,
    version,
    name: draft.name,
    description: draft.description,
    fields: draft.fields,
    isActive: draft.isActive,
    isCurrent: true,
    appliesToAll: draft.appliesToAll,
  }).returning();
  if (!row) throw new Error("Form definition insert did not return a row");
  if (draft.serviceIds.length > 0) {
    await transaction.insert(formDefinitionServices).values(
      draft.serviceIds.map((serviceId) => ({ tenantId: context.tenantId, formDefinitionId: row.id, serviceId, requiredOverrides: draft.requiredOverrides?.[serviceId] ?? {} })),
    );
  }
  await transaction.insert(auditEvents).values({
    tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
    action: version === 1 ? "settings.booking_form.created" : "settings.booking_form.updated", outcome: "success",
    metadata: { formKey: key, version, questions: draft.fields.length, isActive: draft.isActive, appliesToAll: draft.appliesToAll },
  });
  return {
    ...draft,
    id: row.id,
    key,
    version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function newFormKey(): string {
  return `form_${createOpaqueToken().replace(/[^a-z0-9]/gi, "").slice(0, 16).toLowerCase()}`;
}

export async function createStaffForm(context: StaffContext, input: unknown): Promise<FormDefinition> {
  requireFormEditor(context);
  const draft = parseDraft(input);
  const key = newFormKey();
  if (context.preview) {
    const definition: FormDefinition = { ...draft, id: `${key}_v1`, key, version: 1, updatedAt: new Date().toISOString() };
    previewStore().definitions.push(definition);
    return definition;
  }
  return withTenant(context.tenantId, (transaction) => insertVersion(transaction, context, key, 1, draft));
}

/**
 * Saves a change as a new version. The old version stays, so answers already given keep pointing at the
 * questions they answered; only the new version is offered to new bookings.
 */
export async function updateStaffForm(context: StaffContext, key: string, input: unknown): Promise<FormDefinition> {
  requireFormEditor(context);
  const draft = parseDraft(input);
  if (context.preview) {
    const current = latestPreviewVersions().find((definition) => definition.key === key);
    if (!current) throw formNotFound();
    const version = current.version + 1;
    const definition: FormDefinition = { ...draft, id: `${key}_v${version}`, key, version, updatedAt: new Date().toISOString() };
    previewStore().definitions.push(definition);
    return definition;
  }
  return withTenant(context.tenantId, async (transaction) => {
    const [current] = await transaction
      .select({ id: formDefinitions.id, version: formDefinitions.version })
      .from(formDefinitions)
      .where(and(eq(formDefinitions.tenantId, context.tenantId), eq(formDefinitions.key, key), eq(formDefinitions.isCurrent, true)))
      .orderBy(desc(formDefinitions.version))
      .limit(1)
      .for("update");
    if (!current) throw formNotFound();
    await transaction.update(formDefinitions)
      .set({ isCurrent: false, updatedAt: new Date() })
      .where(and(eq(formDefinitions.tenantId, context.tenantId), eq(formDefinitions.id, current.id)));
    return insertVersion(transaction, context, key, current.version + 1, draft);
  });
}

function formNotFound(): ApiError {
  return new ApiError(404, "form_not_found", "Form not found.");
}

// ---------- Answers on a booking ----------

function formInvalid(errors: Record<string, string>): ApiError {
  const fieldErrors = Object.fromEntries(Object.entries(errors).map(([id, message]) => [`formAnswers.${id}`, [message]]));
  return new ApiError(422, "form_invalid", "Some answers on the form need another look.", fieldErrors);
}

/** Checks a booking's answers against the form for its service. Returns what to store, or nothing when no form applies. */
export function checkBookingForm(
  formsForBusiness: readonly PublicFormDefinition[],
  serviceId: string,
  answers: FormAnswers | undefined,
): { definition: BookingFormDefinition; answers: FormAnswers } | null {
  const form = formForService(formsForBusiness, serviceId);
  if (!form) {
    if (answers && Object.keys(answers).length > 0) throw formInvalid({ form: "This service has no form to fill in." });
    return null;
  }
  const result = checkFormAnswers(form.fields, answers, { requiredOverrides: form.requiredOverrides?.[serviceId] ?? {} });
  if (!result.ok) throw formInvalid(result.errors);
  return { definition: { id: form.id, key: form.key, version: form.version, name: form.name, fields: form.fields }, answers: result.answers };
}

/** Inside the booking transaction: checks the answers and returns what to store after the appointment exists. */
export async function prepareBookingFormIn(
  transaction: KalendrTransaction,
  tenantId: string,
  serviceId: string,
  answers: FormAnswers | undefined,
): Promise<{ definition: BookingFormDefinition; answers: FormAnswers } | null> {
  return checkBookingForm(await loadPublicFormsIn(transaction, tenantId), serviceId, answers);
}

/** Stores the answers sealed with the business's records key and marks the appointment's form as received. */
export async function storeFormResponseIn(
  transaction: KalendrTransaction,
  tenantId: string,
  appointmentId: string,
  patientId: string,
  prepared: { definition: BookingFormDefinition; answers: FormAnswers },
): Promise<void> {
  const submittedAt = new Date();
  await loadRecordKeys(transaction, tenantId, { forWrite: true });
  await transaction.insert(forms).values({
    tenantId,
    appointmentId,
    patientId,
    definitionKey: prepared.definition.key,
    definitionVersion: prepared.definition.version,
    status: "submitted",
    responseCiphertext: sealText(tenantId, JSON.stringify(prepared.answers)),
    encryptionKeyVersion: formResponseKeyVersion,
    keyVersion: writeKeyVersion(tenantId),
    submittedAt,
  });
  await transaction.update(appointments)
    .set({ formStatus: "submitted" })
    .where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, appointmentId)));
}

/** Preview: checks answers against the in-memory forms. */
export function checkPreviewBookingForm(serviceId: string, answers: FormAnswers | undefined) {
  return checkBookingForm(previewPublicForms(), serviceId, answers);
}

export function storePreviewFormResponse(appointmentId: string, prepared: { definition: BookingFormDefinition; answers: FormAnswers }): void {
  previewStore().responses.set(appointmentId, { ...prepared, submittedAt: new Date().toISOString() });
}

interface ResponseRow extends Record<string, unknown> {
  definition_key: string;
  definition_version: number;
  response_ciphertext: string | null;
  submitted_at: Date | string | null;
  name: string | null;
  fields: unknown;
}

/** The answers given when this appointment was booked, or null when it has none. Every staff member may read them. */
export async function loadAppointmentFormAnswers(context: StaffContext, appointmentId: string): Promise<AppointmentFormAnswers | null> {
  if (context.preview) {
    const response = previewStore().responses.get(appointmentId);
    if (!response) return null;
    return { name: response.definition.name, key: response.definition.key, version: response.definition.version, fields: response.definition.fields, answers: response.answers, submittedAt: response.submittedAt };
  }
  return withTenant(context.tenantId, async (transaction) => {
    await assertAppointmentVisibleHere(transaction, context, appointmentId);
    const [row] = await transaction.execute<ResponseRow>(sql`
      select form.definition_key, form.definition_version, form.response_ciphertext, form.submitted_at,
        definition.name, definition.fields
      from forms as form
      left join form_definitions as definition
        on definition.tenant_id = form.tenant_id and definition.key = form.definition_key
          and definition.version = form.definition_version
      where form.tenant_id = ${context.tenantId} and form.appointment_id = ${appointmentId}
      order by form.submitted_at desc nulls last
      limit 1
    `);
    if (!row?.response_ciphertext) return null;
    await loadRecordKeys(transaction, context.tenantId);
    let answers: FormAnswers = {};
    try {
      const parsed: unknown = JSON.parse(openText(context.tenantId, row.response_ciphertext));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) answers = parsed as FormAnswers;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, "form_unreadable", "These answers could not be opened.");
    }
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, appointmentId, actorUserId: context.userId, actorType: "staff",
      action: "form_response.viewed", outcome: "success",
      metadata: { formKey: row.definition_key, version: row.definition_version },
    });
    return {
      name: row.name ?? "Booking form",
      key: row.definition_key,
      version: row.definition_version,
      fields: storedFields(row.fields),
      answers,
      submittedAt: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
    };
  });
}
