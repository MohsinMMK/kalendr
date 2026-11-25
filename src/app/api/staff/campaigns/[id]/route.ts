import { campaignUpdateSchema } from "@/lib/campaign-contracts";
import { customerIdSchema } from "@/lib/customer-contracts";
import { deleteCampaign, getCampaign, updateCampaign } from "@/server/campaigns/service";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getCampaign(await getStaffContext(request.headers), customerIdSchema.parse((await params).id)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.campaigns.get", requestId);
  }
}

export async function PUT(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await updateCampaign(context, customerIdSchema.parse((await params).id), await parseJsonBody(request, campaignUpdateSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.campaigns.update", requestId);
  }
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await deleteCampaign(context, customerIdSchema.parse((await params).id)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.campaigns.delete", requestId);
  }
}
