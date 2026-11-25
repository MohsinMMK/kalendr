import "server-only";

import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { withTenant } from "@/db/client";
import { locations, serviceLocations, services, tenants } from "@/db/schema";
import { bookingPageUrl } from "@/lib/embed/builder";
import { dayInZone, EMAIL_TIME_COUNT, emailTimesHtml, formatEmailTime, type EmailTime } from "@/lib/embed/email-times";

import { ApiError } from "./api-error";
import { listAvailabilityDetailed } from "./appointment-repository";
import { appOrigin } from "./env";
import { requirePermission, type StaffContext } from "./staff-context";

export const emailTimesQuerySchema = z.object({ serviceId: z.string().min(1).max(64) });

export interface EmailTimesView {
  times: EmailTime[];
  html: string;
}

/** The next open times for a service, as a snapshot a manager can paste into an email. */
export async function emailTimesFor(context: StaffContext, serviceId: string): Promise<EmailTimesView> {
  requirePermission(context, "settings.manage");
  if (context.preview) throw new ApiError(409, "preview_only", "Times for an email need a database.");
  const found = await withTenant(context.tenantId, async (transaction) => {
    const [service] = await transaction.select({ id: services.id, name: services.name, slug: services.slug }).from(services)
      .where(and(eq(services.tenantId, context.tenantId), eq(services.id, serviceId), eq(services.isActive, true))).limit(1);
    if (!service) return null;
    const [place] = await transaction.select({ id: locations.id }).from(serviceLocations)
      .innerJoin(locations, and(eq(locations.tenantId, serviceLocations.tenantId), eq(locations.id, serviceLocations.locationId)))
      .where(and(eq(serviceLocations.tenantId, context.tenantId), eq(serviceLocations.serviceId, serviceId), eq(locations.isActive, true)))
      .orderBy(asc(locations.name)).limit(1);
    const [tenant] = await transaction.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, context.tenantId)).limit(1);
    return { service, locationId: place?.id ?? null, timezone: tenant?.timezone ?? "UTC" };
  });
  if (!found) throw new ApiError(404, "service_not_found", "That service was not found.");
  if (!found.locationId) throw new ApiError(409, "no_location", "This service has no place to book yet.");

  const listing = await listAvailabilityDetailed({
    clinicSlug: context.clinicSlug, locationId: found.locationId, serviceId, practitionerId: "first_available",
  });
  const origin = appOrigin();
  const page = bookingPageUrl(origin, context.clinicSlug, found.service.slug);
  const seen = new Set<string>();
  const times: EmailTime[] = [];
  for (const slot of listing.slots) {
    if (seen.has(slot.startsAt)) continue;
    seen.add(slot.startsAt);
    const start = new Date(slot.startsAt);
    const query = new URLSearchParams({ date: dayInZone(start, found.timezone), time: slot.startsAt });
    times.push({ startsAt: slot.startsAt, label: formatEmailTime(start, found.timezone), href: `${page}?${query.toString()}` });
    if (times.length === EMAIL_TIME_COUNT) break;
  }
  return { times, html: emailTimesHtml(context.clinicName, found.service.name, times, page) };
}

export interface EmbedContextView {
  clinicSlug: string;
  clinicName: string;
  origin: string;
  services: { id: string; slug: string; name: string; hidden: boolean }[];
}

/** What the share sheet needs: the business's address name, the site address and its services. */
export async function embedContextFor(context: StaffContext): Promise<EmbedContextView> {
  requirePermission(context, "settings.manage");
  const rows = context.preview ? [] : await withTenant(context.tenantId, (transaction) =>
    transaction.select({ id: services.id, slug: services.slug, name: services.name, visibility: services.visibility }).from(services)
      .where(and(eq(services.tenantId, context.tenantId), eq(services.isActive, true))).orderBy(asc(services.name)));
  return {
    clinicSlug: context.clinicSlug, clinicName: context.clinicName, origin: appOrigin(),
    services: rows.map((row) => ({ id: row.id, slug: row.slug, name: row.name, hidden: row.visibility === "hidden" })),
  };
}
