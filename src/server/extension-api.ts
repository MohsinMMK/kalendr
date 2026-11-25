import "server-only";

import { and, asc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { withTenant } from "@/db/client";
import { services } from "@/db/schema";
import { bookingPageUrl } from "@/lib/embed/builder";
import type { Permission } from "@/lib/permissions";
import { ApiError } from "@/server/api-error";
import { staffContextFor, type ApiKeyContext } from "@/server/api-key-context";
import { emailTimesFor } from "@/server/email-times";
import { appOrigin } from "@/server/env";
import { createSpecialLink } from "@/server/special-links";
import type { StaffContext } from "@/server/staff-context";

/**
 * What the browser extension (feature 57) may call. Four small reads and one write, each behind its own narrow scope.
 * They build a staff-shaped identity that holds only the one permission the shared code asks for, so nothing else the
 * key's holder could do in the app is reachable from here.
 */

function narrowContext(context: ApiKeyContext, permission: Permission): StaffContext {
  return { ...staffContextFor(context), permissions: [permission], role: "read_only" };
}

export interface ExtensionMe {
  businessName: string;
  businessSlug: string;
  appName: string;
  scopes: string[];
}

export function extensionMe(context: ApiKeyContext): ExtensionMe {
  return { businessName: context.clinicName, businessSlug: context.clinicSlug, appName: "Kalendr", scopes: [...context.scopes] };
}

export interface ExtensionService {
  id: string;
  name: string;
  /** The public booking page for this service. */
  url: string;
  hidden: boolean;
  durationMinutes: number;
}

export async function extensionServices(context: ApiKeyContext): Promise<ExtensionService[]> {
  const rows = await withTenant(context.tenantId, (transaction) => transaction
    .select({ id: services.id, slug: services.slug, name: services.name, visibility: services.visibility, durationMinutes: services.durationMinutes })
    .from(services).where(and(eq(services.tenantId, context.tenantId), eq(services.isActive, true))).orderBy(asc(services.name)).limit(200));
  const origin = appOrigin();
  return rows.map((row) => ({
    id: row.id, name: row.name, hidden: row.visibility === "hidden", durationMinutes: row.durationMinutes,
    url: bookingPageUrl(origin, context.clinicSlug, row.slug),
  }));
}

export const extensionEmailTimesQuery = z.object({ serviceId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) });

export async function extensionEmailTimes(context: ApiKeyContext, serviceId: string) {
  return emailTimesFor(narrowContext(context, "settings.manage"), serviceId);
}

export const extensionLinkBody = z.object({
  serviceId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  // Typed by the person into the extension, so it is stored as the link's label and never logged.
  label: z.string().trim().max(80).optional(),
}).strict();

export async function extensionCreateLink(context: ApiKeyContext, input: z.infer<typeof extensionLinkBody>): Promise<{ url: string; id: string }> {
  const label = input.label && input.label.length > 0 ? input.label : "From the browser extension";
  const created = await createSpecialLink(narrowContext(context, "services.manage"), input.serviceId, { label, kind: "single_use" });
  return { id: created.id, url: `${appOrigin().replace(/\/$/, "")}${created.path}` };
}

export interface ExtensionBooking {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  serviceName: string;
  /** First name only. The extension never receives a surname, phone number or email. */
  firstName: string;
}

interface TodayRow extends Record<string, unknown> {
  id: string; starts_at: Date; ends_at: Date; status: string; service_name: string; first_name: string;
}

/** Today in the business's own time zone, not the browser's. */
export async function extensionToday(context: ApiKeyContext): Promise<{ date: string; timezone: string; bookings: ExtensionBooking[] }> {
  return withTenant(context.tenantId, async (transaction) => {
    const [tenant] = await transaction.execute<{ timezone: string; today: string; day_start: Date; day_end: Date }>(sql`
      select timezone,
        (now() at time zone timezone)::date::text as today,
        (date_trunc('day', now() at time zone timezone)) at time zone timezone as day_start,
        (date_trunc('day', now() at time zone timezone) + interval '1 day') at time zone timezone as day_end
      from tenants where id = ${context.tenantId}`);
    if (!tenant) throw new ApiError(404, "not_found", "Business not found.");
    const rows = await transaction.execute<TodayRow>(sql`
      select appointment.id, appointment.starts_at, appointment.ends_at, appointment.status, service.name as service_name, patient.first_name
      from appointments as appointment
      join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
      join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
      where appointment.tenant_id = ${context.tenantId}
        and appointment.starts_at >= ${tenant.day_start} and appointment.starts_at < ${tenant.day_end}
        and appointment.status in ('requested', 'booked', 'checked_in', 'completed')
      order by appointment.starts_at, appointment.id
      limit 200`);
    return {
      date: tenant.today,
      timezone: tenant.timezone,
      bookings: rows.map((row) => ({
        id: row.id, startsAt: new Date(row.starts_at).toISOString(), endsAt: new Date(row.ends_at).toISOString(),
        status: row.status, serviceName: row.service_name, firstName: row.first_name,
      })),
    };
  });
}
