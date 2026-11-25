import { presetActivationSchema } from "@/lib/campaign-contracts";
import { activatePreset } from "@/server/campaigns/service";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Turns on a ready-made campaign in one step. */
export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { key } = await params;
    return dataResponse(await activatePreset(context, key.slice(0, 40), await parseJsonBody(request, presetActivationSchema), getIdempotencyKey(request)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.campaigns.preset", requestId);
  }
}
