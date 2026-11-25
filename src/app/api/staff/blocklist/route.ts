import { blocklistEntryInput } from "@/lib/spam-contact";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { addBlocklistEntry, listBlocklist } from "@/server/spam";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse({ entries: await listBlocklist(await getStaffContext(request.headers)) });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.blocklist.list", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await addBlocklistEntry(context, await parseJsonBody(request, blocklistEntryInput)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.blocklist.add", requestId);
  }
}
