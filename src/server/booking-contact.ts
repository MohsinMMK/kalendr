import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents, patients } from "@/db/schema";
import { normalizeContact, normalizePhone } from "@/lib/patient-contact";

import { ApiError } from "./api-error";
import { resolveManageToken } from "./appointment-repository";
import type { BookingContactChange } from "./contracts";
import { queuePatientDelivery } from "./patient-delivery";

/**
 * Changes the phone or email on a booking's customer, from the manage link (after the step-up code). Then tells the
 * customer on the contact that did NOT change, or on both old contacts when both changed. The notice names the business
 * and says details changed; it never carries the new contact. Audit metadata names the fields, not the values.
 */
export async function changeBookingContact(token: string, input: BookingContactChange): Promise<{ updated: boolean }> {
  const resolved = await resolveManageToken(token);
  if (!resolved) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
  const newPhone = input.phone === undefined ? undefined : normalizeContact("phone", input.phone);
  const newEmail = input.email === undefined ? undefined : normalizeContact("email", input.email);
  if (input.phone !== undefined && !newPhone) throw new ApiError(400, "validation_error", "Enter a valid phone number.", { phone: ["Enter a valid phone number."] });
  if (input.email !== undefined && !newEmail) throw new ApiError(400, "validation_error", "Enter a valid email address.", { email: ["Enter a valid email address."] });

  const result = await withTenant(resolved.tenant_id, async (transaction) => {
    const rows = await transaction.execute<{ patient_id: string; phone: string; email: string; business: string }>(sql`
      select appointment.patient_id, patient.phone, patient.email, tenant.name as business
      from appointments as appointment
      join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
      join tenants as tenant on tenant.id = appointment.tenant_id
      where appointment.tenant_id = ${resolved.tenant_id} and appointment.id = ${resolved.appointment_id}
      for update of patient
    `);
    const current = rows[0];
    if (!current) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
    const phoneChanged = newPhone !== undefined && newPhone !== null && normalizePhone(current.phone) !== newPhone;
    const emailChanged = newEmail !== undefined && newEmail !== null && current.email.trim().toLowerCase() !== newEmail;
    if (!phoneChanged && !emailChanged) return null;
    await transaction.update(patients)
      .set({
        ...(phoneChanged ? { phone: `+${newPhone}` } : {}),
        ...(emailChanged ? { email: newEmail! } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(patients.tenantId, resolved.tenant_id), eq(patients.id, current.patient_id)));
    await transaction.insert(auditEvents).values({
      tenantId: resolved.tenant_id,
      appointmentId: resolved.appointment_id,
      actorType: "patient",
      action: "patient.contact_changed",
      outcome: "success",
      metadata: { fields: [...(phoneChanged ? ["phone"] : []), ...(emailChanged ? ["email"] : [])] },
    });
    return { current, phoneChanged, emailChanged };
  });
  if (!result) return { updated: false };

  const oldPhone = normalizePhone(result.current.phone);
  const oldEmail = result.current.email.trim().toLowerCase();
  const phoneUsable = oldPhone.length >= 11 && oldPhone.length <= 15;
  const emailUsable = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(oldEmail);
  // The other channel: the one the customer did not just change. If both changed, both old contacts hear about it.
  const phoneHears = phoneUsable && (!result.phoneChanged || result.emailChanged);
  const emailHears = emailUsable && (!result.emailChanged || result.phoneChanged);
  if (phoneHears || emailHears) {
    await queuePatientDelivery({
      purpose: "contact_changed",
      payload: { ...(phoneHears ? { phone: oldPhone } : {}), ...(emailHears ? { email: oldEmail } : {}), business: result.current.business },
      lifetimeMs: 24 * 60 * 60 * 1_000,
    });
  }
  return { updated: true };
}
