import { dataResponse, enforceLimit, routeErrorResponse } from "@/server/http";
import { requirePatientAccount } from "@/server/patient-auth";
import { signOutOtherPatientDevices } from "@/server/patient-devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const account = await requirePatientAccount(request.headers);
    await enforceLimit(request, "portal_devices.account", account.id);
    return dataResponse({ signedOut: await signOutOtherPatientDevices(account, request.headers) });
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.devices.sign_out_others", requestId);
  }
}
