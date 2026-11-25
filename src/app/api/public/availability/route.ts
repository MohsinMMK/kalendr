import { ApiError } from "@/server/api-error";
import { availabilityQuerySchema } from "@/server/contracts";
import { listAvailabilityDetailed } from "@/server/appointment-repository";
import { listCombinedAvailability } from "@/server/combined-availability";
import { assertSlugNotPaused } from "@/server/tenant-pause";
import { dataResponse, enforceLimit, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "availability.ip");
    const url = new URL(request.url);
    const parsed = availabilityQuerySchema.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    if (!parsed.success) {
      throw new ApiError(
        400,
        "validation_error",
        "The availability request is invalid.",
        Object.fromEntries(
          Object.entries(parsed.error.flatten().fieldErrors).flatMap(
            ([field, messages]) => (messages?.length ? [[field, messages]] : []),
          ),
        ),
      );
    }
    await assertSlugNotPaused(parsed.data.clinicSlug);
    const { combo, ...query } = parsed.data;
    const listing = combo ? await listCombinedAvailability({ ...query, combo }) : await listAvailabilityDetailed(query);
    return dataResponse({ slots: listing.slots, outOfOffice: listing.outOfOffice, fullDays: listing.fullDays, ...(listing.nextByPerson ? { nextByPerson: listing.nextByPerson } : {}) });
  } catch (error) {
    return routeErrorResponse(error, "public.availability", requestId);
  }
}
