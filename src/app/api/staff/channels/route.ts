import { channelSettingsInput } from "@/lib/inbox-contracts";
import { getChannelSettings, updateChannelSettings } from "@/server/channel-settings";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which channels this business has on, and where its approved templates stand. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getChannelSettings(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.channels.get", requestId);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    assertNotImpersonating(staff);
    return dataResponse(await updateChannelSettings(staff, await parseJsonBody(request, channelSettingsInput)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.channels.update", requestId);
  }
}
