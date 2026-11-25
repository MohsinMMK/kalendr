import { z } from "zod";

import { serviceSetupUpdateSchema } from "@/lib/service-setup";
import { staffUpdateServiceSchema } from "@/server/contracts";
import { parseJsonBody, dataResponse, routeErrorResponse } from "@/server/http";
import { applyServiceSetupPatch, deleteService, getServiceSetup, updateServiceSetup } from "@/server/services-admin";
import { getStaffContext, requirePermission } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The editor's save and the older quick edits share this route; the groups tell them apart. */
const updateBodySchema = z.union([serviceSetupUpdateSchema, staffUpdateServiceSchema]);

/** Drops the fields the older quick edit left out, so they do not overwrite what is stored. */
function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    requirePermission(staff, "settings.manage");
    const { id } = await context.params;
    return dataResponse(await getServiceSetup(staff, id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.service.read", requestId);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    requirePermission(staff, "settings.manage");
    const { id } = await context.params;
    const input = await parseJsonBody(request, updateBodySchema);
    if ("basics" in input || "timing" in input || "lengths" in input || "locationOptions" in input || "look" in input || "bookingPage" in input || "intake" in input) {
      return dataResponse(await updateServiceSetup(staff, id, input));
    }
    const { durationMinutes, priceLabel, ...basics } = input as z.infer<typeof staffUpdateServiceSchema>;
    return dataResponse(await applyServiceSetupPatch(staff, id, {
      ...(Object.keys(basics).some((key) => basics[key as keyof typeof basics] !== undefined) ? { basics: definedOnly(basics) } : {}),
      ...(durationMinutes !== undefined ? { durationMinutes } : {}),
      ...(priceLabel !== undefined ? { priceLabel } : {}),
    }));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.service.update", requestId);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    requirePermission(staff, "settings.manage");
    const { id } = await context.params;
    return dataResponse(await deleteService(staff, id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.service.delete", requestId);
  }
}
