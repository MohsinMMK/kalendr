import "server-only";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase, type KalendrTransaction } from "@/db/client";
import { appointments } from "@/db/schema";
import type { BusinessProfile } from "@/lib/terminology";

import { ApiError, getPostgresErrorCode } from "./api-error";
import { assertBookingAllowed } from "./billing/enforcement";
import { insertReservations, loadBookingConfiguration, managePortalAppointment, recordMutation } from "./appointment-repository";
import { customerProfile, loadBusinessProfileIn } from "./business-profile";
import { resolveLocationChoice } from "./booking-location";
import { assertCustomerCap } from "./customer-cap";
import { createOpaqueToken, sha256 } from "./crypto";
import { sealManageToken } from "./messaging/sealed-link";
import { assertSlotOfferable } from "./slot-engine/commit";
import { notifyStaff } from "./staff-notifications";
import { deliveryModeForKind } from "./video/rules";
import { endOffer } from "./waitlist-offers";
import { drizzleRunner } from "./workflows/runner";

/**
 * Taking, declining and reading an offered time from the public offer link (feature 21). The token is the only proof,
 * so it is 256-bit, only its hash is stored, and every answer on this page looks the same whether a token never existed or
 * ran out. Taking the time books it through the normal booking checks inside one transaction that first locks the offer
 * row, so two taps cannot both book.
 */

const tokenSchema = z.string().min(20).max(200).regex(/^[A-Za-z0-9_-]+$/);

export function offerTokenFrom(value: string): string {
  const parsed = tokenSchema.safeParse(value);
  if (!parsed.success) throw offerGone();
  return parsed.data;
}

function offerGone(): ApiError {
  return new ApiError(404, "offer_not_found", "This link is not valid.");
}

function offerClosed(): ApiError {
  return new ApiError(410, "offer_closed", "This time is no longer available.");
}

export type OfferState = "open" | "booked" | "declined" | "closed";

export interface OfferView {
  state: OfferState;
  startsAt: string;
  endsAt: string;
  timezone: string;
  /** When the time to answer ends. */
  expiresAt: string;
  serviceName: string;
  practitionerName: string;
  locationName: string;
  business: { name: string; phone: string; slug: string };
  /** Once booked: a later booking of the same service the person could let go of. Only the time, no id. */
  laterAppointmentAt: string | null;
}

export interface OfferPage extends OfferView {
  profile: BusinessProfile;
}

export interface AcceptResult {
  appointmentId: string;
  status: "booked" | "requested";
  startsAt: string;
  endsAt: string;
  /** Only the call that booked it returns the link; asking again returns null. */
  manageToken: string | null;
  laterAppointmentAt: string | null;
}

async function resolve(token: string): Promise<{ tenantId: string; offerId: string }> {
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "This is not available right now. Please try again shortly.");
  const [row] = await database.execute<{ tenant_id: string; offer_id: string }>(sql`select * from kalendr_resolve_slot_offer(${sha256(token)})`);
  if (!row) throw offerGone();
  return { tenantId: row.tenant_id, offerId: row.offer_id };
}

async function inTenant<T>(tenantId: string, work: (transaction: KalendrTransaction) => Promise<T>): Promise<T> {
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "This is not available right now. Please try again shortly.");
  // Serializable, like every booking, and retried when the database asks (two taps at once).
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await database.transaction(async (transaction) => {
        await transaction.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        return work(transaction);
      }, { isolationLevel: "serializable" });
    } catch (error) {
      const code = getPostgresErrorCode(error);
      if ((code === "40001" || code === "40P01") && attempt < 3) continue;
      throw error;
    }
  }
}

interface OfferRow extends Record<string, unknown> {
  id: string;
  entry_id: string;
  patient_id: string;
  service_id: string;
  location_id: string;
  practitioner_id: string;
  starts_at: Date | string;
  ends_at: Date | string;
  status: string;
  hold_id: string | null;
  expires_at: Date | string;
  expired: boolean;
  appointment_id: string | null;
}

async function lockOffer(transaction: KalendrTransaction, tenantId: string, offerId: string): Promise<OfferRow> {
  const [row] = await transaction.execute<OfferRow>(sql`
    select offer.id, offer.entry_id, entry.patient_id, offer.service_id, offer.location_id, offer.practitioner_id,
      offer.starts_at, offer.ends_at, offer.status, offer.hold_id, offer.expires_at, offer.expires_at <= now() as expired, offer.appointment_id
    from slot_offers as offer
    join waitlist_entries as entry on entry.tenant_id = offer.tenant_id and entry.id = offer.entry_id
    where offer.tenant_id = ${tenantId} and offer.id = ${offerId}
    for update of offer
  `);
  if (!row) throw offerGone();
  return row;
}

interface LaterAppointment extends Record<string, unknown> {
  id: string;
  starts_at: Date | string;
  version: number;
}

/**
 * The person's own later booking for the same service, found on the server from the accepted offer, never named by the
 * caller. The earliest one after the new time.
 */
async function laterAppointmentFor(transaction: KalendrTransaction, tenantId: string, offer: Pick<OfferRow, "patient_id" | "service_id" | "starts_at" | "appointment_id">): Promise<LaterAppointment | null> {
  const [row] = await transaction.execute<LaterAppointment>(sql`
    select id, starts_at, version from appointments
    where tenant_id = ${tenantId} and patient_id = ${offer.patient_id} and service_id = ${offer.service_id}
      and status in ('requested', 'booked') and starts_at > ${new Date(offer.starts_at).toISOString()}::timestamptz
      and id is distinct from ${offer.appointment_id}
    order by starts_at limit 1
  `);
  return row ?? null;
}

/** What the public offer page shows. No contact detail, no booking id, no token. */
export async function readOffer(token: string): Promise<OfferPage> {
  const { tenantId, offerId } = await resolve(token);
  return inTenant(tenantId, async (transaction) => {
    const [row] = await transaction.execute<OfferRow & { service_name: string; practitioner_name: string; location_name: string; timezone: string; business_name: string; business_phone: string; slug: string; answered_at: Date | string | null }>(sql`
      select offer.id, offer.entry_id, entry.patient_id, offer.service_id, offer.location_id, offer.practitioner_id,
        offer.starts_at, offer.ends_at, offer.status, offer.hold_id, offer.expires_at, offer.expires_at <= now() as expired, offer.appointment_id,
        service.name as service_name, practitioner.name as practitioner_name, location.name as location_name,
        coalesce(location.timezone, tenant.timezone) as timezone, tenant.name as business_name, tenant.phone as business_phone, tenant.slug,
        offer.answered_at
      from slot_offers as offer
      join waitlist_entries as entry on entry.tenant_id = offer.tenant_id and entry.id = offer.entry_id
      join services as service on service.tenant_id = offer.tenant_id and service.id = offer.service_id
      join practitioners as practitioner on practitioner.tenant_id = offer.tenant_id and practitioner.id = offer.practitioner_id
      join locations as location on location.tenant_id = offer.tenant_id and location.id = offer.location_id
      join tenants as tenant on tenant.id = offer.tenant_id
      where offer.tenant_id = ${tenantId} and offer.id = ${offerId}
    `);
    if (!row) throw offerGone();
    const state: OfferState = row.status === "sent" && !row.expired ? "open"
      : row.status === "accepted" ? "booked"
        : row.status === "declined" ? "declined" : "closed";
    const later = state === "booked" && row.answered_at && Date.now() - new Date(row.answered_at).getTime() < 24 * 60 * 60_000
      ? await laterAppointmentFor(transaction, tenantId, row) : null;
    return {
      state,
      startsAt: new Date(row.starts_at).toISOString(),
      endsAt: new Date(row.ends_at).toISOString(),
      timezone: row.timezone,
      expiresAt: new Date(row.expires_at).toISOString(),
      serviceName: row.service_name,
      practitionerName: row.practitioner_name,
      locationName: row.location_name,
      business: { name: row.business_name, phone: row.business_phone, slug: row.slug },
      laterAppointmentAt: later ? new Date(later.starts_at).toISOString() : null,
      profile: customerProfile(await loadBusinessProfileIn(transaction, tenantId)),
    };
  });
}

/**
 * Takes the offered time. Locks the offer row, requires it to be sent and still inside its answer time, books through
 * the same checks as any booking (the offer's own hold is the only hold ignored), makes the waitlist entry fulfilled and
 * the offer accepted, and queues the usual confirmation. One transaction: either the person has the time or nothing changed.
 */
export async function acceptOffer(token: string): Promise<AcceptResult> {
  const { tenantId, offerId } = await resolve(token);
  try {
    return await inTenant(tenantId, async (transaction) => {
      const offer = await lockOffer(transaction, tenantId, offerId);
      const startsAt = new Date(offer.starts_at);
      const endsAt = new Date(offer.ends_at);
      if (offer.status === "accepted" && offer.appointment_id) {
        // The same link tapped twice: the same answer, without a second booking.
        const [booked] = await transaction.execute<{ status: "booked" | "requested" }>(sql`select status from appointments where tenant_id = ${tenantId} and id = ${offer.appointment_id}`);
        const later = await laterAppointmentFor(transaction, tenantId, offer);
        return { appointmentId: offer.appointment_id, status: booked?.status === "requested" ? "requested" : "booked", startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), manageToken: null, laterAppointmentAt: later ? new Date(later.starts_at).toISOString() : null };
      }
      if (offer.status !== "sent" || offer.expired) throw offerClosed();

      const configuration = await loadBookingConfiguration(transaction, tenantId, offer.location_id, offer.service_id, offer.practitioner_id);
      if (!configuration) throw offerClosed();
      await assertBookingAllowed(transaction, tenantId, offer.practitioner_id, "public"); // plan limits (feature 14), as every other way in
      // The offer's own hold does not block the booking it was made for; anything else still does.
      const check = await assertSlotOfferable(transaction, {
        tenantId, locationId: offer.location_id, serviceId: offer.service_id, practitionerId: offer.practitioner_id,
        startsAt, endsAt, mode: "existing", enforceLimits: true, keepExistingLength: true,
        ...(offer.hold_id ? { ignoreHoldId: offer.hold_id } : {}),
      });
      const [patient] = await transaction.execute<{ email: string; phone: string }>(sql`
        select email, phone from patients where tenant_id = ${tenantId} and id = ${offer.patient_id} and erased_at is null for key share
      `);
      if (!patient) throw offerClosed();
      // The later booking this person is likely to let go of does not count against the allowance for the earlier time they are taking.
      const mayLetGo = await laterAppointmentFor(transaction, tenantId, offer);
      await assertCustomerCap(transaction, { tenantId, serviceId: offer.service_id, email: patient.email, phone: patient.phone, ...(mayLetGo ? { excludeAppointmentId: mayLetGo.id } : {}) });
      const meeting = await resolveLocationChoice(transaction, tenantId, offer.service_id, offer.location_id, undefined, { defaultWhenUnasked: true });

      const manageToken = createOpaqueToken();
      const appointmentId = randomUUID();
      const status = configuration.booking_mode === "instant" ? "booked" : "requested";
      const [appointment] = await transaction.insert(appointments).values({
        id: appointmentId, tenantId, locationId: offer.location_id, patientId: offer.patient_id, practitionerId: offer.practitioner_id,
        serviceId: offer.service_id, startsAt, endsAt, status,
        ...(check.priceMinor !== null ? { priceMinor: check.priceMinor } : {}),
        locationKind: meeting.kind, locationDetail: meeting.detail,
        confirmationStatus: "needs_action", bookingSource: "waitlist", formStatus: "not_assigned", reminderStatus: "queued",
        deliveryMode: deliveryModeForKind(meeting.kind),
        manageTokenHash: sha256(manageToken), manageTokenCiphertext: sealManageToken(tenantId, appointmentId, manageToken),
      }).returning();
      if (!appointment) throw new Error("Appointment insert did not return a row");
      await insertReservations(transaction, tenantId, appointmentId, offer.practitioner_id, startsAt, endsAt, configuration, check.resourceId);
      // The booking itself keeps the time now.
      if (offer.hold_id) await transaction.execute(sql`delete from slot_holds where tenant_id = ${tenantId} and id = ${offer.hold_id}`);
      await transaction.execute(sql`
        update slot_offers set status = 'accepted', answered_at = now(), appointment_id = ${appointmentId}, token_sealed = null, hold_id = null, updated_at = now()
        where tenant_id = ${tenantId} and id = ${offerId}
      `);
      await transaction.execute(sql`update waitlist_entries set status = 'fulfilled', updated_at = now() where tenant_id = ${tenantId} and id = ${offer.entry_id}`);
      // Anything else still asking this person about this time (it should be nothing) is closed.
      const others = await transaction.execute<{ id: string }>(sql`
        select id from slot_offers where tenant_id = ${tenantId} and entry_id = ${offer.entry_id} and id <> ${offerId} and status in ('scheduled', 'sent')
      `);
      // Each of those times goes on to the next person, or back to public booking, rather than staying held for someone who has a time now.
      for (const other of others) await endOffer(drizzleRunner(transaction), tenantId, other.id, "withdrawn", { reason: "booked_elsewhere" });
      await transaction.execute(sql`
        insert into audit_events (tenant_id, appointment_id, actor_type, action, outcome, metadata)
        values (${tenantId}, ${appointmentId}, 'patient', 'waitlist.offer.accepted', 'success', ${JSON.stringify({ offerId, entryId: offer.entry_id })}::text::jsonb)
      `);
      // The usual "appointment created" record and message, so the confirmation goes out and the schedule shows it.
      await recordMutation(transaction, tenantId, appointmentId, "patient", "appointment.created", appointment.version);
      await notifyStaff(transaction, tenantId, { kind: "waitlist_filled", dedupeKey: `waitlist.fulfilled:${offer.entry_id}`, startsAt, locationId: offer.location_id, link: "/follow-ups" });
      const later = await laterAppointmentFor(transaction, tenantId, { ...offer, appointment_id: appointmentId });
      return {
        appointmentId, status, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), manageToken,
        laterAppointmentAt: later ? new Date(later.starts_at).toISOString() : null,
      };
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const code = getPostgresErrorCode(error);
    // Two taps that collided past the retries: whoever lost finds the time gone.
    if (code === "40001" || code === "40P01" || code === "23P01" || code === "23505") throw new ApiError(409, "slot_unavailable", "That time is no longer available.");
    throw error;
  }
}

/** "Not this time": the offer ends, the person stays on the waitlist, and the next person is asked straight away. */
export async function declineOffer(token: string): Promise<{ state: "declined" }> {
  const { tenantId, offerId } = await resolve(token);
  await inTenant(tenantId, async (transaction) => {
    const offer = await lockOffer(transaction, tenantId, offerId);
    if (offer.status === "declined") return;
    if (offer.status !== "sent" || offer.expired) throw offerClosed();
    await endOffer(drizzleRunner(transaction), tenantId, offerId, "declined");
  });
  return { state: "declined" };
}

/**
 * After taking the earlier time, lets the person cancel their later booking of the same service. The booking is found on
 * the server from the accepted offer. It goes through the normal cancel, which may itself offer that time to the waitlist.
 */
export async function cancelLaterAppointment(token: string): Promise<{ cancelled: true }> {
  const { tenantId, offerId } = await resolve(token);
  const target = await inTenant(tenantId, async (transaction) => {
    const offer = await lockOffer(transaction, tenantId, offerId);
    if (offer.status !== "accepted" || !offer.appointment_id) throw offerClosed();
    const [answered] = await transaction.execute<{ recent: boolean }>(sql`
      select answered_at > now() - interval '24 hours' as recent from slot_offers where tenant_id = ${tenantId} and id = ${offerId}
    `);
    if (!answered?.recent) throw offerClosed();
    const later = await laterAppointmentFor(transaction, tenantId, offer);
    if (!later) throw new ApiError(409, "no_later_appointment", "There is no later booking to cancel.");
    return { id: later.id, version: Number(later.version) };
  });
  await managePortalAppointment(tenantId, target.id, { action: "cancel", expectedVersion: target.version }, `offer:${offerId}`);
  return { cancelled: true };
}
