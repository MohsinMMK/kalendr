import { listResult, v1Route } from "@/server/api-v1";
import { availabilityQuery } from "@/server/api-v1-contracts";
import { defaultLocationId, findService } from "@/server/api-v1-reads";
import { listAvailabilityDetailed } from "@/server/appointment-repository";
import { parseQuery } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = v1Route("v1.availability.list", "availability:read", async ({ request, context }) => {
  const query = parseQuery(request, availabilityQuery);
  await findService(context.tenantId, query.serviceId);
  const listing = await listAvailabilityDetailed({
    clinicSlug: context.clinicSlug,
    locationId: query.locationId ?? await defaultLocationId(context.tenantId),
    serviceId: query.serviceId,
    practitionerId: query.staffId ?? "first_available",
    from: query.from,
    to: query.to,
    ...(query.durationMinutes ? { durationMinutes: query.durationMinutes } : {}),
  });
  const slots = listing.slots.map((slot) => ({
    startsAt: slot.startsAt, endsAt: slot.endsAt, staffId: slot.practitionerId,
    ...(slot.resourceId ? { resourceId: slot.resourceId } : {}),
  }));
  return listResult(slots, null);
});
