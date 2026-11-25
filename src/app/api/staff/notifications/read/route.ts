import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { markNotificationsRead, markReadInputSchema } from "@/server/staff-notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const input = await parseJsonBody(request, markReadInputSchema, { maxBytes: 4_000 });
    return dataResponse(await markNotificationsRead(context, input));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.notifications.read", requestId);
  }
}
