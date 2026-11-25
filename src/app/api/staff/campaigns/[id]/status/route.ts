import { campaignActionSchema } from "@/lib/campaign-contracts";
import { customerIdSchema } from "@/lib/customer-contracts";
import { setCampaignStatus } from "@/server/campaigns/service";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Turn on, pause, resume or cancel. The version it was read at must still be current, so a double click or a second person changes nothing twice. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await setCampaignStatus(context, customerIdSchema.parse((await params).id), await parseJsonBody(request, campaignActionSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.campaigns.status", requestId);
  }
}
