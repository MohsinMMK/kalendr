import { campaignOptions } from "@/server/campaigns/service";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The ready-made campaigns for this kind of business, the WhatsApp messages and whether each channel is connected. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await campaignOptions(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.campaigns.options", requestId);
  }
}
