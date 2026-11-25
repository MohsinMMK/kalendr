import { sql } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import {
  customerCancelDecision,
  customerRescheduleDecision,
  policyMessage,
  type CancelPolicy,
  type PolicyDecision,
} from "@/lib/cancel-policy";
import { ApiError } from "@/server/api-error";
import { sealGuests } from "@/server/booking-intake";
import { openPrivate, sealPrivate } from "@/server/messaging/sealed-link";

/**
 * The server's side of the cancel and reschedule policy (feature 42). The rule itself is the pure functions in
 * `src/lib/cancel-policy.ts`; this file reads a service's policy, refuses what the policy forbids, and seals the
 * notes customers and staff type. Staff are never held to the customer cut-offs.
 */

export async function loadCancelPolicy(transaction: KalendrTransaction, tenantId: string, serviceId: string): Promise<CancelPolicy> {
  const [row] = await transaction.execute<{
    allow_customer_cancel: boolean; allow_customer_reschedule: boolean; cancel_cutoff_minutes: number;
    reschedule_cutoff_minutes: number; reschedule_same_person: boolean; reschedule_request_days: number;
  }>(sql`
    select allow_customer_cancel, allow_customer_reschedule, cancel_cutoff_minutes, reschedule_cutoff_minutes,
      reschedule_same_person, reschedule_request_days
    from services where tenant_id = ${tenantId} and id = ${serviceId}
  `);
  return {
    allowCustomerCancel: row?.allow_customer_cancel ?? true,
    allowCustomerReschedule: row?.allow_customer_reschedule ?? true,
    cancelCutoffMinutes: row?.cancel_cutoff_minutes ?? 0,
    rescheduleCutoffMinutes: row?.reschedule_cutoff_minutes ?? 0,
    rescheduleSamePerson: row?.reschedule_same_person ?? true,
    rescheduleRequestDays: row?.reschedule_request_days ?? 7,
  };
}

async function businessPhone(transaction: KalendrTransaction, tenantId: string): Promise<string | null> {
  const [row] = await transaction.execute<{ phone: string | null }>(sql`select phone from tenants where id = ${tenantId}`);
  return row?.phone ?? null;
}

export type CustomerAction = "cancel" | "reschedule";

/** Throws the plain-words refusal when the policy forbids this customer action. The page's hint is only a hint. */
export async function assertCustomerMay(
  transaction: KalendrTransaction,
  input: { tenantId: string; action: CustomerAction; policy: CancelPolicy; startsAt: Date; now?: Date },
): Promise<void> {
  const decide = input.action === "cancel" ? customerCancelDecision : customerRescheduleDecision;
  const decision: PolicyDecision = decide(input.policy, input.startsAt, input.now ?? new Date());
  if (decision.allowed) return;
  throw new ApiError(
    403,
    input.action === "cancel" ? "cancel_not_allowed" : "reschedule_not_allowed",
    policyMessage(input.action, decision, input.policy, await businessPhone(transaction, input.tenantId)),
  );
}

/** A note typed by a customer or staff member, sealed so only staff screens read it. Null when empty (or when no key is set in production). */
export function sealNote(kind: "cancel" | "reschedule", tenantId: string, appointmentId: string, text: string | undefined): string | null {
  const trimmed = text?.trim();
  return trimmed ? sealPrivate(`${kind}-note`, tenantId, appointmentId, trimmed) : null;
}

export function openNote(kind: "cancel" | "reschedule", tenantId: string, appointmentId: string, sealed: string | null): string | null {
  return openPrivate(`${kind}-note`, tenantId, appointmentId, sealed);
}

/**
 * Checks a customer's or staff member's new guest list against the service's guest rules and returns the sealed list
 * to store (null when it is empty). The customer's own address is never listed as a guest.
 */
export async function prepareGuestEdit(
  transaction: KalendrTransaction,
  tenantId: string,
  serviceId: string,
  appointmentId: string,
  guests: string[],
): Promise<string | null> {
  const [service] = await transaction.execute<{ allow_guests: boolean; max_guests: number }>(sql`
    select allow_guests, max_guests from services where tenant_id = ${tenantId} and id = ${serviceId}
  `);
  const [patient] = await transaction.execute<{ email: string }>(sql`
    select patient.email from appointments as appointment
    join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
    where appointment.tenant_id = ${tenantId} and appointment.id = ${appointmentId}
  `);
  const customer = patient?.email?.trim().toLowerCase() ?? "";
  const clean = [...new Set(guests.map((guest) => guest.trim().toLowerCase()).filter((guest) => guest && guest !== customer))];
  if (clean.length > 0 && !service?.allow_guests) {
    throw new ApiError(422, "validation_error", "This booking does not take guests.", { guests: ["This booking does not take guests."] });
  }
  if (service && clean.length > service.max_guests) {
    const message = `You can add up to ${service.max_guests} ${service.max_guests === 1 ? "guest" : "guests"}.`;
    throw new ApiError(422, "validation_error", message, { guests: [message] });
  }
  return sealGuests(tenantId, appointmentId, clean);
}
