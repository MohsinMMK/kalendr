import { holdReleaseSchema, holdRequestSchema } from "@/lib/booking-page";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { clientAddress } from "@/server/rate-limit";
import { createSlotHold, releaseSlotHold } from "@/server/slot-holds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Holds the picked time for five minutes while the customer fills in the form. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "holds.ip");
    const input = await parseJsonBody(request, holdRequestSchema);
    // Each hold closes a time for five minutes, so one network gets only a few at a business at once.
    await enforceLimit(request, "holds_create.ip_business", `${clientAddress(request.headers)}:${input.clinicSlug}`);
    return dataResponse(await createSlotHold(input), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.holds.create", requestId);
  }
}

/** Lets a hold go early: the customer picked another time or left the page. */
export async function DELETE(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "holds.ip");
    const input = await parseJsonBody(request, holdReleaseSchema);
    await releaseSlotHold(input.clinicSlug, input.holdToken);
    return dataResponse({ released: true });
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.holds.release", requestId);
  }
}
