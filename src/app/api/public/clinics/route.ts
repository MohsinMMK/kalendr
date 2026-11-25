import { ApiError } from "@/server/api-error";
import { clinicRegistrationSchema, isClinicRegistrationOpen, registerClinic } from "@/server/clinic-registration";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { clientAddress } from "@/server/rate-limit";
import { clearProofCookie, proofFromRequest } from "@/server/sign-up-check";
import { requireHumanWhenRisky } from "@/server/turnstile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    if (!isClinicRegistrationOpen()) {
      throw new ApiError(403, "registration_closed", "Sign-up is not open on this deployment.");
    }
    const address = clientAddress(request.headers);
    const attempt = await enforceLimit(request, "registration.ip", address);
    const input = await parseJsonBody(request, clinicRegistrationSchema);
    await requireHumanWhenRisky(request, attempt, address);
    // The owner proves their email first (the code, or Google or Microsoft): /api/public/sign-up.
    const proof = proofFromRequest(request);
    if (!proof) {
      throw new ApiError(422, "email_not_verified", "Confirm your email before creating your business.", { email: ["Confirm this email first."] });
    }
    const response = dataResponse(await registerClinic(input, proof), 201);
    response.headers.append("Set-Cookie", clearProofCookie);
    return response;
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.clinic.register", requestId);
  }
}
