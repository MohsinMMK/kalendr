import { bookingBotFieldNames, minimumBookingFillMs } from "@/lib/bot-check";
import { normalizePhone } from "@/lib/patient-contact";
import { publicWaitlistSchema } from "@/lib/waitlist-contracts";
import { ApiError } from "@/server/api-error";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { clientAddress, recordRefusal } from "@/server/rate-limit";
import { requireHumanWhenRisky } from "@/server/turnstile";
import { joinWaitlist } from "@/server/waitlist-join";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const refusedMessage = "We could not add you to the waitlist. Wait a moment and try again, or call to join.";

/** A customer asks, from the booking page, to be told when a time opens. Same bot filters as the booking form. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const address = clientAddress(request.headers);
    const attempt = await enforceLimit(request, "waitlist_join.ip", address);
    const { [bookingBotFieldNames.honeypot]: honeypot, [bookingBotFieldNames.fillMs]: fillMs, ...input } = await parseJsonBody(request, publicWaitlistSchema);
    if (honeypot?.trim()) {
      recordRefusal("bot_check.honeypot");
      throw new ApiError(400, "waitlist_refused", refusedMessage);
    }
    if (fillMs !== undefined && fillMs < minimumBookingFillMs) {
      recordRefusal("bot_check.too_fast");
      throw new ApiError(400, "waitlist_refused", refusedMessage);
    }
    if (input.phone) await enforceLimit(request, "waitlist_join.contact", `phone:${normalizePhone(input.phone)}`);
    if (input.email) await enforceLimit(request, "waitlist_join.contact", `email:${input.email.trim().toLowerCase()}`);
    await requireHumanWhenRisky(request, attempt, address);
    return dataResponse(await joinWaitlist(input), 201);
  } catch (error) {
    return routeErrorResponse(error, "public.waitlist.join", requestId);
  }
}
