import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { getDatabase, withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents, routingFormVersions, routingForms } from "@/db/schema";
import {
  findUnreachable,
  resolveRouting,
  routingDefinitionSchema,
  type PreviewResult,
  type RoutingBuilderOptions,
  type RoutingDefinition,
  type RoutingDraft,
  type RoutingFormDetail,
  type RoutingFormSummary,
  type RoutingFormView,
  type RoutingWarning,
} from "@/lib/routing-forms";
import type { FormAnswers } from "@/lib/booking-forms";
import { checkFormAnswers } from "@/lib/booking-forms";
import { ApiError, getPostgresErrorCode } from "@/server/api-error";
import { requireFeature } from "@/server/entitlements";
import { requirePermission, type StaffContext } from "@/server/staff-context";

import { destinationServiceIds, loadDirectory } from "./directory";
import { jsonValue } from "./json";

/**
 * The owner's side of routing forms (feature 46): build, preview, publish and pause. Saving a form never changes what
 * customers see; publishing copies it into an immutable version, and responses keep the version they were answered with.
 */

function guardRead(context: StaffContext): void {
  requirePermission(context, "routing.manage");
  if (context.preview || !getDatabase()) throw new ApiError(503, "database_unavailable", "Routing forms need the live database.");
}

function guardWrite(context: StaffContext): void {
  guardRead(context);
  requireFeature(context, "routingForms");
}

function stale(): ApiError {
  return new ApiError(409, "version_conflict", "Someone else changed this form. Reload it and try again.");
}

function notFound(): ApiError {
  return new ApiError(404, "routing_form_not_found", "That routing form could not be found.");
}

/** The stored definition, checked again on the way out, so a damaged row is a clear error rather than a broken screen. */
export function parseStored(value: unknown): RoutingDefinition {
  const parsed = routingDefinitionSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(500, "routing_form_invalid", "This form is damaged. Edit and save it again.");
  return parsed.data;
}

type FormRow = typeof routingForms.$inferSelect;

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function latestVersion(transaction: KalendrTransaction, tenantId: string, formId: string) {
  const [row] = await transaction.select().from(routingFormVersions)
    .where(and(eq(routingFormVersions.tenantId, tenantId), eq(routingFormVersions.formId, formId)))
    .orderBy(desc(routingFormVersions.version)).limit(1);
  return row ?? null;
}

async function toView(transaction: KalendrTransaction, row: FormRow): Promise<RoutingFormView> {
  const live = row.liveVersion === null ? null : (await transaction.select().from(routingFormVersions)
    .where(and(eq(routingFormVersions.tenantId, row.tenantId), eq(routingFormVersions.formId, row.id), eq(routingFormVersions.version, row.liveVersion))).limit(1))[0] ?? null;
  const definition = parseStored(row.definition);
  const latest = live ?? await latestVersion(transaction, row.tenantId, row.id);
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    slug: row.slug,
    intro: row.intro,
    definition,
    status: row.status === "live" ? "live" : "draft",
    version: row.liveVersion ?? latest?.version ?? 0,
    revision: row.revision,
    hasUnpublishedChanges: !latest || !sameJson(latest.definition, row.definition) || latest.name !== row.name || latest.intro !== row.intro,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Everything the builder warns about, from the form alone and from the services it points at. */
export async function checkDefinition(transaction: KalendrTransaction, tenantId: string, definition: RoutingDefinition): Promise<RoutingWarning[]> {
  const warnings = findUnreachable(definition);
  const directory = await loadDirectory(transaction, tenantId, destinationServiceIds(definition));
  const check = (routeId: string, name: string, destination: RoutingDefinition["fallback"]): void => {
    if (destination.type !== "service") return;
    const service = directory.services.get(destination.serviceId);
    if (!service) warnings.push({ kind: "service_unavailable", routeId, message: `“${name}” sends people to a service that no longer exists.` });
    else if (!service.active) warnings.push({ kind: "service_unavailable", routeId, message: `“${name}” sends people to ${service.name}, which is turned off, so nobody can book it.` });
    else if (service.hidden) warnings.push({ kind: "service_unavailable", routeId, message: `“${name}” sends people to ${service.name}, which is hidden from your booking page. It still books from this form, but check that is what you want.` });
    else if ((directory.byService.get(service.id) ?? []).length === 0) warnings.push({ kind: "no_fallback_people", routeId, message: `Nobody is set up to offer ${service.name}, so “${name}” has no one to book with.` });
  };
  for (const route of definition.routes) check(route.id, route.name, route.destination);
  check("fallback", "The fallback", definition.fallback);
  return warnings;
}

export async function listRoutingForms(context: StaffContext): Promise<RoutingFormSummary[]> {
  guardRead(context);
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.execute<{ id: string; key: string; name: string; slug: string; status: string; live_version: number | null; revision: number; definition: unknown; updated_at: Date | string; responses: number | string }>(sql`
      select form.id, form.key, form.name, form.slug, form.status, form.live_version, form.revision, form.definition, form.updated_at,
        (select count(*) from routing_responses as response where response.tenant_id = form.tenant_id and response.form_id = form.id and response.opened_at >= now() - interval '30 days') as responses
      from routing_forms as form where form.tenant_id = ${context.tenantId} order by form.updated_at desc
    `);
    return rows.map((row) => {
      const parsed = routingDefinitionSchema.safeParse(jsonValue(row.definition));
      return {
        id: row.id, key: row.key, name: row.name, slug: row.slug,
        status: row.status === "live" ? "live" : "draft",
        version: row.live_version ?? 0,
        routeCount: parsed.success ? parsed.data.routes.length : 0,
        responses30d: Number(row.responses),
        updatedAt: new Date(row.updated_at).toISOString(),
      } satisfies RoutingFormSummary;
    });
  });
}

export async function getRoutingForm(context: StaffContext, formId: string): Promise<RoutingFormDetail> {
  guardRead(context);
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.select().from(routingForms).where(and(eq(routingForms.tenantId, context.tenantId), eq(routingForms.id, formId))).limit(1);
    if (!row) throw notFound();
    const form = await toView(transaction, row);
    return { form, warnings: await checkDefinition(transaction, context.tenantId, form.definition) };
  });
}

export async function routingBuilderOptions(context: StaffContext): Promise<RoutingBuilderOptions> {
  guardRead(context);
  return withTenant(context.tenantId, async (transaction) => {
    const services = await transaction.execute<{ id: string; name: string; is_active: boolean; visibility: string }>(sql`
      select id, name, is_active, visibility from services where tenant_id = ${context.tenantId} order by is_active desc, name
    `);
    const people = await transaction.execute<{ id: string; name: string }>(sql`
      select id, name from practitioners where tenant_id = ${context.tenantId} and is_active order by name
    `);
    const attributes = await transaction.execute<{ id: string; name: string; kind: "text" | "single" | "multiple" | "number"; options: string[] }>(sql`
      select id, name, kind, options from attribute_definitions where tenant_id = ${context.tenantId} order by position, name
    `);
    const forms = await transaction.execute<{ fields: unknown }>(sql`
      select fields from form_definitions where tenant_id = ${context.tenantId} and is_current and is_active
    `);
    const keys = new Set<string>();
    for (const form of forms) {
      const fields = jsonValue(form.fields);
      for (const field of Array.isArray(fields) ? fields : []) {
        const key = typeof field === "object" && field !== null && "prefillKey" in field ? (field as { prefillKey?: unknown }).prefillKey : undefined;
        if (typeof key === "string" && key) keys.add(key);
      }
    }
    return {
      services: services.map((row) => ({ id: row.id, name: row.name, active: row.is_active, hidden: row.visibility === "hidden" })),
      people: people.map((row) => ({ id: row.id, name: row.name })),
      attributes: attributes.map((row) => ({ id: row.id, name: row.name, kind: row.kind, options: row.options })),
      bookingKeys: [...keys].sort(),
    };
  });
}

function audit(transaction: KalendrTransaction, context: StaffContext, action: string, formId: string, extra: Record<string, unknown> = {}) {
  // Ids and counts only: a form's wording is the owner's, but nothing a customer typed is ever written here.
  return transaction.insert(auditEvents).values({
    tenantId: context.tenantId, actorUserId: context.userId ?? null, actorType: "staff", action, outcome: "success", metadata: { formId, ...extra },
  });
}

export async function createRoutingForm(context: StaffContext, draft: RoutingDraft): Promise<RoutingFormDetail> {
  guardWrite(context);
  try {
    return await withTenant(context.tenantId, async (transaction) => {
      const [row] = await transaction.insert(routingForms).values({
        tenantId: context.tenantId, name: draft.name, slug: draft.slug, intro: draft.intro, definition: draft.definition, createdByUserId: context.userId ?? null,
      }).returning();
      if (!row) throw new Error("Routing form insert returned no row");
      await audit(transaction, context, "routing.form.created", row.id);
      const form = await toView(transaction, row);
      return { form, warnings: await checkDefinition(transaction, context.tenantId, form.definition) };
    });
  } catch (error: unknown) {
    if (getPostgresErrorCode(error) === "23505") throw new ApiError(409, "duplicate", "Another form already uses that web address. Choose a different one.", { slug: ["Already in use."] });
    throw error;
  }
}

export async function updateRoutingForm(context: StaffContext, formId: string, draft: RoutingDraft, expectedRevision: number): Promise<RoutingFormDetail> {
  guardWrite(context);
  try {
    return await withTenant(context.tenantId, async (transaction) => {
      const [current] = await transaction.select().from(routingForms).where(and(eq(routingForms.tenantId, context.tenantId), eq(routingForms.id, formId))).for("update").limit(1);
      if (!current) throw notFound();
      if (current.revision !== expectedRevision) throw stale();
      // A live form's address is in links on other websites, so it only changes while the form is paused.
      if (current.status === "live" && current.slug !== draft.slug) {
        throw new ApiError(409, "slug_locked", "Pause the form before changing its web address, because it is live.", { slug: ["Pause the form first."] });
      }
      const [row] = await transaction.update(routingForms).set({
        name: draft.name, slug: draft.slug, intro: draft.intro, definition: draft.definition, revision: current.revision + 1, updatedAt: new Date(),
      }).where(and(eq(routingForms.tenantId, context.tenantId), eq(routingForms.id, formId))).returning();
      if (!row) throw notFound();
      await audit(transaction, context, "routing.form.updated", formId, { revision: row.revision });
      const form = await toView(transaction, row);
      return { form, warnings: await checkDefinition(transaction, context.tenantId, form.definition) };
    });
  } catch (error: unknown) {
    if (getPostgresErrorCode(error) === "23505") throw new ApiError(409, "duplicate", "Another form already uses that web address. Choose a different one.", { slug: ["Already in use."] });
    throw error;
  }
}

/** Makes the saved form what customers see. A change creates a new version; publishing an unchanged form just turns it back on. */
export async function publishRoutingForm(context: StaffContext, formId: string, expectedRevision: number): Promise<RoutingFormDetail> {
  guardWrite(context);
  return withTenant(context.tenantId, async (transaction) => {
    const [current] = await transaction.select().from(routingForms).where(and(eq(routingForms.tenantId, context.tenantId), eq(routingForms.id, formId))).for("update").limit(1);
    if (!current) throw notFound();
    if (current.revision !== expectedRevision) throw stale();
    const definition = parseStored(current.definition);
    const directory = await loadDirectory(transaction, context.tenantId, destinationServiceIds(definition));
    const missing = destinationServiceIds(definition).filter((id) => !directory.services.has(id));
    if (missing.length > 0) throw new ApiError(400, "service_not_found", "A route sends people to a service that no longer exists. Pick another service, then publish.");
    const latest = await latestVersion(transaction, context.tenantId, formId);
    let version = latest?.version ?? 0;
    if (!latest || !sameJson(latest.definition, current.definition) || latest.name !== current.name || latest.intro !== current.intro) {
      version += 1;
      await transaction.insert(routingFormVersions).values({
        tenantId: context.tenantId, formId, version, name: current.name, intro: current.intro, definition, publishedByUserId: context.userId ?? null,
      });
    }
    const [row] = await transaction.update(routingForms).set({ status: "live", liveVersion: version, revision: current.revision + 1, updatedAt: new Date() })
      .where(and(eq(routingForms.tenantId, context.tenantId), eq(routingForms.id, formId))).returning();
    if (!row) throw notFound();
    await audit(transaction, context, "routing.form.published", formId, { version });
    const form = await toView(transaction, row);
    return { form, warnings: await checkDefinition(transaction, context.tenantId, form.definition) };
  });
}

export async function pauseRoutingForm(context: StaffContext, formId: string, expectedRevision: number): Promise<RoutingFormDetail> {
  guardWrite(context);
  return withTenant(context.tenantId, async (transaction) => {
    const [current] = await transaction.select().from(routingForms).where(and(eq(routingForms.tenantId, context.tenantId), eq(routingForms.id, formId))).for("update").limit(1);
    if (!current) throw notFound();
    if (current.revision !== expectedRevision) throw stale();
    const [row] = await transaction.update(routingForms).set({ status: "draft", revision: current.revision + 1, updatedAt: new Date() })
      .where(and(eq(routingForms.tenantId, context.tenantId), eq(routingForms.id, formId))).returning();
    if (!row) throw notFound();
    await audit(transaction, context, "routing.form.paused", formId);
    const form = await toView(transaction, row);
    return { form, warnings: await checkDefinition(transaction, context.tenantId, form.definition) };
  });
}

export async function deleteRoutingForm(context: StaffContext, formId: string): Promise<{ deleted: true }> {
  guardWrite(context);
  return withTenant(context.tenantId, async (transaction) => {
    // Bookings made through a form keep their trace on the response row, so a form with bookings can only be paused.
    const [linked] = await transaction.execute<{ n: number | string }>(sql`
      select count(*) as n from routing_responses where tenant_id = ${context.tenantId} and form_id = ${formId} and appointment_id is not null
    `);
    if (Number(linked?.n ?? 0) > 0) throw new ApiError(409, "form_has_bookings", "Bookings were made through this form, so it can only be paused. Pausing keeps their routing history.");
    const removed = await transaction.delete(routingForms).where(and(eq(routingForms.tenantId, context.tenantId), eq(routingForms.id, formId))).returning({ id: routingForms.id });
    if (removed.length === 0) throw notFound();
    await audit(transaction, context, "routing.form.deleted", formId);
    return { deleted: true as const };
  });
}

/**
 * Types answers and shows which route matches and who would be offered. Writes nothing: it runs in a read-only
 * transaction, so any write would be refused by the database itself.
 */
export async function previewRoutingForm(context: StaffContext, formId: string, answers: FormAnswers): Promise<PreviewResult> {
  guardRead(context);
  return withTenant(context.tenantId, async (transaction) => {
    await transaction.execute(sql`set transaction read only`);
    const [row] = await transaction.select().from(routingForms).where(and(eq(routingForms.tenantId, context.tenantId), eq(routingForms.id, formId))).limit(1);
    if (!row) throw notFound();
    const definition = parseStored(row.definition);
    const checked = checkFormAnswers(definition.questions, answers);
    if (!checked.ok) throw new ApiError(400, "validation_error", "Check the answers and try again.", Object.fromEntries(Object.entries(checked.errors).map(([id, message]) => [id, [message]])));
    const directory = await loadDirectory(transaction, context.tenantId, destinationServiceIds(definition));
    const resolution = resolveRouting(definition, checked.answers, directory.byService, directory.attributes);
    return {
      routeId: resolution.trace.matchedRouteId,
      routeName: resolution.trace.matchedRouteName,
      destination: resolution.destination,
      trace: resolution.trace,
      offered: resolution.trace.people.filter((person) => person.passed).map((person) => ({ personId: person.personId, name: person.name, multiplier: person.multiplier })),
    };
  });
}
