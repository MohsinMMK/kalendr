import "server-only";

import { z } from "zod";
import { sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { waitlistOrderRules, type WaitlistOrderRule } from "@/lib/waitlist";
import { profileWords } from "@/lib/terminology";

import { ApiError } from "./api-error";
import { loadBusinessProfileIn } from "./business-profile";
import { claimKey, finishKey } from "./idempotent";
import { andLocation, canUseLocation } from "./location-scope";
import { requirePermission, type StaffContext } from "./staff-context";
import { endOffer, offerSlot } from "./waitlist-offers";
import { drizzleRunner } from "./workflows/runner";

/**
 * What staff see and do about the waitlist's offers (feature 21): the trail for each open time (who was asked, who
 * answered), the order rule, the switch for automatic offers per service, offering a time by hand, and letting a held time
 * go. Names are shown because staff already see them on the waitlist; no phone, email or link appears here.
 */

export const orderRuleInput = z.strictObject({ orderRule: z.enum(waitlistOrderRules as [WaitlistOrderRule, ...WaitlistOrderRule[]]) });
export const automaticOffersInput = z.strictObject({ automatic: z.boolean() });
export const offerByHandInput = z.strictObject({
  practitionerId: z.string().min(1).max(80),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
});

export interface OfferTrailEntry {
  offerId: string;
  position: number;
  personName: string;
  origin: "automatic" | "manual";
  status: "scheduled" | "sent" | "accepted" | "declined" | "expired" | "withdrawn";
  /** When the message went out. */
  sentAt: string | null;
  /** The end of the time to answer. */
  expiresAt: string;
  answeredAt: string | null;
  endedReason: string | null;
}

export interface OpenSlotTrail {
  chainId: string;
  serviceId: string;
  serviceName: string;
  practitionerId: string;
  practitionerName: string;
  locationId: string;
  startsAt: string;
  endsAt: string;
  /** `live` while someone is being asked, `taken` once accepted, `released` when it went to public booking. */
  state: "live" | "taken" | "released";
  offers: OfferTrailEntry[];
}

export interface WaitlistOffersOverview {
  orderRule: WaitlistOrderRule;
  services: Array<{ serviceId: string; name: string; automatic: boolean; waiting: number }>;
  slots: OpenSlotTrail[];
}

interface TrailRow extends Record<string, unknown> {
  id: string; chain_id: string; position: number; origin: "automatic" | "manual"; status: OfferTrailEntry["status"];
  service_id: string; service_name: string; practitioner_id: string; practitioner_name: string; location_id: string;
  starts_at: Date | string; ends_at: Date | string; sent_at: Date | string | null; expires_at: Date | string; answered_at: Date | string | null;
  ended_reason: string | null; first_name: string | null; last_name: string | null;
}

const iso = (value: Date | string): string => new Date(value).toISOString();

export async function getWaitlistOffers(context: StaffContext): Promise<WaitlistOffersOverview> {
  requirePermission(context, "appointments.book");
  return withTenant(context.tenantId, async (transaction) => {
    const [settings] = await transaction.execute<{ order_rule: string }>(sql`select order_rule from waitlist_settings where tenant_id = ${context.tenantId}`);
    const services = await transaction.execute<{ id: string; name: string; automatic: boolean | null; waiting: number }>(sql`
      select service.id, service.name, switch.automatic_offers as automatic,
        (select count(*)::int from waitlist_entries as entry where entry.tenant_id = service.tenant_id and entry.service_id = service.id and entry.status in ('active', 'offered')) as waiting
      from services as service
      left join waitlist_service_switches as switch on switch.tenant_id = service.tenant_id and switch.service_id = service.id
      where service.tenant_id = ${context.tenantId} and service.is_active
      order by service.name
    `);
    // The last week's chains and every upcoming one. Names only: staff already see these people on the waitlist.
    const rows = await transaction.execute<TrailRow>(sql`
      select offer.id, offer.chain_id, offer.position, offer.origin, offer.status, offer.service_id, service.name as service_name,
        offer.practitioner_id, practitioner.name as practitioner_name, offer.location_id, offer.starts_at, offer.ends_at,
        offer.sent_at, offer.expires_at, offer.answered_at, offer.ended_reason, patient.first_name, patient.last_name
      from slot_offers as offer
      join services as service on service.tenant_id = offer.tenant_id and service.id = offer.service_id
      join practitioners as practitioner on practitioner.tenant_id = offer.tenant_id and practitioner.id = offer.practitioner_id
      join waitlist_entries as entry on entry.tenant_id = offer.tenant_id and entry.id = offer.entry_id
      join patients as patient on patient.tenant_id = entry.tenant_id and patient.id = entry.patient_id
      where offer.tenant_id = ${context.tenantId} and offer.starts_at > now() - interval '7 days'
        ${andLocation(context, sql`offer.location_id`)}
      order by offer.starts_at desc, offer.chain_id, offer.position
      limit 300
    `);
    const chains = new Map<string, OpenSlotTrail>();
    for (const row of rows) {
      const entry: OfferTrailEntry = {
        offerId: row.id, position: Number(row.position), personName: `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim(), origin: row.origin,
        status: row.status, sentAt: row.sent_at ? iso(row.sent_at) : null, expiresAt: iso(row.expires_at),
        answeredAt: row.answered_at ? iso(row.answered_at) : null, endedReason: row.ended_reason,
      };
      const existing = chains.get(row.chain_id);
      if (existing) existing.offers.push(entry);
      else chains.set(row.chain_id, {
        chainId: row.chain_id, serviceId: row.service_id, serviceName: row.service_name, practitionerId: row.practitioner_id,
        practitionerName: row.practitioner_name, locationId: row.location_id, startsAt: iso(row.starts_at), endsAt: iso(row.ends_at), state: "released", offers: [entry],
      });
    }
    for (const chain of chains.values()) {
      chain.state = chain.offers.some((offer) => offer.status === "scheduled" || offer.status === "sent") ? "live"
        : chain.offers.some((offer) => offer.status === "accepted") ? "taken" : "released";
    }
    return {
      orderRule: settings?.order_rule === "soonest_existing" ? "soonest_existing" : "longest_waiting",
      services: services.map((service) => ({ serviceId: service.id, name: service.name, automatic: service.automatic !== false, waiting: Number(service.waiting) })),
      slots: [...chains.values()].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)),
    };
  });
}

async function audit(transaction: KalendrTransaction, context: StaffContext, action: string, metadata: Record<string, unknown>): Promise<void> {
  await transaction.execute(sql`
    insert into audit_events (tenant_id, actor_user_id, actor_type, action, outcome, metadata)
    values (${context.tenantId}, ${context.userId}, 'staff', ${action}, 'success', ${JSON.stringify(metadata)}::text::jsonb)
  `);
}

export async function setOrderRule(context: StaffContext, orderRule: WaitlistOrderRule): Promise<{ orderRule: WaitlistOrderRule }> {
  requirePermission(context, "waitlist.manage");
  await withTenant(context.tenantId, async (transaction) => {
    await transaction.execute(sql`
      insert into waitlist_settings (tenant_id, order_rule) values (${context.tenantId}, ${orderRule})
      on conflict (tenant_id) do update set order_rule = excluded.order_rule, updated_at = now()
    `);
    await audit(transaction, context, "waitlist.order_rule.changed", { orderRule });
  });
  return { orderRule };
}

export async function setServiceAutomatic(context: StaffContext, serviceId: string, automatic: boolean): Promise<{ serviceId: string; automatic: boolean }> {
  requirePermission(context, "waitlist.manage");
  await withTenant(context.tenantId, async (transaction) => {
    const t = profileWords(await loadBusinessProfileIn(transaction, context.tenantId));
    const [service] = await transaction.execute<{ id: string }>(sql`select id from services where tenant_id = ${context.tenantId} and id = ${serviceId}`);
    if (!service) throw new ApiError(404, "service_not_found", `${t.Service} not found.`);
    await transaction.execute(sql`
      insert into waitlist_service_switches (tenant_id, service_id, automatic_offers) values (${context.tenantId}, ${serviceId}, ${automatic})
      on conflict (tenant_id, service_id) do update set automatic_offers = excluded.automatic_offers, updated_at = now()
    `);
    await audit(transaction, context, "waitlist.automation.changed", { serviceId, automatic });
  });
  return { serviceId, automatic };
}

export interface OfferByHandResult {
  offerId: string;
  chainId: string;
}

/**
 * Offers a time to one waiting person by hand. It takes the same hold and checks as an automatic offer, so the time leaves
 * public booking at once and an overlapping booking is refused. The person's dates and time of day are not checked: staff
 * decided. The same Idempotency-Key gives the same answer, and a person already being offered something is refused.
 */
export async function offerByHand(context: StaffContext, entryId: string, input: z.infer<typeof offerByHandInput>, idempotencyKey: string): Promise<OfferByHandResult> {
  requirePermission(context, "waitlist.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const claim = await claimKey<OfferByHandResult | string>(transaction, context.tenantId, `staff.waitlist.offer:${entryId}`, idempotencyKey, { entryId, ...input });
    if ("replay" in claim) return typeof claim.replay === "string" ? JSON.parse(claim.replay) as OfferByHandResult : claim.replay;
    const t = profileWords(await loadBusinessProfileIn(transaction, context.tenantId));
    const [entry] = await transaction.execute<{ service_id: string; location_id: string; patient_id: string; status: string }>(sql`
      select service_id, location_id, patient_id, status from waitlist_entries where tenant_id = ${context.tenantId} and id = ${entryId} for update
    `);
    if (!entry || !canUseLocation(context, entry.location_id)) throw new ApiError(404, "waitlist_not_found", "Waitlist entry not found.");
    if (entry.status !== "active" && entry.status !== "offered") throw new ApiError(409, "waitlist_closed", `This ${t.customer} is no longer waiting.`);
    const outcome = await offerSlot(drizzleRunner(transaction), context.tenantId, {
      locationId: entry.location_id, serviceId: entry.service_id, practitionerId: input.practitionerId,
      startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt),
    }, { origin: "manual", entryId, actorUserId: context.userId ?? undefined });
    if (!outcome.offered) {
      const message = outcome.reason === "too_close" ? "That time is less than two hours away, so it is not offered. Book it directly instead."
        : outcome.reason === "already_offered" ? "That time is already being offered to someone."
          : outcome.reason === "slot_unavailable" ? "That time is not open any more. Pick another."
            : `This ${t.customer} cannot be offered that time right now. They may already have an offer waiting for an answer.`;
      throw new ApiError(409, "offer_not_possible", message);
    }
    const result = { offerId: outcome.offerId, chainId: outcome.chainId };
    await finishKey(transaction, claim.claimId, result);
    return result;
  });
}

/** Staff let a held time go: the live offer is withdrawn, the person goes back on the waitlist, and the time returns to public booking. */
export async function withdrawOffer(context: StaffContext, offerId: string): Promise<{ withdrawn: boolean }> {
  requirePermission(context, "waitlist.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const [offer] = await transaction.execute<{ id: string; location_id: string }>(sql`select id, location_id from slot_offers where tenant_id = ${context.tenantId} and id = ${offerId}`);
    if (!offer || !canUseLocation(context, offer.location_id)) throw new ApiError(404, "offer_not_found", "That offer was not found.");
    const result = await endOffer(drizzleRunner(transaction), context.tenantId, offerId, "withdrawn", { reason: "staff", cascade: false, actorUserId: context.userId ?? undefined });
    return { withdrawn: result.ended };
  });
}
