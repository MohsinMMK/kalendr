import { emailCheckBodySchema } from "@/lib/booking-intake";
import { sha256 } from "@/server/crypto";
import { sendEmailCode, verifyEmailCode } from "@/server/email-check";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `{ action: "send", clinicSlug, serviceId, email }` asks for a 6-digit code by email.
 * `{ action: "verify", clinicSlug, email, code }` returns the one-use proof that goes with the booking.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const body = await parseJsonBody(request, emailCheckBodySchema);
    const key = sha256(`email-check:${body.email.trim().toLowerCase()}`);
    if (body.action === "send") {
      await enforceLimit(request, "email_check.ip");
      await enforceLimit(request, "email_check.email", key);
      return dataResponse(await sendEmailCode(body));
    }
    await enforceLimit(request, "email_check_verify.ip");
    return dataResponse(await verifyEmailCode(body));
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.email_check", requestId);
  }
}
