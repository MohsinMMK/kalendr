import { normalizeContact } from "@/lib/patient-contact";
import { portalCodeRequestSchema } from "@/server/contracts";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { requestLoginCode } from "@/server/patient-auth";
import { deviceCookieHeader, deviceIdFrom, newDeviceId } from "@/server/patient-device";
import { clientAddress } from "@/server/rate-limit";
import { requireHumanWhenRisky } from "@/server/turnstile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const address = clientAddress(request.headers);
    const attempt = await enforceLimit(request, "code_request.ip", address);
    // The first request from a browser gets its device id; the limit counts from then on.
    const knownDevice = deviceIdFrom(request.headers);
    const deviceId = knownDevice ?? newDeviceId();
    await enforceLimit(request, "code_request.device", deviceId);
    const input = await parseJsonBody(request, portalCodeRequestSchema);
    const contact = normalizeContact(input.kind, input.contact);
    if (contact) await enforceLimit(request, "code_request.contact", `${input.kind}:${contact}`);
    await requireHumanWhenRisky(request, attempt, address);
    await requestLoginCode(input.kind, input.contact, { via: input.via });
    const response = dataResponse({ sent: true }, 202);
    if (!knownDevice) response.headers.append("Set-Cookie", deviceCookieHeader(deviceId));
    return response;
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.code.request", requestId);
  }
}
