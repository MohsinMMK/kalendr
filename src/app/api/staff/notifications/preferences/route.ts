import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { listPreferences, preferencesInputSchema, setPreference } from "@/server/staff-notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await listPreferences(context));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.notifications.preferences", requestId);
  }
}

/** One switch at a time: which kind, and whether it shows in the app and whether it pushes. */
export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const input = await parseJsonBody(request, preferencesInputSchema, { maxBytes: 1_000 });
    return dataResponse(await setPreference(context, input));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.notifications.preferences.set", requestId);
  }
}
