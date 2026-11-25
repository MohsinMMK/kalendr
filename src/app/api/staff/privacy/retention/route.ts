import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { getRetentionSettings, retentionInputSchema, saveRetentionSettings } from "@/server/privacy/retention-settings";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long each kind of data is kept. Needs privacy.manage or settings.manage. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await getRetentionSettings(context));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.privacy.retention.get", requestId);
  }
}

/** Saves the periods. Needs a second-factor check from the last 10 minutes. Setting the same values again changes nothing. */
export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    assertNotImpersonating(context);
    const input = await parseJsonBody(request, retentionInputSchema);
    return dataResponse(await saveRetentionSettings(context, input));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.privacy.retention.put", requestId);
  }
}
