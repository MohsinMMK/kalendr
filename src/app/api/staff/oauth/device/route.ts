import { z } from "zod";

import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { decideDevice, previewDevice } from "@/server/oauth/device";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({ code: z.string().min(1).max(40), approve: z.boolean().optional() }).strict();

/** Looks the code up and shows what the app would be allowed to do. Nothing is granted by asking. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    assertNotImpersonating(context);
    const input = await parseJsonBody(request, body);
    if (input.approve === undefined) return dataResponse(await previewDevice(context, input.code));
    return dataResponse(await decideDevice(context, input.code, input.approve));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.oauth.device", requestId);
  }
}
