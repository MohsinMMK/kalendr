import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import { ApiError } from "@/server/api-error";

/**
 * "A customer can hold at most N future bookings of this service" (feature 38). The customer is matched
 * by email or phone, normalised the way the rest of the product matches them, not by patient record:
 * a typo in a name makes a new record but must not make a new allowance. Contacts are hashed before they
 * are used as lock keys, and neither the contact nor the booking details are ever put in a response.
 */

/** Thrown when the cap is reached. `resendAppointmentId` is the booking the customer is told about by message. */
export class CustomerCapError extends ApiError {
  readonly resendAppointmentId: string | null;
  constructor(message: string, resendAppointmentId: string | null) {
    super(409, "customer_cap_reached", message);
    this.name = "CustomerCapError";
    this.resendAppointmentId = resendAppointmentId;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface CustomerCapCheck {
  tenantId: string;
  serviceId: string;
  email: string | null;
  phone: string | null;
  /** A visit being moved does not count against itself. */
  excludeAppointmentId?: string;
  /** The other bookings made in the same combined-link request are one visit, not separate allowances (feature 45). */
  excludeGroupRef?: string;
  /** Staff went past the cap with a reason. */
  override?: boolean;
  now?: Date;
}

interface ServiceCap extends Record<string, unknown> {
  max_active_per_customer: number | null;
  offer_reschedule_when_capped: boolean;
}

export async function assertCustomerCap(transaction: KalendrTransaction, check: CustomerCapCheck): Promise<void> {
  const [service] = await transaction.execute<ServiceCap>(sql`
    select max_active_per_customer, offer_reschedule_when_capped from services
    where tenant_id = ${check.tenantId} and id = ${check.serviceId}
  `);
  if (!service?.max_active_per_customer || check.override) return;
  const email = check.email?.trim().toLowerCase() || null;
  const phone = check.phone?.trim() || null;
  if (!email && !phone) return;

  // Two requests for the same person take the same locks, in the same order.
  const keys = [email ? digest(`email:${email}`) : null, phone ? digest(`phone:${phone.replace(/\D/g, "").slice(-10)}`) : null]
    .flatMap((key) => key ?? []).sort();
  for (const key of keys) {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`customer-cap:${check.tenantId}:${check.serviceId}:${key}`}, 0))`);
  }

  const now = (check.now ?? new Date()).toISOString();
  const held = await transaction.execute<{ id: string }>(sql`
    select appointment.id
    from appointments as appointment
    join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
    where appointment.tenant_id = ${check.tenantId}
      and appointment.service_id = ${check.serviceId}
      and appointment.starts_at > ${now}::timestamptz
      and appointment.status in ('requested', 'booked', 'checked_in', 'reschedule_requested', 'pending_payment')
      and (${check.excludeAppointmentId ?? null}::text is null or appointment.id <> ${check.excludeAppointmentId ?? null})
      and (${check.excludeGroupRef ?? null}::text is null or appointment.group_ref is distinct from ${check.excludeGroupRef ?? null})
      and (
        (${email}::text is not null and lower(patient.email) = ${email})
        or (${phone}::text is not null and kalendr_normalize_phone(patient.phone) = kalendr_normalize_phone(${phone}))
      )
    order by appointment.starts_at
  `);
  if (held.length < service.max_active_per_customer) return;

  const many = service.max_active_per_customer === 1 ? "an upcoming booking" : `${service.max_active_per_customer} upcoming bookings`;
  throw new CustomerCapError(
    service.offer_reschedule_when_capped
      ? `You already have ${many} for this. We have sent a link to the contact details you booked with, so you can move one of them instead.`
      : `You already have ${many} for this. To book again, please change or cancel one of them first.`,
    service.offer_reschedule_when_capped ? held[0]?.id ?? null : null,
  );
}
