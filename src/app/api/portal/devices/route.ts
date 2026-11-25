import { dataResponse, routeErrorResponse } from "@/server/http";
import { requirePatientAccount } from "@/server/patient-auth";
import { listPatientDevices } from "@/server/patient-devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const account = await requirePatientAccount(request.headers);
    return dataResponse({ devices: await listPatientDevices(account, request.headers) });
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.devices.list", requestId);
  }
}
