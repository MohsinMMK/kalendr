import "server-only";

import { eq } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import {
  formDefinitions, practitionerServices, serviceDurations, serviceLocationOptions, serviceLocations, services, tenants,
} from "@/db/schema";
import { cleanTerminologyOverrides } from "@/lib/terminology";
import { serviceOrderList, serviceOrderPage, type WorkspaceLayout } from "@/lib/workspace-layout";
import { questionField, type OnboardingTemplate } from "@/lib/onboarding-templates";

import { ensureDefaultSchedule, replaceScheduleRules } from "../availability-admin";
import { slugify, uniqueServiceSlug } from "../services-admin";

/**
 * Fills a new business from its template (feature 11), in the registration transaction: the services with their
 * lengths and prices, offered at the first place and by the owner when they take bookings; the owner's opening hours;
 * one question on the booking form; and the business's own words. Reminder workflows are applied by the caller
 * (`applyWorkflowPresets`). The template's first service is the ready-made general visit; the saved service order keeps it first. Nothing here sends anything or calls out.
 */
export async function seedFromTemplate(
  transaction: KalendrTransaction,
  input: { tenantId: string; locationId: string; practitionerId: string | null; timezone: string; template: OnboardingTemplate },
): Promise<{ serviceIds: string[] }> {
  const { tenantId, locationId, practitionerId, template, timezone } = input;
  const serviceIds: string[] = [];
  for (const [index, service] of template.services.entries()) {
    const priceMinor = service.priceRupees ? service.priceRupees * 100 : null;
    const [created] = await transaction.insert(services).values({
      tenantId,
      slug: await uniqueServiceSlug(transaction, tenantId, slugify(service.name)),
      name: service.name,
      description: service.description,
      durationMinutes: service.durationMinutes,
      mode: service.bookingMode,
      patientTypes: ["new", "returning"],
      ...(priceMinor ? { priceLabel: `₹${service.priceRupees}`, priceMinor } : {}),
    }).returning({ id: services.id });
    if (!created) throw new Error("Service insert returned no row");
    serviceIds.push(created.id);
    await transaction.insert(serviceDurations).values({ tenantId, serviceId: created.id, minutes: service.durationMinutes, priceMinor, isDefault: true, sortOrder: 0 });
    await transaction.insert(serviceLocationOptions).values({ tenantId, serviceId: created.id, kind: "in_person", locationId, sortOrder: index });
    await transaction.insert(serviceLocations).values({ tenantId, serviceId: created.id, locationId });
    if (practitionerId) await transaction.insert(practitionerServices).values({ tenantId, practitionerId, serviceId: created.id });
  }
  if (practitionerId) {
    const schedule = await ensureDefaultSchedule(transaction, tenantId, practitionerId, timezone);
    await replaceScheduleRules(transaction, { tenantId, scheduleId: schedule.id, practitionerId, timezone, weekly: template.hours, locationIds: [locationId] });
  }
  await transaction.insert(formDefinitions).values({
    tenantId,
    key: "form_welcome",
    version: 1,
    name: "Before you come",
    description: "A question we ask when you book.",
    fields: [questionField(template.question)],
    isActive: true,
    isCurrent: true,
    appliesToAll: true,
  });
  const words = cleanTerminologyOverrides(template.words);
  if (Object.keys(words).length > 0) await transaction.update(tenants).set({ terminology: words }).where(eq(tenants.id, tenantId));
  // The template's first service is the general visit. Services otherwise list by name, so save the template's order to keep it first.
  if (serviceIds.length > 1) {
    const layout: WorkspaceLayout = { pages: { [serviceOrderPage]: { lists: { [serviceOrderList]: { order: serviceIds } } } } };
    await transaction.update(tenants).set({ layout }).where(eq(tenants.id, tenantId));
  }
  return { serviceIds };
}
