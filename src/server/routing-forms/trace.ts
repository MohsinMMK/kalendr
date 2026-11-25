import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { routingFormVersions, routingResponses } from "@/db/schema";
import type { FormAnswers } from "@/lib/booking-forms";
import { prefillFromAnswers, routingDefinitionSchema, traceSummary, type AppointmentRoutingView, type RoutingTrace } from "@/lib/routing-forms";
import { ApiError } from "@/server/api-error";
import { createOpaqueToken, sha256 } from "@/server/crypto";
import { assertAppointmentVisibleHere } from "@/server/location-scope";
import { loadRecordKeys, openText } from "@/server/record-crypto";
import { requirePermission, type StaffContext } from "@/server/staff-context";

import { jsonValue } from "./json";

/**
 * How a routed customer's token is used on the way to a booking (feature 46). The token is the only thing the browser
 * carries: the people who may be offered and their weights are read from the server's own row, never from a request.
 */

export interface RoutingGrant {
  responseId: string;
  serviceId: string;
  candidateIds: string[];
  multipliers: Record<string, number>;
}

const expired = () => new ApiError(400, "routing_expired", "This booking link has expired. Please start again from the form.");

/** The grant behind a token for this service. Anything wrong with it (unknown, expired, another service) is `routing_expired`. */
export async function resolveRoutingToken(transaction: KalendrTransaction, tenantId: string, token: string, serviceId: string): Promise<RoutingGrant> {
  const [row] = await transaction.select().from(routingResponses)
    .where(and(eq(routingResponses.tenantId, tenantId), eq(routingResponses.tokenHash, sha256(token)), sql`${routingResponses.expiresAt} > now()`)).limit(1);
  if (!row || row.destinationType !== "service" || row.serviceId !== serviceId || row.answeredAt === null) throw expired();
  return { responseId: row.id, serviceId, candidateIds: row.candidateIds, multipliers: row.multipliers };
}

/** Marks that the customer was shown times: the third step of the funnel. Idempotent. */
export async function markSlotsShown(transaction: KalendrTransaction, tenantId: string, grant: RoutingGrant): Promise<void> {
  await transaction.execute(sql`
    update routing_responses set slot_shown_at = coalesce(slot_shown_at, now()) where tenant_id = ${tenantId} and id = ${grant.responseId}
  `);
}

/** A named person outside the routed set cannot be booked through the token. */
export function assertPersonAllowed(grant: RoutingGrant, practitionerId: string): void {
  if (!grant.candidateIds.includes(practitionerId)) {
    throw new ApiError(409, "slot_unavailable", "That time is no longer available. Please choose another slot.");
  }
}

/**
 * Called inside the booking transaction. Links the response to the appointment, records who got it and why, and marks the
 * outcome booked. A token that already led to a booking is copied to a new row, so every booking has its own trace.
 */
export async function linkRoutingBooking(
  transaction: KalendrTransaction,
  tenantId: string,
  grant: RoutingGrant,
  booking: { appointmentId: string; patientId: string; assignment: { personId: string; name: string; why: string } },
): Promise<void> {
  const [row] = await transaction.select().from(routingResponses).where(and(eq(routingResponses.tenantId, tenantId), eq(routingResponses.id, grant.responseId))).for("update").limit(1);
  if (!row) return;
  const trace = { ...(row.trace as unknown as RoutingTrace), assignment: booking.assignment };
  if (row.appointmentId === null) {
    await transaction.update(routingResponses).set({ appointmentId: booking.appointmentId, patientId: booking.patientId, outcome: "booked", bookedAt: new Date(), trace: trace as unknown as Record<string, unknown> })
      .where(and(eq(routingResponses.tenantId, tenantId), eq(routingResponses.id, row.id)));
    return;
  }
  await transaction.insert(routingResponses).values({
    tenantId, formId: row.formId, formVersion: row.formVersion, tokenHash: sha256(createOpaqueToken()), answersCiphertext: row.answersCiphertext, keyVersion: row.keyVersion,
    routeId: row.routeId, routeName: row.routeName, destinationType: row.destinationType, serviceId: row.serviceId, candidateIds: row.candidateIds, multipliers: row.multipliers,
    trace: trace as unknown as Record<string, unknown>, outcome: "booked", appointmentId: booking.appointmentId, patientId: booking.patientId,
    openedAt: row.openedAt, answeredAt: row.answeredAt, slotShownAt: row.slotShownAt, bookedAt: new Date(), expiresAt: row.expiresAt,
  });
}

/**
 * For the booking page: the service a token routes to, the people it offers, and the answers shared with the booking form by link name. Null for
 * an unknown or expired token, so the page just shows the ordinary booking page.
 */
export async function getRoutingPrefill(tenantId: string, token: string): Promise<{ serviceId: string; prefill: Record<string, string>; candidateIds: string[] } | null> {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return null;
  return withTenant(tenantId, async (transaction) => {
    const [row] = await transaction.select().from(routingResponses)
      .where(and(eq(routingResponses.tenantId, tenantId), eq(routingResponses.tokenHash, sha256(token)), sql`${routingResponses.expiresAt} > now()`)).limit(1);
    if (!row || row.destinationType !== "service" || !row.serviceId || !row.answersCiphertext) return null;
    const [version] = await transaction.select().from(routingFormVersions)
      .where(and(eq(routingFormVersions.tenantId, tenantId), eq(routingFormVersions.formId, row.formId), eq(routingFormVersions.version, row.formVersion))).limit(1);
    const parsed = version ? routingDefinitionSchema.safeParse(version.definition) : null;
    if (!parsed?.success) return null;
    await loadRecordKeys(transaction, tenantId);
    const answers = JSON.parse(openText(tenantId, row.answersCiphertext)) as FormAnswers;
    return { serviceId: row.serviceId, prefill: prefillFromAnswers(parsed.data.questions, answers), candidateIds: row.candidateIds };
  });
}

/** The routing trace shown on a booking, or null when it was not made through a form. */
export async function getAppointmentRouting(context: StaffContext, appointmentId: string): Promise<AppointmentRoutingView | null> {
  requirePermission(context, "schedule.read");
  if (context.preview) return null;
  return withTenant(context.tenantId, async (transaction) => {
    // A visit at a location this person may not use reads as not found, like the rest of the visit's screens.
    await assertAppointmentVisibleHere(transaction, context, appointmentId);
    const [row] = await transaction.execute<{ trace: RoutingTrace | null; route_name: string | null; booked_at: Date | string | null; form_name: string }>(sql`
      select response.trace, response.route_name, response.booked_at, version.name as form_name
      from routing_responses as response
      join routing_form_versions as version on version.tenant_id = response.tenant_id and version.form_id = response.form_id and version.version = response.form_version
      where response.tenant_id = ${context.tenantId} and response.appointment_id = ${appointmentId}
    `);
    const trace = row ? jsonValue(row.trace) as RoutingTrace | null : null;
    if (!row || !trace) return null;
    return {
      formName: row.form_name,
      routeName: row.route_name ?? trace.matchedRouteName,
      routedAt: new Date(row.booked_at ?? Date.now()).toISOString(),
      trace,
      summary: traceSummary(trace),
    };
  });
}
