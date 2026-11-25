import { dataResponse, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, getStaffContext } from "@/server/staff-context";
import { regenerateDomainRecord } from "@/server/enterprise/domains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotImpersonating(context);
    const { id } = await params;
    return dataResponse(await regenerateDomainRecord(context, id), 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.org.domains.record", requestId);
  }
}
