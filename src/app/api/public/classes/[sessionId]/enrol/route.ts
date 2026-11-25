import { enrolSchema } from "@/lib/classes-contracts";
import { enrol } from "@/server/classes";
import { dataResponse, enforceLimit, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Takes a seat. When the last seat is contested, exactly the seats left succeed and everyone else gets 409 `class_full`
 * with the waiting list on offer; sending `joinWaitlist: true` then puts them in line.
 */
export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "booking.ip");
    const idempotencyKey = getIdempotencyKey(request);
    const input = await parseJsonBody(request, enrolSchema);
    const result = await enrol((await params).sessionId, input, idempotencyKey);
    return dataResponse(result, 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.classes.enrol", requestId);
  }
}
