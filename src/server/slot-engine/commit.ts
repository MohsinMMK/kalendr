import type { KalendrTransaction } from "@/db/client";
import { ApiError } from "@/server/api-error";

import { limitReasons, periodKey } from "./limits";
import { loadSlotInput, type LoadedSlotInput, type SlotQuery } from "./load";
import { slotRejection } from "./messages";
import { buildContext, offerableSlots, slotFilters } from "./offerable-slots";
import { addDays, localDateOf, localInstant, MINUTE } from "./time";
import { sql } from "drizzle-orm";
import type { SlotMode } from "./types";

/**
 * The booking commit's side of the slot engine. The caller has already locked the person's
 * row, so what is loaded here cannot change under it before the reservation is written.
 * It loads fresh, runs the same `offerableSlots` the page used and requires the requested
 * start to be one of the results. Nothing here has a rule of its own.
 */

export interface CommitSlotCheck {
  tenantId: string;
  locationId: string;
  serviceId: string;
  practitionerId: string;
  startsAt: Date;
  endsAt: Date;
  /** `standard` for a customer or a desk booking, `walk_in` for someone here now, `existing` for a visit that is not moving in time. */
  mode: SlotMode;
  /** A visit being moved: its own reservation does not block its new time. */
  excludeAppointmentId?: string;
  /** Use only this room, when staff picked one. */
  preferredResourceId?: string;
  /** A visit already booked keeps its length even if the service stopped offering it. */
  keepExistingLength?: boolean;
  /** Staff went past the booking limits and gave a reason. Limits and "first slot only" are left out. */
  overrideLimits?: boolean;
  /** With `existing`: still hold the booking to the daily and weekly limits. A request being approved or a waitlist offer is a new booking for the count. */
  enforceLimits?: boolean;
  /** The customer's own hold for this time: it does not block the booking it was made for. */
  ignoreHoldId?: string;
}

export interface CommitSlotResult {
  resourceId: string | null;
  durationMinutes: number;
  priceMinor: number | null;
  loaded: LoadedSlotInput;
}

function unavailable(message = "That time is no longer available. Please choose another slot."): ApiError {
  return new ApiError(409, "slot_unavailable", message);
}

export async function assertSlotOfferable(transaction: KalendrTransaction, check: CommitSlotCheck): Promise<CommitSlotResult> {
  const durationMinutes = Math.round((check.endsAt.getTime() - check.startsAt.getTime()) / MINUTE);
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) throw unavailable();

  const query: SlotQuery = {
    tenantId: check.tenantId,
    locationId: check.locationId,
    serviceId: check.serviceId,
    durationMinutes,
    practitionerId: check.practitionerId,
    from: check.startsAt,
    to: check.endsAt,
    mode: check.mode,
    ...(check.excludeAppointmentId ? { excludeAppointmentId: check.excludeAppointmentId } : {}),
    ...(check.preferredResourceId ? { preferredResourceId: check.preferredResourceId } : {}),
    ...(check.overrideLimits ? { overrideLimits: true } : {}),
    ...(check.enforceLimits ? { enforceLimits: true } : {}),
    ...(check.ignoreHoldId ? { ignoreHoldId: check.ignoreHoldId } : {}),
    lockResources: true,
  };
  let loaded = await loadSlotInput(transaction, query);
  if (!loaded) throw unavailable();

  loaded = await lockLimitsAndReload(transaction, check, query, loaded);

  const chosen = loaded.lengths.find((length) => length.minutes === durationMinutes);
  if (!chosen && !check.keepExistingLength) throw unavailable("This service is not offered for that length of time.");

  const offered = offerableSlots(loaded.input).find(
    (slot) => slot.practitionerId === check.practitionerId && slot.startsAt.getTime() === check.startsAt.getTime(),
  );
  if (!offered) {
    // Say why when a rule the customer can understand removed it; otherwise it is simply taken or outside hours.
    const context = buildContext(loaded.input);
    const rejection = slotFilters
      .map((filter) => filter.reject({
        practitionerId: check.practitionerId,
        start: check.startsAt.getTime(),
        end: check.endsAt.getTime(),
        reservedStart: check.startsAt.getTime() - loaded.input.service.bufferBeforeMinutes * MINUTE,
        reservedEnd: check.endsAt.getTime() + loaded.input.service.bufferAfterMinutes * MINUTE,
        resourceId: null,
      }, context))
      .find((result) => result !== null);
    if (rejection && (rejection.reason === limitReasons.day || rejection.reason === limitReasons.other)) {
      throw new ApiError(409, "limit_reached", slotRejection(rejection.reason, loaded.input) ?? "That time is fully booked.");
    }
    throw unavailable(rejection ? slotRejection(rejection.reason, loaded.input) : undefined);
  }
  return {
    resourceId: offered.resourceId,
    durationMinutes,
    priceMinor: chosen?.priceMinor ?? null,
    loaded,
  };
}

/**
 * Booking limits and "first slot only" are read from other bookings, so two requests for the last place
 * must not both pass. The advisory locks are taken in a fixed order (so two requests cannot wait on each
 * other), and the data is read again afterwards. The commit runs at the serializable level, so a request that
 * raced a booking it could not see is retried by the caller and then finds the limit used up.
 */
async function lockLimitsAndReload(transaction: KalendrTransaction, check: CommitSlotCheck, query: SlotQuery, loaded: LoadedSlotInput): Promise<LoadedSlotInput> {
  const { input } = loaded;
  let current = loaded;
  // "First slot only" needs the whole day to know whether this start is the earliest free one.
  if (input.service.firstSlotOnly && check.mode === "standard") {
    const date = localDateOf(check.startsAt.getTime(), input.timezone);
    const wide = await loadSlotInput(transaction, {
      ...query,
      from: new Date(localInstant(date, "00:00", input.timezone)),
      to: new Date(localInstant(addDays(date, 1), "00:00", input.timezone)),
    });
    if (wide) current = wide;
  }
  const rules = current.input.limits ?? [];
  if (rules.length === 0) return current;
  const date = localDateOf(check.startsAt.getTime(), current.input.timezone);
  const keys = [...new Set(rules.map((rule) => periodKey(rule.id, date, rule.period, rule.weekStart)))].sort();
  for (const key of keys) {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`booking-limit:${check.tenantId}:${key}`}, 0))`);
  }
  const fresh = await loadSlotInput(transaction, { ...query, ...(current !== loaded ? { from: current.input.from, to: current.input.to } : {}) });
  return fresh ?? current;
}
