import { enrolmentActionSchema } from "@/lib/classes-contracts";
import { actOnSeat, getSeat } from "@/server/classes";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A customer's own place, found by the secret in their link. */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "availability.ip");
    return dataResponse(await getSeat((await params).token));
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.classes.seat.read", requestId);
  }
}

/** Cancel the place, or take or turn down an offered seat. Repeating an action changes nothing more. */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "booking.ip");
    const { action } = await parseJsonBody(request, enrolmentActionSchema);
    return dataResponse(await actOnSeat((await params).token, action));
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.classes.seat.act", requestId);
  }
}
