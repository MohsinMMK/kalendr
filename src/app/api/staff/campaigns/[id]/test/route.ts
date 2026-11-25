import { campaignTestSchema } from "@/lib/campaign-contracts";
import { customerIdSchema } from "@/lib/customer-contracts";
import { requestTestSend } from "@/server/campaigns/service";
import { dataResponse, enforceLimit, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sends the campaign to the person asking, as a real customer would get it. Nothing goes to a customer. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    await enforceLimit(request, "campaign_test.tenant", context.tenantId);
    return dataResponse(await requestTestSend(context, customerIdSchema.parse((await params).id), await parseJsonBody(request, campaignTestSchema), getIdempotencyKey(request)), 202);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.campaigns.test", requestId);
  }
}
