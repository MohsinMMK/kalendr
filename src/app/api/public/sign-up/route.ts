import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { isClinicRegistrationOpen } from "@/server/clinic-registration";
import { sha256 } from "@/server/crypto";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { clientAddress } from "@/server/rate-limit";
import { clearProofCookie, proofFromRequest, proofSetCookie, sendSignUpCode, verifySignUpCode } from "@/server/sign-up-check";
import { requireHumanWhenRisky } from "@/server/turnstile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("send"), email: z.email("Enter a valid email.").max(254) }),
  z.object({ action: z.literal("verify"), email: z.email().max(254), code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code.") }),
]);

function withCookie(response: Response, cookie: string): Response {
  response.headers.append("Set-Cookie", cookie);
  return response;
}

/** Who this browser has proved to be, so a refresh keeps the owner's place. */
export async function GET(request: Request): Promise<Response> {
  const proof = proofFromRequest(request);
  return dataResponse(proof ? { email: proof.email, method: proof.method, name: proof.name ?? null } : null);
}

/** Sends or checks the sign-up code. A correct code sets the proof cookie that registration needs. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    if (!isClinicRegistrationOpen()) throw new ApiError(403, "registration_closed", "Sign-up is not open on this deployment.");
    const address = clientAddress(request.headers);
    const body = await parseJsonBody(request, bodySchema);
    if (body.action === "send") {
      const attempt = await enforceLimit(request, "sign_up_code.ip", address);
      await requireHumanWhenRisky(request, attempt, address);
      await enforceLimit(request, "sign_up_code.email", sha256(body.email.trim().toLowerCase()));
      return dataResponse(await sendSignUpCode(body.email));
    }
    await enforceLimit(request, "sign_up_verify.ip", address);
    const proof = await verifySignUpCode(body.email, body.code);
    return withCookie(dataResponse({ email: proof.email, method: proof.method }), proofSetCookie(proof));
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.sign_up", requestId);
  }
}

/** "Use a different email": forgets the proof. */
export async function DELETE(): Promise<Response> {
  return withCookie(dataResponse({ cleared: true }), clearProofCookie);
}
