import "server-only";

import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";

import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";
import { bookingStepUps } from "@/db/schema";
import { maskContact, normalizePhone } from "@/lib/patient-contact";
import {
  stepUpCodeLifetimeMs,
  stepUpGrantLifetimeMs,
  stepUpMaxAttempts,
  stepUpSatisfied,
  wrongCodeDelaySeconds,
  type StepUpAction,
} from "@/lib/patient-sign-in-rules";

import { ApiError } from "./api-error";
import { resolveManageToken } from "./appointment-repository";
import { createOpaqueToken, sha256 } from "./crypto";
import { env } from "./env";
import { getPatientAccount } from "./patient-auth";
import { queuePatientDelivery } from "./patient-delivery";
import { isPreviewMode } from "./preview-repository";

/**
 * Step-up for a manage link (feature 8). Looking at a booking with the link is allowed. Cancelling, moving it or changing
 * its contact details needs a one-time code sent to the contact on the booking, so someone a link was forwarded to cannot
 * do it. A customer signed in to the portal on this device, for this booking's customer, skips the code unless money has
 * been taken for the booking: a paid booking always asks, and its code works once.
 */

export const stepUpCookie = process.env.NODE_ENV === "production" ? "__Host-kalendr_step_up" : "kalendr_step_up";

export interface StepUpContext {
  tenantId: string;
  appointmentId: string;
  paid: boolean;
  /** The grant that allowed this change, so a paid booking's code can be used up afterwards. */
  grantId: string | null;
}

/** True when the link is a real one that has passed its 30 days. The page then says "Sign in to see this booking". */
export async function manageLinkExpired(token: string): Promise<boolean> {
  if (isPreviewMode()) return false;
  const database = getDatabase();
  if (!database) return false;
  const rows = await database.execute<{ expired: boolean }>(sql`select kalendr_manage_token_expired(${sha256(token)}) as expired`);
  return rows[0]?.expired === true;
}

/** For the manage routes: an expired link gets its own clear error, not a plain "not found". */
export async function requireLiveManageLink(token: string): Promise<void> {
  if (await manageLinkExpired(token)) {
    throw new ApiError(410, "manage_link_expired", "This link has expired. Sign in to see this booking.");
  }
}

function hmac(rowId: string, code: string): string {
  const secret = env().BETTER_AUTH_SECRET;
  if (!secret) throw new ApiError(503, "auth_unavailable", "Codes are unavailable.");
  return createHmac("sha256", secret).update(`step-up:${rowId}:${code}`).digest("hex");
}

function cookieAttributes(maxAgeSeconds: number): string {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function stepUpCookieHeader(grantToken: string): string {
  return `${stepUpCookie}=${grantToken}; ${cookieAttributes(Math.floor(stepUpGrantLifetimeMs / 1_000))}`;
}

function cookieValue(headers: Headers, name: string): string | null {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

interface BookingFacts {
  tenantId: string;
  appointmentId: string;
  patientId: string;
  phone: string;
  email: string;
  business: string;
  paid: boolean;
}

async function loadBookingFacts(token: string): Promise<BookingFacts> {
  const resolved = await resolveManageToken(token);
  if (!resolved) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
  return withTenant(resolved.tenant_id, async (transaction) => {
    const rows = await transaction.execute<{ patient_id: string; phone: string; email: string; business: string; paid: boolean }>(sql`
      select appointment.patient_id, patient.phone, patient.email, tenant.name as business,
        exists (
          select 1 from payments as payment
          where payment.tenant_id = appointment.tenant_id and payment.appointment_id = appointment.id
        ) as paid
      from appointments as appointment
      join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
      join tenants as tenant on tenant.id = appointment.tenant_id
      where appointment.tenant_id = ${resolved.tenant_id} and appointment.id = ${resolved.appointment_id}
    `);
    const row = rows[0];
    if (!row) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
    return {
      tenantId: resolved.tenant_id,
      appointmentId: resolved.appointment_id,
      patientId: row.patient_id,
      phone: row.phone,
      email: row.email,
      business: row.business,
      paid: row.paid,
    };
  });
}

/** Sends a one-time code to the contact on the booking. Returns a masked hint of where it went. */
export async function requestStepUp(token: string, action: StepUpAction): Promise<{ hint: string }> {
  if (isPreviewMode()) throw new ApiError(409, "preview_only", "The preview does not send codes.");
  const facts = await loadBookingFacts(token);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const phone = normalizePhone(facts.phone);
  const hasPhone = phone.length >= 11 && phone.length <= 15;
  const email = facts.email.trim().toLowerCase();
  const hasEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!hasPhone && !hasEmail) throw new ApiError(409, "no_contact", "There is no contact on this booking to send a code to. Please call the business.");
  const id = randomUUID();
  await withTenant(facts.tenantId, (transaction) => transaction.insert(bookingStepUps).values({
    id,
    tenantId: facts.tenantId,
    appointmentId: facts.appointmentId,
    action,
    codeHash: hmac(id, code),
    expiresAt: new Date(Date.now() + stepUpCodeLifetimeMs),
  }));
  await queuePatientDelivery({
    purpose: "step_up",
    payload: { ...(hasPhone ? { phone } : {}), ...(hasEmail ? { email } : {}), code },
    lifetimeMs: stepUpCodeLifetimeMs,
  });
  return { hint: hasPhone ? maskContact("phone", phone) : maskContact("email", email) };
}

type VerifyOutcome = { grant: string } | { locked: number } | null;

/** Checks the code. A right one returns a grant for this device; a wrong one makes the next try wait a little longer. */
export async function verifyStepUp(token: string, code: string): Promise<{ grant: string }> {
  if (isPreviewMode()) throw new ApiError(409, "preview_only", "The preview does not send codes.");
  const resolved = await resolveManageToken(token);
  if (!resolved) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
  const outcome: VerifyOutcome = await withTenant(resolved.tenant_id, async (transaction) => {
    const [latest] = await transaction.select().from(bookingStepUps)
      .where(and(
        eq(bookingStepUps.tenantId, resolved.tenant_id),
        eq(bookingStepUps.appointmentId, resolved.appointment_id),
        isNull(bookingStepUps.verifiedAt),
        gt(bookingStepUps.expiresAt, new Date()),
      ))
      .orderBy(desc(bookingStepUps.createdAt))
      .limit(1)
      .for("update");
    if (!latest || latest.attemptCount >= stepUpMaxAttempts) return null;
    if (latest.lockedUntil && latest.lockedUntil.getTime() > Date.now()) {
      return { locked: Math.max(1, Math.ceil((latest.lockedUntil.getTime() - Date.now()) / 1_000)) };
    }
    const expected = Buffer.from(latest.codeHash);
    const given = Buffer.from(hmac(latest.id, code));
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      const wrong = latest.attemptCount + 1;
      await transaction.update(bookingStepUps)
        .set({ attemptCount: wrong, lockedUntil: new Date(Date.now() + wrongCodeDelaySeconds(wrong) * 1_000) })
        .where(and(eq(bookingStepUps.tenantId, resolved.tenant_id), eq(bookingStepUps.id, latest.id)));
      return null;
    }
    const grant = createOpaqueToken();
    await transaction.update(bookingStepUps)
      .set({ verifiedAt: new Date(), grantHash: sha256(grant), grantExpiresAt: new Date(Date.now() + stepUpGrantLifetimeMs) })
      .where(and(eq(bookingStepUps.tenantId, resolved.tenant_id), eq(bookingStepUps.id, latest.id)));
    return { grant };
  });
  if (outcome && "locked" in outcome) {
    throw new ApiError(429, "code_retry_later", `Wait ${outcome.locked} second${outcome.locked === 1 ? "" : "s"}, then try the code again.`, undefined, {
      "Retry-After": String(outcome.locked),
    });
  }
  if (!outcome) throw new ApiError(400, "invalid_code", "That code isn't right or has expired. Check it, or ask for a new one.");
  return outcome;
}

/** True when this device is signed in to the portal as the customer this booking belongs to (not just as any customer). */
async function portalSessionOwnsBooking(headers: Headers, facts: Pick<BookingFacts, "tenantId" | "patientId">): Promise<boolean> {
  const cookies = headers.get("cookie") ?? "";
  if (!/(^|;\s*)(__Host-)?kalendr_patient=/.test(cookies)) return false;
  const account = await getPatientAccount(headers).catch(() => null);
  if (!account) return false;
  const database = getDatabase();
  if (!database) return false;
  const rows = await database.execute<{ found: number }>(sql`
    select 1 as found from kalendr_portal_people(${account.id}) as person
    where person.tenant_id = ${facts.tenantId} and person.patient_id = ${facts.patientId} limit 1
  `);
  return rows.length > 0;
}

/**
 * The guard for the manage routes that change something. Throws 403 step_up_required when a code is needed. In preview
 * there is nothing to protect, so it lets the change through.
 */
export async function requireStepUp(headers: Headers, token: string): Promise<StepUpContext | null> {
  if (isPreviewMode()) return null;
  const facts = await loadBookingFacts(token);
  const grantToken = cookieValue(headers, stepUpCookie);
  let grantId: string | null = null;
  if (grantToken) {
    grantId = await withTenant(facts.tenantId, async (transaction) => {
      const [grant] = await transaction.select({ id: bookingStepUps.id }).from(bookingStepUps).where(and(
        eq(bookingStepUps.tenantId, facts.tenantId),
        eq(bookingStepUps.appointmentId, facts.appointmentId),
        eq(bookingStepUps.grantHash, sha256(grantToken)),
        gt(bookingStepUps.grantExpiresAt, new Date()),
        isNull(bookingStepUps.usedAt),
      )).limit(1);
      return grant?.id ?? null;
    });
  }
  const ok = stepUpSatisfied({
    hasGrant: grantId !== null,
    paid: facts.paid,
    portalSessionForCustomer: !facts.paid && grantId === null ? await portalSessionOwnsBooking(headers, facts) : false,
  });
  if (!ok) {
    throw new ApiError(403, "step_up_required", "To protect this booking, enter the code we send to the phone or email on it.");
  }
  return { tenantId: facts.tenantId, appointmentId: facts.appointmentId, paid: facts.paid, grantId };
}

/** After the change went through: a paid booking's code is used up, so the next change asks again. */
export async function finishStepUp(context: StepUpContext | null): Promise<void> {
  if (!context?.paid || !context.grantId) return;
  await withTenant(context.tenantId, (transaction) => transaction.update(bookingStepUps)
    .set({ usedAt: new Date() })
    .where(and(eq(bookingStepUps.tenantId, context.tenantId), eq(bookingStepUps.id, context.grantId!))));
}
