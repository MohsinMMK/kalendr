import { createTemplateInput } from "@/lib/service-templates";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { createTemplate, listTemplates } from "@/server/service-templates";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse({ templates: await listTemplates(await getStaffContext(request.headers)) });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.service-templates.list", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await createTemplate(context, await parseJsonBody(request, createTemplateInput)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.service-templates.create", requestId);
  }
}
