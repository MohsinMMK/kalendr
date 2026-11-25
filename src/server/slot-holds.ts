import "server-only";

import { sql } from "drizzle-orm";

import { getDatabase, withTenant, type KalendrTransaction } from "@/db/client";
import { HOLD_MINUTES, type HoldRequest, type HoldResult } from "@/lib/booking-page";

import { ApiError } from "./api-error";
import { createOpaqueToken, sha256 } from "./crypto";
import { ANYONE, chooseAssignee } from "./routing";
import { assertPersonAllowed, resolveRoutingToken } from "./routing-forms/trace";
import { assertSlotOfferable } from "./slot-engine/commit";
import { assertTenantNotPaused } from "./tenant-pause";

/**
 * Slot holds (feature 39). When a customer picks a time the page asks for a five-minute hold, so a
 * second customer does not see or take that time while the first one fills in the form. A hold is a
 * short row, not a booking: the engine reads live holds as busy time, the booking commit turns the
 * customer's own hold into the booking, and the engine ignores a hold past `expires_at`, so a missed
 * clean-up job never keeps a time closed.
 */

async function tenantOf(slug: string): Promise<string> {
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "Booking is not available right now. Please try again shortly.");
  const [tenant] = await database.execute<{ tenant_id: string }>(sql`select tenant_id from kalendr_resolve_tenant(${slug}, null)`);
  if (!tenant) throw new ApiError(404, "clinic_not_found", "Business not found.");
  await assertTenantNotPaused(tenant.tenant_id);
  return tenant.tenant_id;
}

export function hashHoldToken(token: string): string {
  return sha256(token);
}

/** Holds a time for this browser. A hold the browser already had is let go first: one live hold per browser. */
export async function createSlotHold(input: HoldRequest): Promise<HoldResult> {
  const tenantId = await tenantOf(input.clinicSlug);
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  return withTenant(tenantId, async (transaction) => {
    if (input.replaceToken) {
      await transaction.execute(sql`delete from slot_holds where tenant_id = ${tenantId} and token_hash = ${hashHoldToken(input.replaceToken)}`);
    }
    // "Anyone" holds the person routing would give this booking to, so the time stays theirs while the customer fills in the form (feature 20).
    const routing = input.routingToken ? await resolveRoutingToken(transaction, tenantId, input.routingToken, input.serviceId) : null;
    if (routing && input.practitionerId !== ANYONE) assertPersonAllowed(routing, input.practitionerId);
    const practitionerId = input.practitionerId === ANYONE
      ? (await chooseAssignee(transaction, {
          tenantId, locationId: input.locationId, serviceId: input.serviceId, startsAt, endsAt,
          ...(routing ? { candidateIds: routing.candidateIds, weightMultipliers: routing.multipliers } : {}),
        })).practitionerId
      : input.practitionerId;
    // The same row lock a booking takes, so a hold and a booking for one person cannot both pass.
    const [person] = await transaction.execute<{ id: string }>(sql`
      select id from practitioners where tenant_id = ${tenantId} and id = ${practitionerId} and is_active for update
    `);
    if (!person) throw new ApiError(409, "slot_unavailable", "That time is no longer available. Please choose another slot.");
    await transaction.execute(sql`delete from slot_holds where tenant_id = ${tenantId} and practitioner_id = ${practitionerId} and expires_at <= now()`);

    const slot = await assertSlotOfferable(transaction, {
      tenantId, locationId: input.locationId, serviceId: input.serviceId, practitionerId, startsAt, endsAt, mode: "standard",
    });
    const rules = slot.loaded.input.service;
    const token = createOpaqueToken();
    const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60_000);
    await transaction.execute(sql`
      insert into slot_holds (tenant_id, service_id, practitioner_id, location_id, resource_id, starts_at, ends_at, reserved_starts_at, reserved_ends_at, token_hash, expires_at)
      values (${tenantId}, ${input.serviceId}, ${practitionerId}, ${input.locationId}, ${slot.resourceId}, ${startsAt.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz,
        ${new Date(startsAt.getTime() - rules.bufferBeforeMinutes * 60_000).toISOString()}::timestamptz, ${new Date(endsAt.getTime() + rules.bufferAfterMinutes * 60_000).toISOString()}::timestamptz,
        ${hashHoldToken(token)}, ${expiresAt.toISOString()}::timestamptz)
    `);
    return { holdToken: token, expiresAt: expiresAt.toISOString() };
  });
}

export async function releaseSlotHold(slug: string, token: string): Promise<void> {
  const tenantId = await tenantOf(slug);
  await withTenant(tenantId, (transaction) => transaction.execute(sql`
    delete from slot_holds where tenant_id = ${tenantId} and token_hash = ${hashHoldToken(token)}
  `).then(() => undefined));
}

export interface OwnHold {
  id: string;
}

/**
 * The customer's own hold for exactly this time, so the booking can pass its own hold. Null when the token is
 * unknown, expired, or for another time: the booking is then checked as if no hold existed.
 */
export async function findOwnHold(
  transaction: KalendrTransaction,
  tenantId: string,
  token: string | undefined,
  match: { serviceId: string; practitionerId: string; startsAt: Date },
): Promise<OwnHold | null> {
  if (!token) return null;
  const [row] = await transaction.execute<{ id: string }>(sql`
    select id from slot_holds
    where tenant_id = ${tenantId} and token_hash = ${hashHoldToken(token)} and expires_at > now()
      and service_id = ${match.serviceId} and practitioner_id = ${match.practitionerId} and starts_at = ${match.startsAt.toISOString()}::timestamptz
  `);
  return row ?? null;
}
