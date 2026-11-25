import { cancelPresetInputSchema } from "@/lib/cancel-policy";
import { createCancelPreset, listCancelPresets } from "@/server/cancel-presets";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await listCancelPresets(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.cancel_presets.list", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await createCancelPreset(context, await parseJsonBody(request, cancelPresetInputSchema)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.cancel_presets.create", requestId);
  }
}
