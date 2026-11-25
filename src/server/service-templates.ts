import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { type KalendrTransaction, withTenant } from "@/db/client";
import { auditEvents, serviceDurations, serviceLocationOptions, serviceLocations, serviceTemplates, services, practitionerServices } from "@/db/schema";
import { defaultApprovalSettings } from "@/lib/approval";
import { defaultIntakeSettings } from "@/lib/booking-intake";
import { defaultBookingPageSettings } from "@/lib/booking-page";
import { defaultCancelPolicy } from "@/lib/cancel-policy";
import {
  type AssignTemplateInput,
  type CreateTemplateInput,
  type LockableField,
  type PublishSummary,
  type TemplateDetail,
  type TemplateSettings,
  type TemplateView,
  type UpdateTemplateInput,
  changedLockFields,
  hasLocalChanges,
  lockableFields,
  patchFromTemplate,
  publishSentence,
  settingsFromSetup,
  templateSettingsSchema,
} from "@/lib/service-templates";
import type { ServiceSetup } from "@/lib/service-setup";
import { profileWords } from "@/lib/terminology";

import { ApiError } from "./api-error";
import { loadBusinessProfileIn } from "./business-profile";
import { applyServicePatchIn, loadServiceSetupIn, slugify, uniqueServiceSlug } from "./services-admin";
import { type StaffContext, requirePermission } from "./staff-context";

/**
 * Service templates (feature 48). A template is a definition; real services follow it. Publishing a change brings every
 * copy's locked fields in line in one transaction and leaves unlocked fields alone. Bookings keep the length and price
 * they were booked with: before a price moves, bookings that had no price of their own are given the one in force.
 * Audit rows carry ids, counts and lock names, never names or descriptions (staff-typed text).
 */

type Tx = KalendrTransaction;

const starterSettings: TemplateSettings = {
  description: "Describe what this service includes.",
  category: null,
  visibility: "listed",
  requiredResourceKind: null,
  lengths: [{ minutes: 30, priceMinor: null, isDefault: true }],
  timing: { bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minimumNoticeMinutes: 60, window: { kind: "rolling_days", days: 90 }, slotIntervalMinutes: null, startOffsetMinutes: 0 },
  meeting: [{ kind: "in_person", note: null }],
  look: { colorLight: null, colorDark: null, bannerMediaId: null },
  bookingPage: defaultBookingPageSettings,
  intake: defaultIntakeSettings,
  approval: defaultApprovalSettings,
  cancelPolicy: defaultCancelPolicy,
};

function lockedOf(values: readonly string[]): LockableField[] {
  return values.filter((value): value is LockableField => (lockableFields as readonly string[]).includes(value));
}

function viewOf(row: typeof serviceTemplates.$inferSelect, copyCount: number): TemplateView {
  const settings = templateSettingsSchema.safeParse(row.settings);
  if (!settings.success) throw new Error("A stored template no longer fits the template shape.");
  return { id: row.id, name: row.name, version: row.version, lockedFields: lockedOf(row.lockedFields), settings: settings.data, copyCount, updatedAt: row.updatedAt.toISOString() };
}

async function loadTemplate(transaction: Tx, tenantId: string, templateId: string, lock = false): Promise<typeof serviceTemplates.$inferSelect> {
  const query = transaction.select().from(serviceTemplates).where(and(eq(serviceTemplates.tenantId, tenantId), eq(serviceTemplates.id, templateId)));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw new ApiError(404, "template_not_found", "That template no longer exists.");
  return row;
}

const versionConflict = () => new ApiError(409, "version_conflict", "Someone else changed this template while you were editing. Reload it and try again.");

async function copyIds(transaction: Tx, tenantId: string, templateId: string): Promise<string[]> {
  const rows = await transaction.execute<{ id: string }>(sql`select id from services where tenant_id = ${tenantId} and template_id = ${templateId} order by created_at, id`);
  return rows.map((row) => row.id);
}

export async function listTemplates(context: StaffContext): Promise<TemplateView[]> {
  requirePermission(context, "services.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.select().from(serviceTemplates).where(eq(serviceTemplates.tenantId, context.tenantId)).orderBy(serviceTemplates.name);
    const counts = await transaction.execute<{ template_id: string; n: number }>(sql`
      select template_id, count(*)::int as n from services where tenant_id = ${context.tenantId} and template_id is not null group by template_id`);
    const byId = new Map(counts.map((row) => [row.template_id, row.n]));
    return rows.map((row) => viewOf(row, byId.get(row.id) ?? 0));
  });
}

export async function getTemplate(context: StaffContext, templateId: string): Promise<TemplateDetail> {
  requirePermission(context, "services.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const row = await loadTemplate(transaction, context.tenantId, templateId);
    const copies = await transaction.execute<{ id: string; name: string; template_version: number; locations: string[] | null }>(sql`
      select service.id, service.name, service.template_version,
        array(select location.name from service_locations as link join locations as location on location.tenant_id = link.tenant_id and location.id = link.location_id
          where link.tenant_id = service.tenant_id and link.service_id = service.id order by location.name) as locations
      from services as service
      where service.tenant_id = ${context.tenantId} and service.template_id = ${templateId}
      order by service.name, service.id
    `);
    return {
      ...viewOf(row, copies.length),
      copies: copies.map((copy) => ({ serviceId: copy.id, name: copy.name, locationNames: copy.locations ?? [], templateVersion: copy.template_version, outOfDate: copy.template_version < row.version })),
    };
  });
}

export async function createTemplate(context: StaffContext, input: CreateTemplateInput): Promise<TemplateView> {
  requirePermission(context, "services.manage");
  return withTenant(context.tenantId, async (transaction) => {
    let settings = starterSettings;
    if (input.fromServiceId) {
      const setup = await loadServiceSetupIn(transaction, context.tenantId, input.fromServiceId);
      if (!setup) throw new ApiError(404, "service_not_found", "That service no longer exists.");
      settings = settingsFromSetup(setup);
    }
    const [row] = await transaction.insert(serviceTemplates).values({
      tenantId: context.tenantId, name: input.name, settings, lockedFields: input.lockedFields, createdByUserId: context.userId,
    }).returning();
    if (!row) throw new Error("Template insert did not return a row");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "service_template.created", outcome: "success",
      metadata: { templateId: row.id, fromService: Boolean(input.fromServiceId), locked: input.lockedFields },
    });
    return viewOf(row, 0);
  });
}

async function summarise(transaction: Tx, context: StaffContext, row: typeof serviceTemplates.$inferSelect, next: { name: string; settings: TemplateSettings; lockedFields: LockableField[] }): Promise<PublishSummary> {
  const before = viewOf(row, 0);
  const changed = changedLockFields({ name: before.name, settings: before.settings, lockedFields: before.lockedFields }, next);
  const ids = await copyIds(transaction, context.tenantId, row.id);
  let local = 0;
  for (const id of ids) {
    const setup = await loadServiceSetupIn(transaction, context.tenantId, id);
    if (setup && hasLocalChanges(next, setup)) local += 1;
  }
  const words = profileWords(await loadBusinessProfileIn(transaction, context.tenantId));
  const base = { changedFields: changed, servicesUpdated: ids.length, servicesWithLocalChanges: local, changesPrices: changed.includes("prices") || changed.includes("lengths") && JSON.stringify(before.settings.lengths.map((length) => [length.minutes, length.priceMinor])) !== JSON.stringify(next.settings.lengths.map((length) => [length.minutes, length.priceMinor])) };
  return { ...base, sentence: publishSentence(base, { service: words.service, services: words.services }) };
}

/** Gives every booking that never carried its own price the price in force now, so a price change leaves it alone. */
async function freezeBookedPrices(transaction: Tx, tenantId: string, templateId: string): Promise<void> {
  await transaction.execute(sql`
    update appointments as appointment set price_minor = service.price_minor
    from services as service
    where service.tenant_id = ${tenantId} and service.template_id = ${templateId}
      and appointment.tenant_id = service.tenant_id and appointment.service_id = service.id
      and appointment.price_minor is null and service.price_minor is not null
  `);
}

async function bringCopyInLine(transaction: Tx, context: StaffContext, template: { id: string; name: string; settings: TemplateSettings }, fields: readonly LockableField[], copy: ServiceSetup, version: number): Promise<void> {
  const patch = patchFromTemplate(template, fields, copy);
  if (Object.keys(patch).length > 0) await applyServicePatchIn(transaction, context, copy.id, patch, undefined, { fromTemplate: true });
  // The template and its version are set together: a service either follows a template at some version or follows none.
  await transaction.execute(sql`update services set template_id = ${template.id}, template_version = ${version} where tenant_id = ${context.tenantId} and id = ${copy.id}`);
}

/** Save the template. With `dryRun` it only says what publishing would do. Publishing updates every copy's locked fields atomically. */
export async function updateTemplate(context: StaffContext, templateId: string, input: UpdateTemplateInput): Promise<{ template: TemplateView; summary: PublishSummary; published: boolean }> {
  requirePermission(context, "services.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const row = await loadTemplate(transaction, context.tenantId, templateId, true);
    if (row.version !== input.expectedVersion) throw versionConflict();
    const current = viewOf(row, 0);
    const next = { name: input.name ?? current.name, settings: input.settings ?? current.settings, lockedFields: input.lockedFields ?? current.lockedFields };
    const summary = await summarise(transaction, context, row, next);
    if (input.dryRun) return { template: { ...current, ...next, copyCount: summary.servicesUpdated }, summary, published: false };

    const version = row.version + 1;
    if (summary.changesPrices) await freezeBookedPrices(transaction, context.tenantId, templateId);
    const [saved] = await transaction.update(serviceTemplates).set({ name: next.name, settings: next.settings, lockedFields: next.lockedFields, version, updatedAt: new Date() })
      .where(and(eq(serviceTemplates.tenantId, context.tenantId), eq(serviceTemplates.id, templateId))).returning();
    if (!saved) throw new Error("Template update did not return a row");
    for (const id of await copyIds(transaction, context.tenantId, templateId)) {
      const setup = await loadServiceSetupIn(transaction, context.tenantId, id);
      if (setup) await bringCopyInLine(transaction, context, { id: templateId, ...next }, next.lockedFields, setup, version);
    }
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "service_template.published", outcome: "success",
      metadata: { templateId, version, services: summary.servicesUpdated, changed: summary.changedFields, locked: next.lockedFields },
    });
    return { template: viewOf(saved, summary.servicesUpdated), summary, published: true };
  });
}

/** Deleting a template keeps its services: they become ordinary services with their current settings. */
export async function deleteTemplate(context: StaffContext, templateId: string): Promise<{ removed: true; unlinked: number }> {
  requirePermission(context, "services.manage");
  return withTenant(context.tenantId, async (transaction) => {
    await loadTemplate(transaction, context.tenantId, templateId, true);
    const ids = await copyIds(transaction, context.tenantId, templateId);
    await transaction.execute(sql`update services set template_id = null, template_version = null where tenant_id = ${context.tenantId} and template_id = ${templateId}`);
    await transaction.delete(serviceTemplates).where(and(eq(serviceTemplates.tenantId, context.tenantId), eq(serviceTemplates.id, templateId)));
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "service_template.deleted", outcome: "success", metadata: { templateId, unlinked: ids.length },
    });
    return { removed: true as const, unlinked: ids.length };
  });
}

/** A real service made from the template for one branch. Every template setting is copied; the lock list only matters later. */
async function createCopy(transaction: Tx, context: StaffContext, template: { id: string; name: string; settings: TemplateSettings; version: number }, location: { id: string; name: string }, practitionerIds: string[]): Promise<string> {
  const slug = await uniqueServiceSlug(transaction, context.tenantId, slugify(`${template.name}-${location.name}`));
  const usual = template.settings.lengths.find((length) => length.isDefault) ?? template.settings.lengths[0];
  const [created] = await transaction.insert(services).values({
    tenantId: context.tenantId, slug, name: template.name, description: template.settings.description,
    durationMinutes: usual?.minutes ?? 30, mode: "instant", patientTypes: ["new", "returning"],
  }).returning({ id: services.id });
  if (!created) throw new Error("Service insert returned no row");
  await transaction.insert(serviceDurations).values({ tenantId: context.tenantId, serviceId: created.id, minutes: usual?.minutes ?? 30, priceMinor: usual?.priceMinor ?? null, isDefault: true, sortOrder: 0 });
  await transaction.insert(serviceLocationOptions).values({ tenantId: context.tenantId, serviceId: created.id, kind: "in_person", locationId: location.id, sortOrder: 0 });
  await transaction.insert(serviceLocations).values({ tenantId: context.tenantId, serviceId: created.id, locationId: location.id });
  if (practitionerIds.length > 0) {
    await transaction.insert(practitionerServices).values(practitionerIds.map((practitionerId) => ({ tenantId: context.tenantId, practitionerId, serviceId: created.id })));
  }
  const setup = await loadServiceSetupIn(transaction, context.tenantId, created.id);
  if (!setup) throw new Error("A new service could not be read back");
  await bringCopyInLine(transaction, context, template, lockableFields, setup, template.version);
  return created.id;
}

export async function assignTemplate(context: StaffContext, templateId: string, input: AssignTemplateInput): Promise<{ created: string[]; linked: string[] }> {
  requirePermission(context, "services.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const row = await loadTemplate(transaction, context.tenantId, templateId, true);
    const template = viewOf(row, 0);
    const created: string[] = [];
    const linked: string[] = [];
    for (const locationId of [...new Set(input.locationIds)]) {
      const [location] = await transaction.execute<{ id: string; name: string }>(sql`select id, name from locations where tenant_id = ${context.tenantId} and id = ${locationId} and is_active`);
      if (!location) throw new ApiError(400, "validation_error", "Choose branches that belong to this business.", { locationIds: ["Choose branches that belong to this business."] });
      const here = await transaction.execute<{ id: string }>(sql`
        select practitioner.id from practitioners as practitioner
        join practitioner_locations as link on link.tenant_id = practitioner.tenant_id and link.practitioner_id = practitioner.id and link.location_id = ${locationId}
        where practitioner.tenant_id = ${context.tenantId} and practitioner.is_active`);
      const wanted = input.practitionerIds ? new Set(input.practitionerIds) : null;
      const people = here.map((person) => person.id).filter((id) => !wanted || wanted.has(id));
      created.push(await createCopy(transaction, context, { id: row.id, name: row.name, settings: template.settings, version: row.version }, location, people));
    }
    for (const serviceId of [...new Set(input.linkServiceIds)]) {
      const setup = await loadServiceSetupIn(transaction, context.tenantId, serviceId, { lock: true });
      if (!setup) throw new ApiError(404, "service_not_found", "One of those services no longer exists.");
      const [state] = await transaction.execute<{ template_id: string | null }>(sql`select template_id from services where tenant_id = ${context.tenantId} and id = ${serviceId}`);
      if (state?.template_id && state.template_id !== templateId) throw new ApiError(409, "already_templated", "One of those services already follows another template. Unlink it first.");
      if (state?.template_id !== templateId && template.lockedFields.some((field) => field === "prices" || field === "lengths")) await freezeServicePrices(transaction, context.tenantId, serviceId);
      await bringCopyInLine(transaction, context, { id: templateId, name: row.name, settings: template.settings }, template.lockedFields, setup, row.version);
      linked.push(serviceId);
    }
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "service_template.assigned", outcome: "success",
      metadata: { templateId, created: created.length, linked: linked.length },
    });
    return { created, linked };
  });
}

async function freezeServicePrices(transaction: Tx, tenantId: string, serviceId: string): Promise<void> {
  await transaction.execute(sql`
    update appointments as appointment set price_minor = service.price_minor
    from services as service
    where service.tenant_id = ${tenantId} and service.id = ${serviceId}
      and appointment.tenant_id = service.tenant_id and appointment.service_id = service.id
      and appointment.price_minor is null and service.price_minor is not null`);
}

/** The copy keeps its current settings and becomes a normal service. */
export async function unlinkServices(context: StaffContext, templateId: string, serviceIds: string[]): Promise<{ unlinked: number }> {
  requirePermission(context, "services.manage");
  return withTenant(context.tenantId, async (transaction) => {
    await loadTemplate(transaction, context.tenantId, templateId);
    const rows = await transaction.execute<{ id: string }>(sql`
      update services set template_id = null, template_version = null
      where tenant_id = ${context.tenantId} and template_id = ${templateId}
        and id in (${sql.join(serviceIds.map((id) => sql`${id}`), sql`, `)})
      returning id`);
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "service_template.unlinked", outcome: "success", metadata: { templateId, unlinked: rows.length },
    });
    return { unlinked: rows.length };
  });
}
