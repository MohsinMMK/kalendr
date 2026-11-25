import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

/**
 * The signed summary a business's thank-you page can check (feature 52). It says only which booking, which service and when,
 * never who booked, and it stops working after 15 minutes. The business's page (or its server) sends it back to
 * `/api/public/booking-summary` to learn it is genuine.
 */
export const SUMMARY_TOKEN_MINUTES = 15;

const claimsSchema = z.object({
  b: z.string().min(1).max(160),
  s: z.string().min(1).max(160),
  t: z.string().min(10).max(40),
  e: z.number().int(),
});

export interface SummaryClaims {
  bookingId: string;
  serviceId: string;
  startsAt: string;
  expiresAt: string;
}

function signature(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(`booking-summary\0${body}`).digest();
}

export function signSummary(secret: string, claims: { bookingId: string; serviceId: string; startsAt: string }, now: Date = new Date()): string {
  const body = Buffer.from(JSON.stringify({
    b: claims.bookingId, s: claims.serviceId, t: claims.startsAt, e: now.getTime() + SUMMARY_TOKEN_MINUTES * 60_000,
  })).toString("base64url");
  return `${body}.${signature(secret, body).toString("base64url")}`;
}

export function verifySummary(secret: string, token: string, now: Date = new Date()): SummaryClaims | null {
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return null;
  const expected = signature(secret, body);
  let given: Buffer;
  try {
    given = Buffer.from(mac, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed: z.infer<typeof claimsSchema>;
  try {
    parsed = claimsSchema.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
  } catch {
    return null;
  }
  if (parsed.e < now.getTime()) return null;
  return { bookingId: parsed.b, serviceId: parsed.s, startsAt: parsed.t, expiresAt: new Date(parsed.e).toISOString() };
}

/** The thank-you address: the booking id always; with `passDetails`, also the service, start time and signed summary. */
export function redirectAddress(base: string, input: { bookingId: string; serviceId: string; startsAt: string; token: string | null }, passDetails: boolean): string {
  const url = new URL(base);
  url.searchParams.set("kalendr_booking", input.bookingId);
  if (passDetails && input.token) {
    url.searchParams.set("kalendr_service", input.serviceId);
    url.searchParams.set("kalendr_start", input.startsAt);
    url.searchParams.set("kalendr_token", input.token);
  }
  return url.toString();
}
