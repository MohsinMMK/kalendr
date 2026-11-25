import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { withTenant } from "@/db/client";
import { isRedirectUrl } from "@/lib/after-booking";
import { redirectAddress, signSummary, verifySummary, type SummaryClaims } from "@/lib/after-booking-token";

import { ApiError } from "./api-error";
import { resolveManageToken } from "./appointment-repository";
import { env } from "./env";

export const afterBookingRequestSchema = z.object({ manageToken: z.string().min(8).max(200).regex(/^[A-Za-z0-9_-]+$/) });

interface RedirectRow extends Record<string, unknown> {
  id: string;
  service_id: string;
  starts_at: Date | string;
  after_booking: string;
  redirect_url: string | null;
  pass_details_on_redirect: boolean;
}

/**
 * Where to send a customer who just booked a service set to "go to my own page", or null to stay on Kalendr's confirmation.
 * The booking's own manage link is the proof the caller made this booking. The address holds the booking id, and only when
 * the owner chose "pass details", the service, start time and a signed 15-minute summary. Never a name, email or phone.
 */
export async function afterBookingRedirect(manageToken: string): Promise<{ url: string | null }> {
  const resolved = await resolveManageToken(manageToken);
  if (!resolved) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
  const [row] = await withTenant(resolved.tenant_id, (transaction) => transaction.execute<RedirectRow>(sql`
    select a.id, a.service_id, a.starts_at, s.after_booking, s.redirect_url, s.pass_details_on_redirect
    from appointments a join services s on s.tenant_id = a.tenant_id and s.id = a.service_id
    where a.tenant_id = ${resolved.tenant_id} and a.id = ${resolved.appointment_id}
  `));
  if (!row || row.after_booking !== "redirect" || !row.redirect_url || !isRedirectUrl(row.redirect_url)) return { url: null };
  const startsAt = new Date(row.starts_at).toISOString();
  const secret = env().BETTER_AUTH_SECRET;
  // Without a signing key the details are left out entirely rather than sent unsigned.
  const passDetails = row.pass_details_on_redirect && Boolean(secret);
  const token = passDetails && secret ? signSummary(secret, { bookingId: row.id, serviceId: row.service_id, startsAt }) : null;
  return { url: redirectAddress(row.redirect_url, { bookingId: row.id, serviceId: row.service_id, startsAt, token }, passDetails) };
}

/** Lets a thank-you page confirm a summary token it received is ours and still fresh. */
export function checkSummaryToken(token: string): SummaryClaims {
  const secret = env().BETTER_AUTH_SECRET;
  if (!secret) throw new ApiError(503, "summary_unavailable", "Booking summaries can't be checked right now.");
  const claims = verifySummary(secret, token);
  if (!claims) throw new ApiError(404, "summary_invalid", "This summary is not valid or has expired.");
  return claims;
}
