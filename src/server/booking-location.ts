import { videoMode } from "./video";
import { sql } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import type { BookingLocationChoice, LocationOptionKind } from "@/lib/service-setup";
import { ApiError } from "@/server/api-error";
import { sealText } from "@/server/record-crypto";

/**
 * Turns the customer's "how would you like to meet?" answer into what the appointment stores.
 * A service with one way of meeting needs no answer; with several the customer must choose one
 * the service really offers. An address is sealed before it is stored, like other private answers.
 */

export interface StoredLocationChoice {
  kind: LocationOptionKind;
  /** Sealed. Only for `their_address`. */
  detail: string | null;
}

export async function resolveLocationChoice(
  transaction: KalendrTransaction,
  tenantId: string,
  serviceId: string,
  locationId: string,
  choice: BookingLocationChoice | undefined,
  /** The front desk does not ask: with several ways to meet and no answer, it books in person at the branch. */
  behaviour: { defaultWhenUnasked?: boolean } = {},
): Promise<StoredLocationChoice> {
  const options = await transaction.execute<{ kind: LocationOptionKind; location_id: string | null }>(sql`
    select kind, location_id from service_location_options
    where tenant_id = ${tenantId} and service_id = ${serviceId}
    order by sort_order, kind
  `);
  // A service saved before options existed is offered in person at the branch being booked.
  const offered = options.length > 0 ? options : [{ kind: "in_person" as const, location_id: locationId }];
  const usable = offered
    .filter((option) => option.kind !== "in_person" || option.location_id === locationId)
    // Video is not offered when this server has no video provider.
    .filter((option) => option.kind !== "video" || videoMode() !== "off");
  if (usable.length === 0) throw new ApiError(409, "slot_unavailable", "This service is not offered in that way here. Please choose another option.");

  const fallback = behaviour.defaultWhenUnasked ? usable.find((option) => option.kind === "in_person") ?? usable[0] : undefined;
  const picked = choice
    ? usable.find((option) => option.kind === choice.kind)
    : usable.length === 1 ? usable[0] : fallback;
  if (!picked) {
    throw new ApiError(400, "validation_error", "Choose how you would like to meet.", {
      locationChoice: ["Choose one of the ways this service is offered."],
    });
  }
  if (picked.kind === "their_address") {
    const address = choice?.detail?.trim();
    if (!address) {
      throw new ApiError(400, "validation_error", "Enter the address we should come to.", {
        locationChoice: ["Enter the address we should come to."],
      });
    }
    return { kind: picked.kind, detail: sealText(tenantId, address) };
  }
  return { kind: picked.kind, detail: null };
}
