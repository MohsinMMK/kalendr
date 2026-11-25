import "server-only";

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import type { PublicBookingInput } from "@/lib/contracts";
import { normalizeContact } from "@/lib/patient-contact";
import type { Service } from "@/lib/domain";

import { ApiError } from "../api-error";
import { listAvailabilityDetailed, createAppointment, manageAssistantAppointment } from "../appointment-repository";
import { applyFeatureLimits, loadBusinessProfileBySlug } from "../business-profile";
import { canonicalJsonHash } from "../crypto";
import { hitRateLimit, recordRefusal } from "../rate-limit";
import { rateLimitRules } from "../rate-limit-rules";
import { getPublicClinicCatalog, type PublicClinicCatalog } from "../public-catalog";
import { createSlotHold } from "../slot-holds";
import { assertSlugNotPaused } from "../tenant-pause";
import { PROPOSAL_MINUTES } from "./guardrails";
import { setPending, textArray, type Pending } from "./store";
import type { ToolContext } from "./context";

/**
 * The three changes the assistant can propose, and the code that makes them real (feature 30).
 *
 * `propose*` checks a change against the live booking engine and stores it, sealed, on the conversation. It changes nothing a customer
 * can see. `commit` runs only when the customer's own confirm for that exact proposal arrives, and goes through the same functions the
 * booking page and the manage link use, so every limit, policy, message and audit row of the normal path applies.
 */

export async function catalogFor(context: Pick<ToolContext, "slug">): Promise<PublicClinicCatalog> {
  await assertSlugNotPaused(context.slug);
  const catalog = await getPublicClinicCatalog(context.slug);
  if (!catalog) throw new ApiError(404, "clinic_not_found", "Business not found.");
  return catalog;
}

/** Services the assistant can take all the way: no online payment, no emailed code, no email-only contact. Others get the booking link. */
export function assistantCanBook(service: Service): boolean {
  if (service.isActive === false || !service.slug) return false;
  if (service.payment) return false;
  if (service.paymentMode && service.paymentMode !== "none") return false;
  if (service.intake?.verifyEmail) return false;
  if (service.intake?.contactMode === "email_required") return false;
  return true;
}

export function formatWhen(startsAt: string | Date, timeZone: string): string {
  const date = typeof startsAt === "string" ? new Date(startsAt) : startsAt;
  const day = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(date).replace(/\s/g, " ");
  return `${day} at ${time}`;
}

function expiry(now: Date): Date {
  return new Date(now.getTime() + PROPOSAL_MINUTES * 60_000);
}

export interface BookProposalInput {
  serviceId: string; personId: string; startsAt: string; firstName: string; lastName: string; phone: string; email?: string | undefined; locationId?: string | undefined;
}

/** Checks the time against what the booking page would offer, takes a short hold on it, and stores the proposal. */
export async function proposeBooking(context: ToolContext, input: BookProposalInput): Promise<{ proposalId: string; summary: string }> {
  const catalog = await catalogFor(context);
  const service = catalog.services.find((entry) => entry.id === input.serviceId);
  if (!service || !assistantCanBook(service)) {
    throw new ApiError(409, "service_not_bookable", `This can't be booked in chat. Give the customer the booking page: ${context.bookingLink}`);
  }
  const person = catalog.practitioners.find((entry) => entry.id === input.personId && entry.isActive !== false);
  if (!person || !service.practitionerIds.includes(person.id)) throw new ApiError(404, "person_not_found", "That person doesn't offer this. Check list_staff.");
  const places = catalog.locations.filter((place) => place.isActive !== false && (service.locationIds.length === 0 || service.locationIds.includes(place.id)) && person.locationIds.includes(place.id));
  const place = input.locationId ? places.find((entry) => entry.id === input.locationId) : places[0];
  if (!place) throw new ApiError(404, "location_not_found", "No place matches this service and person.");

  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() <= context.now.getTime()) throw new ApiError(409, "slot_unavailable", "That time is not available. Ask for open times again.");
  const listing = await listAvailabilityDetailed({
    clinicSlug: context.slug, locationId: place.id, serviceId: service.id, practitionerId: person.id,
    from: new Date(startsAt.getTime() - 60_000).toISOString(), to: new Date(startsAt.getTime() + 3_600_000).toISOString(),
  });
  // A time the model made up, or one that has just gone, is not in this list.
  const slot = listing.slots.find((entry) => entry.practitionerId === person.id && new Date(entry.startsAt).getTime() === startsAt.getTime());
  if (!slot) throw new ApiError(409, "slot_unavailable", "That time is not available. Ask for open times again.");

  const hold = await createSlotHold({ clinicSlug: context.slug, locationId: place.id, serviceId: service.id, practitionerId: person.id, startsAt: slot.startsAt, endsAt: slot.endsAt });
  const timeZone = place.timezone || catalog.clinic.timezone;
  const requested = service.bookingMode === "request";
  const summary = `${service.name} with ${person.name} on ${formatWhen(slot.startsAt, timeZone)}${place.name ? ` at ${place.name}` : ""}, for ${`${input.firstName} ${input.lastName}`.trim()}${requested ? ". This is a request: the team has to approve it first" : ""}.`;
  const pending: Pending = {
    kind: "book", summary, atTurn: context.conversation.turnCount, serviceId: service.id, serviceName: service.name, personId: person.id, personName: person.name, locationId: place.id,
    startsAt: slot.startsAt, endsAt: slot.endsAt, holdToken: hold.holdToken, firstName: input.firstName, lastName: input.lastName, phone: input.phone, email: input.email ?? "",
  };
  const proposalId = await withTenant(context.tenantId, (transaction) => setPending(transaction, context.tenantId, context.conversation.id, pending, expiry(context.now)));
  return { proposalId, summary };
}

interface AppointmentFacts extends Record<string, unknown> {
  id: string; version: number; status: string; starts_at: Date | string; service_id: string; service_name: string; practitioner_id: string; practitioner_name: string;
  location_id: string; timezone: string;
}

async function loadOwnAppointment(context: ToolContext, appointmentId: string): Promise<AppointmentFacts> {
  const verified = context.conversation.verifiedPatientIds;
  // The customer's chat may only touch what it showed them, and only for people it has verified.
  if (!verified.length || !context.conversation.shownAppointmentIds.includes(appointmentId)) {
    throw new ApiError(403, "not_verified", "That booking hasn't been shown to this customer. Call find_my_bookings first.");
  }
  const rows = await withTenant(context.tenantId, (transaction) => transaction.execute<AppointmentFacts>(sql`
    select appointment.id, appointment.version, appointment.status, appointment.starts_at, appointment.service_id, service.name as service_name,
      appointment.practitioner_id, practitioner.name as practitioner_name, appointment.location_id, location.timezone
    from appointments as appointment
    join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
    join practitioners as practitioner on practitioner.tenant_id = appointment.tenant_id and practitioner.id = appointment.practitioner_id
    join locations as location on location.tenant_id = appointment.tenant_id and location.id = appointment.location_id
    where appointment.tenant_id = ${context.tenantId} and appointment.id = ${appointmentId}
      and appointment.patient_id = any(${textArray(verified)})
      and appointment.status in ('booked', 'requested') and appointment.starts_at > now()
  `));
  const row = rows[0];
  if (!row) throw new ApiError(404, "appointment_not_found", "That booking can't be changed here.");
  return row;
}

export async function proposeCancel(context: ToolContext, appointmentId: string): Promise<{ proposalId: string; summary: string }> {
  const appointment = await loadOwnAppointment(context, appointmentId);
  const summary = `Cancel ${appointment.service_name} with ${appointment.practitioner_name} on ${formatWhen(appointment.starts_at, appointment.timezone)}.`;
  const pending: Pending = { kind: "cancel", summary, atTurn: context.conversation.turnCount, appointmentId, version: appointment.version };
  const proposalId = await withTenant(context.tenantId, (transaction) => setPending(transaction, context.tenantId, context.conversation.id, pending, expiry(context.now)));
  return { proposalId, summary };
}

export async function proposeReschedule(context: ToolContext, input: { appointmentId: string; newStartsAt: string; personId?: string | undefined }): Promise<{ proposalId: string; summary: string }> {
  const appointment = await loadOwnAppointment(context, input.appointmentId);
  const personId = input.personId ?? appointment.practitioner_id;
  const startsAt = new Date(input.newStartsAt);
  if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() <= context.now.getTime()) throw new ApiError(409, "slot_unavailable", "That time is not available. Ask for open times again.");
  const listing = await listAvailabilityDetailed({
    clinicSlug: context.slug, locationId: appointment.location_id, serviceId: appointment.service_id, practitionerId: personId,
    from: new Date(startsAt.getTime() - 60_000).toISOString(), to: new Date(startsAt.getTime() + 3_600_000).toISOString(),
  });
  const slot = listing.slots.find((entry) => entry.practitionerId === personId && new Date(entry.startsAt).getTime() === startsAt.getTime());
  if (!slot) throw new ApiError(409, "slot_unavailable", "That time is not available. Ask for open times again.");
  const catalog = await catalogFor(context);
  const personName = catalog.practitioners.find((entry) => entry.id === personId)?.name ?? appointment.practitioner_name;
  const summary = `Move ${appointment.service_name} from ${formatWhen(appointment.starts_at, appointment.timezone)} to ${formatWhen(slot.startsAt, appointment.timezone)} with ${personName}.`;
  const pending: Pending = { kind: "reschedule", summary, atTurn: context.conversation.turnCount, appointmentId: input.appointmentId, version: appointment.version, personId, startsAt: slot.startsAt };
  const proposalId = await withTenant(context.tenantId, (transaction) => setPending(transaction, context.tenantId, context.conversation.id, pending, expiry(context.now)));
  return { proposalId, summary };
}

export type CommitResult = { ok: true; summary: string; status?: string } | { ok: false; code: string; message: string };

/** An id the booking engine accepts as an idempotency key and that is the same for every retry of this proposal. */
function idempotencyFor(tenantId: string, conversationId: string, pendingId: string): string {
  return `assistant:${createHash("sha256").update(`${tenantId}:${conversationId}:${pendingId}`).digest("hex").slice(0, 40)}`;
}

/**
 * Makes a confirmed proposal real. Called only by the loop, only when the customer's own confirm for this proposal's id has arrived.
 * A failure comes back as a plain reason, never thrown, so the loop can tell the model and the customer what to do next.
 */
export async function commitPending(context: ToolContext, pendingId: string, pending: Pending): Promise<CommitResult> {
  try {
    if (pending.kind === "book") {
      const phone = normalizeContact("phone", pending.phone);
      if (!phone) return { ok: false, code: "bad_phone", message: "The phone number isn't valid." };
      const limited = await hitRateLimit("booking.contact", `phone:${phone}`);
      if (!limited.allowed) {
        recordRefusal("booking.contact");
        return { ok: false, code: "rate_limited", message: rateLimitRules["booking.contact"].message };
      }
      const catalog = await catalogFor(context);
      const service = catalog.services.find((entry) => entry.id === pending.serviceId);
      const patientType = service?.patientTypes.includes("new") ? "new" : "returning";
      const channel = context.channel === "whatsapp" ? "whatsapp" : "sms";
      const request: PublicBookingInput = {
        clinicSlug: context.slug, patientType, bookingFor: "self", locationId: pending.locationId, serviceId: pending.serviceId, practitionerId: pending.personId,
        slotId: `assistant_${pendingId.slice(0, 16)}`, startsAt: pending.startsAt, endsAt: pending.endsAt,
        firstName: pending.firstName, lastName: pending.lastName, phone: pending.phone, email: pending.email, preferredChannel: channel,
        // The confirm carries these: the proposal told the customer about the privacy notice and the reminders.
        acceptedPrivacyNotice: true, messagingConsent: true,
        origin: { channel: "hosted", utmSource: "assistant", utmMedium: context.channel },
        ...(pending.holdToken ? { holdToken: pending.holdToken } : {}),
      };
      const input = applyFeatureLimits(request, await loadBusinessProfileBySlug(context.slug));
      const created = await createAppointment(input, idempotencyFor(context.tenantId, context.conversation.id, pendingId), canonicalJsonHash(input), { source: "assistant" });
      return { ok: true, summary: pending.summary, status: created.status };
    }
    if (pending.kind === "cancel") {
      await manageAssistantAppointment(context.tenantId, pending.appointmentId, { action: "cancel", expectedVersion: pending.version });
      return { ok: true, summary: pending.summary };
    }
    if (pending.kind === "reschedule") {
      await manageAssistantAppointment(context.tenantId, pending.appointmentId, { action: "reschedule", startsAt: pending.startsAt, practitionerId: pending.personId, expectedVersion: pending.version });
      return { ok: true, summary: pending.summary };
    }
    return { ok: false, code: "not_supported", message: "That change can't be made from here." };
  } catch (error: unknown) {
    if (error instanceof ApiError) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}
