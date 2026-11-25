import { z } from "zod";

import { assignTemplateInput, unlinkTemplateInput } from "@/lib/service-templates";
import { ApiError } from "@/server/api-error";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assignTemplate, unlinkServices } from "@/server/service-templates";
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

/** Makes a service in each chosen branch and links any existing services chosen. */
export async function POST(request: Request, route: Route): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await assignTemplate(context, await templateId(route), await parseJsonBody(request, assignTemplateInput)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.service-templates.assign", requestId);
  }
}

/** Unlinks copies: they keep their current settings and become normal services. */
export async function DELETE(request: Request, route: Route): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await unlinkServices(context, await templateId(route), (await parseJsonBody(request, unlinkTemplateInput)).serviceIds));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.service-templates.unlink", requestId);
  }
}
