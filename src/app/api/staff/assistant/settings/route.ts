import { assistantSettingsUpdateSchema } from "@/lib/assistant-contracts";
import { getAssistantSettings, updateAssistantSettings } from "@/server/assistant/settings";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getAssistantSettings(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.assistant.settings.read", requestId);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await updateAssistantSettings(context, await parseJsonBody(request, assistantSettingsUpdateSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.assistant.settings.update", requestId);
  }
}
