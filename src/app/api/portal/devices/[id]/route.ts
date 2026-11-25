import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { dataResponse, enforceLimit, routeErrorResponse } from "@/server/http";
import { clearedSessionCookieHeader, requirePatientAccount } from "@/server/patient-auth";
import { signOutPatientDevice } from "@/server/patient-devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const account = await requirePatientAccount(request.headers);
    await enforceLimit(request, "portal_devices.account", account.id);
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) throw new ApiError(404, "device_not_found", "That device is already signed out.");
    const { current } = await signOutPatientDevice(account, request.headers, id.data);
    const response = dataResponse({ signedOut: true, current });
    if (current) response.headers.append("Set-Cookie", clearedSessionCookieHeader());
    return response;
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.devices.sign_out", requestId);
  }
}
