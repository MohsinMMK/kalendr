import { z } from "zod";

import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { acceptOffer, cancelLaterAppointment, declineOffer, offerTokenFrom, readOffer } from "@/server/waitlist-accept";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface OfferRouteContext {
  params: Promise<{ token: string }>;
}

/** What the person taps on the offer page. The offer, the business and the booking come from the token, never from the body. */
const offerAnswerSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("accept") }),
  z.strictObject({ action: z.literal("decline") }),
  z.strictObject({ action: z.literal("cancel_later") }),
]);

async function limited(request: Request, context: OfferRouteContext): Promise<string> {
  const token = offerTokenFrom((await context.params).token);
  await enforceLimit(request, "offer.ip");
  await enforceLimit(request, "offer.token", token);
  return token;
}

/** The offered time, as the page shows it. No sign-in: the token is the proof. */
export async function GET(request: Request, context: OfferRouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const token = await limited(request, context);
    const { profile: _profile, ...view } = await readOffer(token);
    void _profile;
    return dataResponse(view);
  } catch (error) {
    return routeErrorResponse(error, "public.offer.read", requestId);
  }
}

/** Takes the offered time, passes on it, or (after taking it) cancels the person's later booking of the same service. */
export async function POST(request: Request, context: OfferRouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const token = await limited(request, context);
    const input = await parseJsonBody(request, offerAnswerSchema);
    if (input.action === "accept") return dataResponse(await acceptOffer(token), 201);
    if (input.action === "decline") return dataResponse(await declineOffer(token));
    return dataResponse(await cancelLaterAppointment(token));
  } catch (error) {
    return routeErrorResponse(error, "public.offer.answer", requestId);
  }
}
