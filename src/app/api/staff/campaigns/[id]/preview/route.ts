import { customerIdSchema } from "@/lib/customer-contracts";
import { previewMessage } from "@/server/campaigns/service";
import { appOrigin } from "@/server/env";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The message filled in with a real customer's details from the audience. Only staff see this. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await previewMessage(await getStaffContext(request.headers), customerIdSchema.parse((await params).id), appOrigin()));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.campaigns.preview", requestId);
  }
}
