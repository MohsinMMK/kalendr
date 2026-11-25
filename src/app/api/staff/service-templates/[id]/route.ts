import { z } from "zod";

import { updateTemplateInput } from "@/lib/service-templates";
import { ApiError } from "@/server/api-error";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { deleteTemplate, getTemplate, updateTemplate } from "@/server/service-templates";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
type Route = { params: Promise<{ id: string }> };

async function templateId(route: Route): Promise<string> {
  const parsed = idSchema.safeParse((await route.params).id);
  if (!parsed.success) throw new ApiError(404, "template_not_found", "That template no longer exists.");
  return parsed.data;
}

export async function GET(request: Request, route: Route): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await getTemplate(context, await templateId(route)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.service-templates.get", requestId);
  }
}

/** Saves and publishes a change to every copy. With `dryRun: true` it only returns the summary staff confirm first. */
export async function PATCH(request: Request, route: Route): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await updateTemplate(context, await templateId(route), await parseJsonBody(request, updateTemplateInput)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.service-templates.update", requestId);
  }
}

export async function DELETE(request: Request, route: Route): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await deleteTemplate(context, await templateId(route)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.service-templates.delete", requestId);
  }
}
