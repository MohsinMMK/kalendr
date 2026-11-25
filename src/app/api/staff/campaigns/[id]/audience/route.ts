import { customerIdSchema } from "@/lib/customer-contracts";
import { previewAudience } from "@/server/campaigns/service";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who the campaign reaches right now, how many were left out and why, and the cost estimate for WhatsApp and text. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await previewAudience(await getStaffContext(request.headers), customerIdSchema.parse((await params).id)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.campaigns.audience", requestId);
  }
}
