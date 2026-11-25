import "server-only";

import { sql } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import { contactModes, contactProblem, needsEmailCheck, type IntakeSettings } from "@/lib/booking-intake";

import { ApiError } from "./api-error";
import { consumeEmailProof } from "./email-check";
import { sealPrivate } from "./messaging/sealed-link";

/**
 * What a service asks of the customer before the booking is taken (feature 40): which contact details, whether guests
 * may come along, and whether the email must be confirmed first. Runs inside the booking transaction.
 */

async function intakeOf(transaction: KalendrTransaction, tenantId: string, serviceId: string): Promise<IntakeSettings> {
  const [row] = await transaction.execute<{ contact_mode: string; allow_guests: boolean; max_guests: number; verify_email: boolean }>(sql`
    select contact_mode, allow_guests, max_guests, verify_email from services where tenant_id = ${tenantId} and id = ${serviceId}
  `);
  return {
    contactMode: contactModes.find((mode) => mode === row?.contact_mode) ?? "email_or_phone",
    allowGuests: row?.allow_guests ?? false,
    maxGuests: row?.max_guests ?? 3,
    verifyEmail: row?.verify_email ?? false,
  };
}

export interface PreparedIntake {
  /** The guest addresses to seal on the booking, lower-cased and without repeats. Empty when there are none. */
  guests: string[];
}

export async function prepareBookingIntake(
  transaction: KalendrTransaction,
  tenantId: string,
  serviceId: string,
  input: { email?: string | null; phone?: string | null; guests?: string[]; emailProof?: string },
  options: { signedIn?: boolean; skipEmailCheck?: boolean } = {},
): Promise<PreparedIntake> {
  const intake = await intakeOf(transaction, tenantId, serviceId);
  const problem = contactProblem(intake.contactMode, input);
  if (problem) throw new ApiError(422, "validation_error", problem.message, { [problem.field]: [problem.message] });

  const customer = input.email?.trim().toLowerCase() ?? "";
  const guests = [...new Set((input.guests ?? []).map((guest) => guest.trim().toLowerCase()).filter((guest) => guest && guest !== customer))];
  if (guests.length > 0) {
    if (!intake.allowGuests) throw new ApiError(422, "validation_error", "This booking does not take guests.", { guests: ["This booking does not take guests."] });
    if (guests.length > intake.maxGuests) {
      const message = `You can add up to ${intake.maxGuests} ${intake.maxGuests === 1 ? "guest" : "guests"}.`;
      throw new ApiError(422, "validation_error", message, { guests: [message] });
    }
  }
  // A customer already signed in to the portal has proved their email, and staff booking on their behalf do not need a code.
  if (!options.skipEmailCheck && !options.signedIn && needsEmailCheck(intake, input.email)) {
    await consumeEmailProof(transaction, tenantId, input.email ?? "", input.emailProof);
  }
  return { guests };
}

/** The sealed guest list for the appointment row, or null when there are no guests. */
export function sealGuests(tenantId: string, appointmentId: string, guests: string[]): string | null {
  return guests.length === 0 ? null : sealPrivate("guests", tenantId, appointmentId, JSON.stringify(guests));
}
