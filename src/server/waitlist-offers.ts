/**
 * The smart waitlist (feature 21): when a time frees up, offer it to the people waiting, one at a time, and keep it off
 * the public page until someone takes it or the line runs out.
 *
 * This file is the part both sides share, written against `Runner` (like the workflow engine) so the web server's drizzle
 * transaction and the worker's postgres.js transaction run the same code. No "server-only": the worker imports it.
 *
 * What makes it safe:
 * - The first offer and its hold are written inside the transaction that frees the time (cancel, move away, a closed
 *   time removed), so the time is never visible between the cancel and the offer.
 * - A live offer keeps its time in `slot_holds` (purpose `waitlist`). The slot engine reads every live hold as busy, so
 *   the time leaves public booking, and the hold lasts a little past the answer time (HOLD_GRACE_MS) so the worker always
 *   moves it on before it lapses.
 * - Moving on to the next person ends the old offer, makes the next one and keeps the same hold row, all in one
 *   transaction. Nothing sits between two people.
 * - The hold is checked through the same engine check as a booking (assertSlotOfferable), never with a rule of its own.
 * - No outside call happens here. The message goes through the outbox (event `waitlist-match`) and the worker.
 * - Nothing here logs, and no contact detail, token or message text is written to the audit trail or the outbox.
 */
import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import {
  HOLD_GRACE_MS, MAX_PEOPLE_PER_TIME, localHourOf, mustReleaseToPublic, offerMinutes, orderCandidates, timeOfDayFits,
  type OfferEndReason, type WaitlistOrderRule,
} from "@/lib/waitlist";

import { ApiError } from "./api-error";
import { createOpaqueToken, sha256 } from "./crypto";
import { sealPrivate } from "./messaging/sealed-link";
import { assertSlotOfferable } from "./slot-engine/commit";
import { loadSlotInput } from "./slot-engine/load";
import { offerableSlots } from "./slot-engine/offerable-slots";
import { localDateOf } from "./slot-engine/time";
import { afterQuietHours } from "./workflows/quiet-hours";
import { loadQuietHours } from "./workflows/engine";
import { asDate, asNumber, asString, type Row, type Runner } from "./workflows/runner";

export const WAITLIST_MATCH_EVENT = "waitlist-match";
export const OFFER_EXPIRE_EVENT = "offer-expire";
export const OFFER_SEAL_PURPOSE = "waitlist_offer";

/** A time that has just come free. */
export interface FreedSlot {
  locationId: string;
  serviceId: string;
  practitionerId: string;
  startsAt: Date;
  endsAt: Date;
  /** The person whose booking was just cancelled: they are never offered their own time. */
  excludePatientId?: string;
}

export interface OfferOptions {
  now?: Date;
  /** `manual` when staff offered it by hand: the automation switch does not apply to the first offer. */
  origin?: "automatic" | "manual";
  /** For an offer by hand: the one waiting person to ask. Staff chose them, so their dates, time of day and people are not checked. */
  entryId?: string;
  actorUserId?: string;
}

export type OfferOutcome =
  | { offered: true; offerId: string; chainId: string }
  | { offered: false; reason: "automation_off" | "nobody_waiting" | "too_close" | "slot_unavailable" | "already_offered" };

function engineTransaction(run: Runner): KalendrTransaction {
  return { execute: (query: SQL) => run(query) } as unknown as KalendrTransaction;
}

function audit(run: Runner, tenantId: string, action: string, metadata: Record<string, unknown>, actorUserId?: string): Promise<Row[]> {
  return run(sql`
    insert into audit_events (tenant_id, actor_user_id, actor_type, action, outcome, metadata)
    values (${tenantId}, ${actorUserId ?? null}, ${actorUserId ? "staff" : "system"}, ${action}, 'success', ${JSON.stringify(metadata)}::text::jsonb)
  `);
}

async function orderRuleFor(run: Runner, tenantId: string): Promise<WaitlistOrderRule> {
  const [row] = await run(sql`select order_rule from waitlist_settings where tenant_id = ${tenantId}`);
  return row?.order_rule === "soonest_existing" ? "soonest_existing" : "longest_waiting";
}

/** Whether offers for this service go out on their own. No row means on. */
export async function automaticOffersOn(run: Runner, tenantId: string, serviceId: string): Promise<boolean> {
  const [row] = await run(sql`select automatic_offers from waitlist_service_switches where tenant_id = ${tenantId} and service_id = ${serviceId}`);
  return row ? row.automatic_offers === true : true;
}

async function locationZone(run: Runner, tenantId: string, locationId: string): Promise<string> {
  const [row] = await run(sql`
    select coalesce(location.timezone, tenant.timezone) as zone
    from locations as location join tenants as tenant on tenant.id = location.tenant_id
    where location.tenant_id = ${tenantId} and location.id = ${locationId}
  `);
  return asString(row?.zone) || "UTC";
}

/** When a message about a new offer may go out: now, or the end of quiet hours in the location's own time zone. */
export async function sendTimeFor(run: Runner, tenantId: string, locationId: string, now: Date): Promise<Date> {
  const [zone, quiet] = await Promise.all([locationZone(run, tenantId, locationId), loadQuietHours(run, tenantId)]);
  return afterQuietHours(now, zone, quiet.startMinute, quiet.endMinute);
}

interface Candidate {
  id: string;
  patientId: string;
  createdAt: Date;
  nextAppointmentAt: Date | null;
}

/**
 * The people who could take this time, in the order they should be asked. Same service and place, the date inside the
 * dates they gave, the start inside the time of day they gave, the person acceptable, nobody who is already being offered
 * something, was already asked about this time, or is busy then with a booking of their own.
 */
async function candidatesFor(run: Runner, tenantId: string, slot: FreedSlot, chainId: string, onlyEntryId?: string): Promise<Candidate[]> {
  const chosen = Boolean(onlyEntryId);
  const zone = await locationZone(run, tenantId, slot.locationId);
  const localDate = localDateOf(slot.startsAt.getTime(), zone);
  const hour = localHourOf(slot.startsAt, zone);
  const rows = await run(sql`
    select entry.id, entry.patient_id, entry.created_at, entry.time_preference,
      (select min(next_visit.starts_at) from appointments as next_visit
        where next_visit.tenant_id = entry.tenant_id and next_visit.patient_id = entry.patient_id
          and next_visit.service_id = entry.service_id and next_visit.status in ('requested', 'booked')
          and next_visit.starts_at > ${slot.startsAt.toISOString()}::timestamptz) as next_appointment_at
    from waitlist_entries as entry
    join patients as patient on patient.tenant_id = entry.tenant_id and patient.id = entry.patient_id
    where entry.tenant_id = ${tenantId} and (entry.status = 'active' or (${chosen} and entry.status = 'offered'))
      and entry.service_id = ${slot.serviceId} and entry.location_id = ${slot.locationId}
      and (${chosen} or (entry.date_from <= ${localDate}::date and entry.date_to >= ${localDate}::date
        and (cardinality(entry.preferred_practitioner_ids) = 0 or ${slot.practitionerId} = any(entry.preferred_practitioner_ids))))
      and patient.erased_at is null
      and (${slot.excludePatientId ?? null}::text is null or entry.patient_id <> ${slot.excludePatientId ?? null})
      and (${onlyEntryId ?? null}::text is null or entry.id = ${onlyEntryId ?? null})
      and not exists (
        select 1 from slot_offers as offer
        where offer.tenant_id = entry.tenant_id and offer.entry_id = entry.id and offer.status in ('scheduled', 'sent')
      )
      and not exists (
        select 1 from slot_offers as offer
        where offer.tenant_id = entry.tenant_id and offer.chain_id = ${chainId} and offer.entry_id = entry.id
      )
      and not exists (
        select 1 from appointments as booked
        where booked.tenant_id = entry.tenant_id and booked.patient_id = entry.patient_id
          and booked.status in ('requested', 'booked', 'checked_in')
          and tstzrange(booked.starts_at, booked.ends_at, '[)') && tstzrange(${slot.startsAt.toISOString()}::timestamptz, ${slot.endsAt.toISOString()}::timestamptz, '[)')
      )
    limit 200
  `);
  const fitting = rows.filter((row) => chosen || timeOfDayFits(asString(row.time_preference), hour)).map((row): Candidate => ({
    id: asString(row.id),
    patientId: asString(row.patient_id),
    createdAt: asDate(row.created_at),
    nextAppointmentAt: row.next_appointment_at ? asDate(row.next_appointment_at) : null,
  }));
  return orderCandidates(fitting, await orderRuleFor(run, tenantId));
}

/** Lets a time go to public booking: its hold is removed and the end is written to the trail. */
async function releaseTime(run: Runner, tenantId: string, chainId: string, holdId: string | null, reason: string, slot: FreedSlot): Promise<void> {
  // Nothing was held and nobody was asked (an ordinary cancel with nobody waiting): there is nothing to record.
  if (!holdId) return;
  await run(sql`delete from slot_holds where tenant_id = ${tenantId} and id = ${holdId}`);
  await audit(run, tenantId, "waitlist.slot.released", { chainId, reason, practitionerId: slot.practitionerId, serviceId: slot.serviceId, startsAt: slot.startsAt.toISOString() });
}

interface MadeOffer {
  offerId: string;
}

/**
 * Makes one offer and keeps the time held for it. When `holdId` is given the same hold row is carried on to the new
 * person; otherwise a fresh hold is made, checked by the booking engine. Throws ApiError(409) when the time is not free.
 */
async function makeOffer(
  run: Runner, tenantId: string, slot: FreedSlot, entry: Candidate,
  input: { chainId: string; position: number; origin: "automatic" | "manual"; sendAt: Date; now: Date; holdId: string | null; actorUserId?: string },
): Promise<MadeOffer> {
  // The same row lock a booking takes, so this and a booking for the same person cannot both pass.
  const [person] = await run(sql`select id from practitioners where tenant_id = ${tenantId} and id = ${slot.practitionerId} and is_active for update`);
  if (!person) throw new ApiError(409, "slot_unavailable", "That time is no longer available.");
  await run(sql`delete from slot_holds where tenant_id = ${tenantId} and practitioner_id = ${slot.practitionerId} and expires_at <= now() and id is distinct from ${input.holdId}`);

  const check = await assertSlotOfferable(engineTransaction(run), {
    tenantId, locationId: slot.locationId, serviceId: slot.serviceId, practitionerId: slot.practitionerId,
    startsAt: slot.startsAt, endsAt: slot.endsAt,
    // Notice and the booking window do not apply: the two-hour rule below is this feature's own. Hours, busy time,
    // rooms and booking limits all still do.
    mode: "existing", enforceLimits: true, keepExistingLength: true,
    ...(input.holdId ? { ignoreHoldId: input.holdId } : {}),
  });
  const rules = check.loaded.input.service;
  const minutes = offerMinutes(slot.startsAt, input.sendAt);
  const answerBy = new Date(input.sendAt.getTime() + minutes * 60_000);
  const holdUntil = new Date(answerBy.getTime() + HOLD_GRACE_MS);

  let holdId = input.holdId;
  if (holdId) {
    await run(sql`update slot_holds set expires_at = ${holdUntil.toISOString()}::timestamptz, purpose = 'waitlist'
      where tenant_id = ${tenantId} and id = ${holdId}`);
  }
  if (!holdId || !(await run(sql`select 1 from slot_holds where tenant_id = ${tenantId} and id = ${holdId}`))[0]) {
    // The hold gets a token nobody ever sees, so the public hold-release route can never let it go.
    const [created] = await run(sql`
      insert into slot_holds (tenant_id, service_id, practitioner_id, location_id, resource_id, starts_at, ends_at, reserved_starts_at, reserved_ends_at, token_hash, purpose, expires_at)
      values (${tenantId}, ${slot.serviceId}, ${slot.practitionerId}, ${slot.locationId}, ${check.resourceId},
        ${slot.startsAt.toISOString()}::timestamptz, ${slot.endsAt.toISOString()}::timestamptz,
        ${new Date(slot.startsAt.getTime() - rules.bufferBeforeMinutes * 60_000).toISOString()}::timestamptz,
        ${new Date(slot.endsAt.getTime() + rules.bufferAfterMinutes * 60_000).toISOString()}::timestamptz,
        ${sha256(createOpaqueToken())}, 'waitlist', ${holdUntil.toISOString()}::timestamptz)
      returning id
    `);
    holdId = asString(created?.id);
  }

  const offerId = randomUUID();
  const token = createOpaqueToken();
  const sealed = sealPrivate(OFFER_SEAL_PURPOSE, tenantId, offerId, token);
  // Without a key to seal the link with, the worker could not build it: better no offer than one nobody can open.
  if (!sealed) throw new ApiError(409, "slot_unavailable", "Offers cannot be sent right now.");
  await run(sql`
    insert into slot_offers (id, tenant_id, entry_id, service_id, location_id, practitioner_id, starts_at, ends_at, chain_id, position, origin,
      token_hash, token_sealed, status, hold_id, send_at, expires_at)
    values (${offerId}, ${tenantId}, ${entry.id}, ${slot.serviceId}, ${slot.locationId}, ${slot.practitionerId},
      ${slot.startsAt.toISOString()}::timestamptz, ${slot.endsAt.toISOString()}::timestamptz, ${input.chainId}, ${input.position}, ${input.origin},
      ${sha256(token)}, ${sealed}, 'scheduled', ${holdId}, ${input.sendAt.toISOString()}::timestamptz, ${answerBy.toISOString()}::timestamptz)
  `);
  await run(sql`update waitlist_entries set status = 'offered', updated_at = now() where tenant_id = ${tenantId} and id = ${entry.id} and status = 'active'`);
  await run(sql`
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, available_at)
    values (${tenantId}, 'slot_offer', ${offerId}, ${WAITLIST_MATCH_EVENT}, ${JSON.stringify({ offerId })}::text::jsonb,
      ${`${WAITLIST_MATCH_EVENT}:${offerId}`}, ${input.sendAt.getTime() > input.now.getTime() ? sql`${input.sendAt.toISOString()}::timestamptz` : sql`now()`})
    on conflict (tenant_id, dedupe_key) do nothing
  `);
  await audit(run, tenantId, "waitlist.offer.created", { offerId, entryId: entry.id, chainId: input.chainId, position: input.position, origin: input.origin }, input.actorUserId);
  return { offerId };
}

/**
 * Asks the next person in line about a time, or lets the time go to public booking. `holdId` is the hold the previous
 * person had, carried on so the time never opens up in between.
 */
async function offerToNext(
  run: Runner, tenantId: string, slot: FreedSlot,
  input: { chainId: string; position: number; origin: "automatic" | "manual"; now: Date; holdId: string | null; onlyEntryId?: string; actorUserId?: string },
): Promise<OfferOutcome> {
  const sendAt = await sendTimeFor(run, tenantId, slot.locationId, input.now);
  if (mustReleaseToPublic(slot.startsAt, sendAt)) {
    await releaseTime(run, tenantId, input.chainId, input.holdId, "too_close", slot);
    return { offered: false, reason: "too_close" };
  }
  const line = await candidatesFor(run, tenantId, slot, input.chainId, input.onlyEntryId);
  const [first] = line;
  if (!first) {
    await releaseTime(run, tenantId, input.chainId, input.holdId, "nobody_waiting", slot);
    return { offered: false, reason: "nobody_waiting" };
  }
  try {
    // A savepoint, so a time that turns out not to be free does not poison the caller's transaction.
    await run(sql`savepoint waitlist_offer`);
    const made = await makeOffer(run, tenantId, slot, first, { chainId: input.chainId, position: input.position, origin: input.origin, sendAt, now: input.now, holdId: input.holdId, actorUserId: input.actorUserId });
    await run(sql`release savepoint waitlist_offer`);
    return { offered: true, offerId: made.offerId, chainId: input.chainId };
  } catch (error) {
    await run(sql`rollback to savepoint waitlist_offer`);
    if (error instanceof ApiError && error.code === "slot_unavailable") {
      // Not free (taken, closed or outside hours): no offer, and any hold we carried is let go.
      await releaseTime(run, tenantId, input.chainId, input.holdId, "slot_unavailable", slot);
      return { offered: false, reason: "slot_unavailable" };
    }
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "23505") {
      // Another offer is already live for this time.
      return { offered: false, reason: "already_offered" };
    }
    throw error;
  }
}

/**
 * A time has come free: offer it to the first person waiting for it. Called inside the transaction that frees the time.
 * Does nothing (and holds nothing) when the service's automation is off, nobody matches, or the time is under two hours away.
 */
export async function offerSlot(run: Runner, tenantId: string, slot: FreedSlot, options: OfferOptions = {}): Promise<OfferOutcome> {
  const now = options.now ?? new Date();
  const origin = options.origin ?? "automatic";
  if (origin === "automatic" && !(await automaticOffersOn(run, tenantId, slot.serviceId))) return { offered: false, reason: "automation_off" };
  return offerToNext(run, tenantId, slot, {
    chainId: randomUUID(), position: 1, origin, now, holdId: null,
    ...(options.entryId ? { onlyEntryId: options.entryId } : {}),
    ...(options.actorUserId ? { actorUserId: options.actorUserId } : {}),
  });
}

/** The most times offered from one removed block, so a long closure cannot make a long transaction. */
const RANGE_OFFER_LIMIT = 6;
/** The most times looked at in one removal, offered or not. */
const RANGE_EXAMINE_LIMIT = 24;

/**
 * A stretch of time has opened up (a closed time was removed or shortened). For each service and place someone is
 * waiting for, the times that are now open inside it are each offered to the first person who fits.
 */
export async function offerFreedRange(
  run: Runner, tenantId: string,
  range: { practitionerId: string | null; locationId: string | null; startsAt: Date; endsAt: Date },
  options: OfferOptions = {},
): Promise<number> {
  const pairs = await run(sql`
    select distinct entry.service_id, entry.location_id from waitlist_entries as entry
    where entry.tenant_id = ${tenantId} and entry.status = 'active'
      and (${range.locationId ?? null}::text is null or entry.location_id = ${range.locationId ?? null})
      and entry.date_to >= ${range.startsAt.toISOString()}::timestamptz::date - 1
    limit 20
  `);
  // Times already past cannot be offered, and a long closure must not make a long transaction.
  const from = new Date(Math.max(range.startsAt.getTime(), (options.now ?? new Date()).getTime()));
  if (from.getTime() >= range.endsAt.getTime()) return 0;
  let offered = 0;
  let examined = 0;
  for (const pair of pairs) {
    if (offered >= RANGE_OFFER_LIMIT || examined >= RANGE_EXAMINE_LIMIT) break;
    const serviceId = asString(pair.service_id);
    const locationId = asString(pair.location_id);
    if (!(await automaticOffersOn(run, tenantId, serviceId))) continue;
    const loaded = await loadSlotInput(engineTransaction(run), {
      tenantId, locationId, serviceId, practitionerId: range.practitionerId ?? "first_available", from, to: range.endsAt, mode: "existing",
    });
    if (!loaded) continue;
    const taken = new Set<string>();
    for (const slot of offerableSlots(loaded.input)) {
      const key = `${slot.practitionerId}:${slot.startsAt.getTime()}`;
      if (taken.has(key)) continue;
      if (offered >= RANGE_OFFER_LIMIT || examined >= RANGE_EXAMINE_LIMIT) break;
      taken.add(key);
      examined += 1;
      const outcome = await offerSlot(run, tenantId, { locationId, serviceId, practitionerId: slot.practitionerId, startsAt: slot.startsAt, endsAt: slot.endsAt }, options);
      if (outcome.offered) offered += 1;
      // Nobody is waiting for this service and place at any time in the range: the other times will not find anyone either.
      else if (outcome.reason === "nobody_waiting" && taken.size >= 3 && offered === 0) break;
    }
  }
  return offered;
}

interface OfferRow {
  id: string;
  entryId: string;
  chainId: string;
  position: number;
  origin: "automatic" | "manual";
  status: string;
  holdId: string | null;
  slot: FreedSlot;
}

async function loadOffer(run: Runner, tenantId: string, offerId: string): Promise<OfferRow | null> {
  const [row] = await run(sql`
    select offer.id, offer.entry_id, offer.chain_id, offer.position, offer.origin, offer.status, offer.hold_id,
      offer.location_id, offer.service_id, offer.practitioner_id, offer.starts_at, offer.ends_at, entry.patient_id
    from slot_offers as offer
    join waitlist_entries as entry on entry.tenant_id = offer.tenant_id and entry.id = offer.entry_id
    where offer.tenant_id = ${tenantId} and offer.id = ${offerId}
    for update of offer
  `);
  if (!row) return null;
  return {
    id: asString(row.id), entryId: asString(row.entry_id), chainId: asString(row.chain_id), position: asNumber(row.position),
    origin: row.origin === "manual" ? "manual" : "automatic", status: asString(row.status), holdId: row.hold_id ? asString(row.hold_id) : null,
    slot: {
      locationId: asString(row.location_id), serviceId: asString(row.service_id), practitionerId: asString(row.practitioner_id),
      startsAt: asDate(row.starts_at), endsAt: asDate(row.ends_at), excludePatientId: asString(row.patient_id),
    },
  };
}

export type OfferEnding = "expired" | "declined" | "withdrawn";

/**
 * Ends a live offer and moves on. The person goes back on the waiting list (they still want a time, just not this one),
 * the next person is asked about the same time using the same hold, and after three people, or when the time is under two
 * hours away, the time is released to public booking. Safe to call twice: a finished offer is left alone.
 */
export async function endOffer(
  run: Runner, tenantId: string, offerId: string, ending: OfferEnding,
  options: { now?: Date; reason?: OfferEndReason; cascade?: boolean; actorUserId?: string } = {},
): Promise<{ ended: boolean; next: OfferOutcome | null }> {
  const now = options.now ?? new Date();
  const offer = await loadOffer(run, tenantId, offerId);
  if (!offer || (offer.status !== "scheduled" && offer.status !== "sent")) return { ended: false, next: null };
  await run(sql`
    update slot_offers set status = ${ending}, token_sealed = null, ended_reason = ${options.reason ?? null},
      answered_at = ${ending === "declined" ? now.toISOString() : null}::timestamptz, updated_at = now()
    where tenant_id = ${tenantId} and id = ${offerId}
  `);
  await run(sql`update waitlist_entries set status = 'active', updated_at = now() where tenant_id = ${tenantId} and id = ${offer.entryId} and status = 'offered'`);
  await audit(run, tenantId, `waitlist.offer.${ending}`, { offerId, entryId: offer.entryId, chainId: offer.chainId, position: offer.position, ...(options.reason ? { reason: options.reason } : {}) }, options.actorUserId);

  if (options.cascade === false) {
    await releaseTime(run, tenantId, offer.chainId, offer.holdId, options.reason ?? "ended", offer.slot);
    return { ended: true, next: null };
  }
  const [{ count } = { count: 0 }] = await run(sql`select count(*)::int as count from slot_offers where tenant_id = ${tenantId} and chain_id = ${offer.chainId}`);
  if (asNumber(count) >= MAX_PEOPLE_PER_TIME) {
    await releaseTime(run, tenantId, offer.chainId, offer.holdId, "after_three_people", offer.slot);
    return { ended: true, next: { offered: false, reason: "nobody_waiting" } };
  }
  if (offer.origin === "automatic" && !(await automaticOffersOn(run, tenantId, offer.slot.serviceId))) {
    await releaseTime(run, tenantId, offer.chainId, offer.holdId, "automation_off", offer.slot);
    return { ended: true, next: { offered: false, reason: "automation_off" } };
  }
  const next = await offerToNext(run, tenantId, offer.slot, {
    chainId: offer.chainId, position: asNumber(count) + 1, origin: offer.origin, now, holdId: offer.holdId,
  });
  return { ended: true, next };
}

export type SendPlan =
  | { kind: "skip" }
  | { kind: "rescheduled"; sendAt: Date }
  | { kind: "send"; minutes: number; expiresAt: Date; startsAt: Date; endsAt: Date; entryId: string };

/**
 * Called by the worker just before it sends an offer's message. Checks the offer is still waiting to go, that quiet hours
 * have not started again (a business can change them), that the time is not now too close, and that the time is still
 * free, then starts the answer clock from this moment. A time that is no longer free ends the offer and the line.
 */
export async function planOfferSend(run: Runner, tenantId: string, offerId: string, now: Date): Promise<SendPlan> {
  const offer = await loadOffer(run, tenantId, offerId);
  if (!offer || offer.status !== "scheduled") return { kind: "skip" };
  const sendAt = await sendTimeFor(run, tenantId, offer.slot.locationId, now);
  if (sendAt.getTime() > now.getTime()) {
    // Quiet hours are on now. Move the offer, its hold and the message to the end of them.
    const answerBy = new Date(sendAt.getTime() + offerMinutes(offer.slot.startsAt, sendAt) * 60_000);
    await run(sql`update slot_offers set send_at = ${sendAt.toISOString()}::timestamptz, expires_at = ${answerBy.toISOString()}::timestamptz, updated_at = now()
      where tenant_id = ${tenantId} and id = ${offerId}`);
    await run(sql`update slot_holds set expires_at = ${new Date(answerBy.getTime() + HOLD_GRACE_MS).toISOString()}::timestamptz where tenant_id = ${tenantId} and id = ${offer.holdId}`);
    await run(sql`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, available_at)
      values (${tenantId}, 'slot_offer', ${offerId}, ${WAITLIST_MATCH_EVENT}, ${JSON.stringify({ offerId })}::text::jsonb,
        ${`${WAITLIST_MATCH_EVENT}:${offerId}:${sendAt.getTime()}`}, ${sendAt.toISOString()}::timestamptz)
      on conflict (tenant_id, dedupe_key) do nothing
    `);
    return { kind: "rescheduled", sendAt };
  }
  if (mustReleaseToPublic(offer.slot.startsAt, now)) {
    await endOffer(run, tenantId, offerId, "withdrawn", { now, reason: "too_close", cascade: false });
    return { kind: "skip" };
  }
  const minutes = offerMinutes(offer.slot.startsAt, now);
  const expiresAt = new Date(now.getTime() + minutes * 60_000);
  const until = new Date(expiresAt.getTime() + HOLD_GRACE_MS);
  // The usual case: the hold is still live, so it is only extended. Nothing is locked and the engine is not asked again,
  // because the message goes out later in this same transaction and nobody else's booking should wait for the provider.
  const extended = offer.holdId
    ? await run(sql`update slot_holds set expires_at = ${until.toISOString()}::timestamptz where tenant_id = ${tenantId} and id = ${offer.holdId} and expires_at > now() returning id`)
    : [];
  if (extended.length > 0) return { kind: "send", minutes, expiresAt, startsAt: offer.slot.startsAt, endsAt: offer.slot.endsAt, entryId: offer.entryId };
  try {
    await run(sql`savepoint waitlist_send`);
    await refreshHold(run, tenantId, offer, until);
    await run(sql`release savepoint waitlist_send`);
  } catch (error) {
    await run(sql`rollback to savepoint waitlist_send`);
    if (!(error instanceof ApiError)) throw error;
    await endOffer(run, tenantId, offerId, "withdrawn", { now, reason: "slot_gone", cascade: false });
    return { kind: "skip" };
  }
  return { kind: "send", minutes, expiresAt, startsAt: offer.slot.startsAt, endsAt: offer.slot.endsAt, entryId: offer.entryId };
}

/** Confirms the offered time is still free (ignoring this offer's own hold) and keeps the hold until `until`, making it again if it lapsed. */
async function refreshHold(run: Runner, tenantId: string, offer: OfferRow, until: Date): Promise<void> {
  const [person] = await run(sql`select id from practitioners where tenant_id = ${tenantId} and id = ${offer.slot.practitionerId} and is_active for update`);
  if (!person) throw new ApiError(409, "slot_unavailable", "That time is no longer available.");
  const check = await assertSlotOfferable(engineTransaction(run), {
    tenantId, locationId: offer.slot.locationId, serviceId: offer.slot.serviceId, practitionerId: offer.slot.practitionerId,
    startsAt: offer.slot.startsAt, endsAt: offer.slot.endsAt, mode: "existing", enforceLimits: true, keepExistingLength: true,
    ...(offer.holdId ? { ignoreHoldId: offer.holdId } : {}),
  });
  const updated = offer.holdId ? await run(sql`update slot_holds set expires_at = ${until.toISOString()}::timestamptz where tenant_id = ${tenantId} and id = ${offer.holdId} returning id`) : [];
  if (updated.length > 0) return;
  const rules = check.loaded.input.service;
  const [created] = await run(sql`
    insert into slot_holds (tenant_id, service_id, practitioner_id, location_id, resource_id, starts_at, ends_at, reserved_starts_at, reserved_ends_at, token_hash, purpose, expires_at)
    values (${tenantId}, ${offer.slot.serviceId}, ${offer.slot.practitionerId}, ${offer.slot.locationId}, ${check.resourceId},
      ${offer.slot.startsAt.toISOString()}::timestamptz, ${offer.slot.endsAt.toISOString()}::timestamptz,
      ${new Date(offer.slot.startsAt.getTime() - rules.bufferBeforeMinutes * 60_000).toISOString()}::timestamptz,
      ${new Date(offer.slot.endsAt.getTime() + rules.bufferAfterMinutes * 60_000).toISOString()}::timestamptz,
      ${sha256(createOpaqueToken())}, 'waitlist', ${until.toISOString()}::timestamptz)
    returning id
  `);
  await run(sql`update slot_offers set hold_id = ${asString(created?.id)} where tenant_id = ${tenantId} and id = ${offer.id}`);
}

/** The message went out: the offer is `sent`, the answer clock runs to `expiresAt`, and the worker is told when to expire it. */
export async function markOfferSent(run: Runner, tenantId: string, offerId: string, now: Date, expiresAt: Date): Promise<void> {
  await run(sql`
    update slot_offers set status = 'sent', sent_at = ${now.toISOString()}::timestamptz, expires_at = ${expiresAt.toISOString()}::timestamptz,
      token_sealed = null, updated_at = now()
    where tenant_id = ${tenantId} and id = ${offerId} and status = 'scheduled'
  `);
  await run(sql`
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, available_at)
    values (${tenantId}, 'slot_offer', ${offerId}, ${OFFER_EXPIRE_EVENT}, ${JSON.stringify({ offerId })}::text::jsonb,
      ${`${OFFER_EXPIRE_EVENT}:${offerId}`}, ${expiresAt.toISOString()}::timestamptz)
    on conflict (tenant_id, dedupe_key) do nothing
  `);
  await audit(run, tenantId, "waitlist.offer.sent", { offerId });
}

/**
 * The safety net behind the timed events: offers past their answer time are ended and passed on, and an offer whose
 * message never went out is queued again. Returns counts only.
 */
export async function sweepOffers(run: Runner, tenantId: string, now: Date): Promise<{ expired: number; requeued: number }> {
  const overdue = await run(sql`
    select id from slot_offers where tenant_id = ${tenantId} and status = 'sent' and expires_at <= now() order by expires_at limit 50
  `);
  let expired = 0;
  for (const row of overdue) {
    const result = await endOffer(run, tenantId, asString(row.id), "expired", { now });
    if (result.ended) expired += 1;
  }
  const stuck = await run(sql`
    select id from slot_offers where tenant_id = ${tenantId} and status = 'scheduled' and send_at <= now() - interval '2 minutes' limit 50
  `);
  const bucket = Math.floor(now.getTime() / 600_000);
  let requeued = 0;
  for (const row of stuck) {
    const inserted = await run(sql`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      values (${tenantId}, 'slot_offer', ${asString(row.id)}, ${WAITLIST_MATCH_EVENT}, ${JSON.stringify({ offerId: asString(row.id) })}::text::jsonb,
        ${`${WAITLIST_MATCH_EVENT}:${asString(row.id)}:sweep:${bucket}`})
      on conflict (tenant_id, dedupe_key) do nothing
      returning id
    `);
    requeued += inserted.length;
  }
  return { expired, requeued };
}
