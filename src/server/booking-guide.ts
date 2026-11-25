import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents, services, tenants } from "@/db/schema";
import { bookingGuideSchema, parseStoredGuide, starterGuide, type BookingGuide } from "@/lib/booking-guide";
import type { Clinic, Service } from "@/lib/domain";
import { previewServicesFor } from "@/lib/preview-sample";
import { resolveBusinessProfile } from "@/lib/terminology";

import { ApiError } from "./api-error";
import { previewBusinessClinic } from "./business-profile";
import { requirePermission, type StaffContext } from "./staff-context";

interface PreviewGuideStore {
  /** Undefined until the preview owner saves; the sample guide shows until then. */
  guide?: BookingGuide;
}

const previewGlobals = globalThis as typeof globalThis & { kalendrPreviewGuide?: PreviewGuideStore };

function previewStore(): PreviewGuideStore {
  previewGlobals.kalendrPreviewGuide ??= {};
  return previewGlobals.kalendrPreviewGuide;
}

export function resetPreviewGuideForTests(): void {
  previewGlobals.kalendrPreviewGuide = {};
}

/** The preview's guide: what the preview owner saved, or a sample built from the sample services. */
export function previewGuide(clinic: Pick<Clinic, "businessType">, sampleServices: readonly Service[] = previewServicesFor(clinic)): BookingGuide {
  return previewStore().guide ?? starterGuide(resolveBusinessProfile(clinic).businessType, sampleServices);
}

/** One business's stored guide inside a tenant transaction. Null when none is saved. */
export async function loadGuideIn(transaction: KalendrTransaction, tenantId: string): Promise<BookingGuide | null> {
  const [row] = await transaction.execute<{ guide: unknown }>(sql`select guide from tenants where id = ${tenantId}`);
  return parseStoredGuide(row?.guide);
}

/** The guide for the builder, switched off or not. Null when the business has not made one. */
export async function getStaffGuide(context: StaffContext): Promise<BookingGuide | null> {
  requirePermission(context, "settings.manage");
  if (context.preview) return previewGuide(await previewBusinessClinic());
  return withTenant(context.tenantId, (transaction) => loadGuideIn(transaction, context.tenantId));
}

function parseGuide(input: unknown): BookingGuide {
  const parsed = bookingGuideSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.join(".") || "guide";
    (fieldErrors[path] ??= []).push(issue.message);
  }
  throw new ApiError(422, "guide_invalid", parsed.error.issues[0]?.message ?? "Check the questions and try again.", fieldErrors);
}

function guideServiceIds(guide: BookingGuide): string[] {
  return [...new Set(guide.questions.flatMap((question) => question.options.flatMap((option) => option.serviceIds)))];
}

function serviceGone(): ApiError {
  return new ApiError(422, "guide_invalid", "One of the chosen services no longer exists.", { questions: ["One of the chosen services no longer exists."] });
}

/** Saves the guide. Owners and admins only, and audited. Every service an answer points at must exist. */
export async function saveStaffGuide(context: StaffContext, input: unknown): Promise<BookingGuide> {
  requirePermission(context, "settings.manage");
  if (context.role !== "owner" && context.role !== "admin") {
    throw new ApiError(403, "forbidden", "Only the owner or an admin can change these questions.");
  }
  const guide = parseGuide(input);
  const serviceIds = guideServiceIds(guide);
  if (context.preview) {
    const known = new Set(previewServicesFor(await previewBusinessClinic()).map((service) => service.id));
    if (serviceIds.some((id) => !known.has(id))) throw serviceGone();
    previewStore().guide = guide;
    return guide;
  }
  return withTenant(context.tenantId, async (transaction) => {
    if (serviceIds.length > 0) {
      const rows = await transaction
        .select({ id: services.id })
        .from(services)
        .where(and(eq(services.tenantId, context.tenantId), inArray(services.id, serviceIds)));
      if (rows.length !== serviceIds.length) throw serviceGone();
    }
    await transaction.update(tenants).set({ guide: { ...guide }, updatedAt: new Date() }).where(eq(tenants.id, context.tenantId));
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
      action: "settings.booking_guide", outcome: "success",
      metadata: { isActive: guide.isActive, questions: guide.questions.length, answers: guide.questions.reduce((count, question) => count + question.options.length, 0) },
    });
    return guide;
  });
}
