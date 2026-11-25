import { listingUpdateSchema } from "@/lib/listing";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { loadListing, saveListing } from "@/server/listing";
import { assertNotReadOnlyImpersonation, getStaffContext, requirePermission } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whether the business is listed for search engines and the directory, and its share links. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await loadListing(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.settings.listing.read", requestId);
  }
}

/** Switches listing on or off and saves the page title and description. Staff who manage settings, never a read-only support session. */
export async function PATCH(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    requirePermission(context, "settings.manage");
    return dataResponse(await saveListing(context, await parseJsonBody(request, listingUpdateSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.settings.listing.update", requestId);
  }
}
