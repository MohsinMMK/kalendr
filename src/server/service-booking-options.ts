import "server-only";

import { sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents } from "@/db/schema";
import type { ServiceBookingOptions, ServiceBookingOptionsInput } from "@/lib/service-booking-options";

import { ApiError } from "./api-error";
import { isPreviewMode } from "./preview-repository";
import { requirePermission, type StaffContext } from "./staff-context";

function refusePreview(context: StaffContext): void {
  if (context.preview || isPreviewMode()) throw new ApiError(409, "preview_only", "This setting can't be saved in the preview.");
}

interface Row extends Record<string, unknown> { optimized_slots: boolean; rebook_from_old_link: boolean }

const toView = (row: Row): ServiceBookingOptions => ({ optimizedSlots: row.optimized_slots, rebookFromOldLink: row.rebook_from_old_link });

export async function getServiceBookingOptions(context: StaffContext, serviceId: string): Promise<ServiceBookingOptions> {
  requirePermission(context, "settings.manage");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.execute<Row>(sql`select optimized_slots, rebook_from_old_link from services where tenant_id = ${context.tenantId} and id = ${serviceId}`);
    if (!row) throw new ApiError(404, "service_not_found", "Service not found.");
    return toView(row);
  });
}

export async function saveServiceBookingOptions(context: StaffContext, serviceId: string, input: ServiceBookingOptionsInput): Promise<ServiceBookingOptions> {
  requirePermission(context, "settings.manage");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.execute<Row>(sql`
      update services set
        optimized_slots = coalesce(${input.optimizedSlots ?? null}::boolean, optimized_slots),
        rebook_from_old_link = coalesce(${input.rebookFromOldLink ?? null}::boolean, rebook_from_old_link),
        updated_at = now()
      where tenant_id = ${context.tenantId} and id = ${serviceId}
      returning optimized_slots, rebook_from_old_link`);
    if (!row) throw new ApiError(404, "service_not_found", "Service not found.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "service.booking_options_changed", outcome: "success",
      metadata: { serviceId, ...(input.optimizedSlots !== undefined ? { optimizedSlots: input.optimizedSlots } : {}), ...(input.rebookFromOldLink !== undefined ? { rebookFromOldLink: input.rebookFromOldLink } : {}) },
    });
    return toView(row);
  });
}
