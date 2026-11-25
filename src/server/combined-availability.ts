import "server-only";

import { sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";
import type { AvailabilityQuery } from "@/server/contracts";
import { ApiError } from "@/server/api-error";
import { type AvailabilityListing, listAvailabilityDetailed } from "@/server/appointment-repository";
import { resolveCombinedLink } from "@/server/special-links-core";

/**
 * The times a combined link offers (feature 45): the start times at which every person on the link is free for the
 * service, found by asking the normal slot engine for each person and keeping the times they all have. The commit checks
 * every person again inside its transaction, so this list is only what is shown.
 */
export async function listCombinedAvailability(query: AvailabilityQuery & { combo: string }): Promise<AvailabilityListing> {
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "Booking is not available right now. Please try again shortly.");
  const [tenant] = await database.execute<{ tenant_id: string }>(sql`select tenant_id from kalendr_resolve_tenant(${query.clinicSlug}, null)`);
  if (!tenant) throw new ApiError(404, "clinic_not_found", "Business not found.");
  const link = await withTenant(tenant.tenant_id, (transaction) => resolveCombinedLink(transaction, tenant.tenant_id, query.combo));
  if (!link || link.serviceId !== query.serviceId) throw new ApiError(404, "combined_link_not_found", "This booking link is no longer available.");

  const listings = await Promise.all(link.practitionerIds.map((practitionerId) => listAvailabilityDetailed({ ...query, practitionerId })));
  const keyOf = (slot: { startsAt: string; endsAt: string }) => `${slot.startsAt}|${slot.endsAt}`;
  const shared = listings.slice(1).reduce<Set<string>>(
    (common, listing) => new Set(listing.slots.map(keyOf).filter((key) => common.has(key))),
    new Set((listings[0]?.slots ?? []).map(keyOf)),
  );
  return {
    slots: (listings[0]?.slots ?? []).filter((slot) => shared.has(keyOf(slot))),
    outOfOffice: listings.flatMap((listing) => listing.outOfOffice),
    fullDays: [...new Set(listings.flatMap((listing) => listing.fullDays))],
  };
}
