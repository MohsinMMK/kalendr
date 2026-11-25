import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { calendarProviderSchema } from "@/lib/calendar-sync";

/**
 * The `state` value of an OAuth sign-in, and the cookie that goes with it. The state is signed with the
 * app's secret and says which business, which staff member and which provider it was made for. The cookie
 * holds a random value that the state also carries, so a state pasted into another browser is refused.
 * The callback accepts it only when the signature, the age, the cookie and the signed-in person all match.
 */

export const OAUTH_STATE_COOKIE = "kalendr_calendar_oauth";
export const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;

const payloadSchema = z.object({
  t: z.string().min(1),
  m: z.string().min(1),
  p: calendarProviderSchema,
  n: z.string().min(16),
  e: z.number().int(),
});

export interface OAuthStateClaims {
  tenantId: string;
  membershipId: string;
  provider: z.infer<typeof calendarProviderSchema>;
}

function sign(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(`calendar-oauth\0${body}`).digest();
}

/** A fresh state and the cookie value (the nonce) to set beside it. */
export function createOAuthState(secret: string, claims: OAuthStateClaims, now: Date = new Date()): { state: string; nonce: string } {
  const nonce = randomBytes(24).toString("base64url");
  const body = Buffer.from(JSON.stringify({
    t: claims.tenantId, m: claims.membershipId, p: claims.provider, n: nonce, e: now.getTime() + OAUTH_STATE_MAX_AGE_SECONDS * 1_000,
  })).toString("base64url");
  return { state: `${body}.${sign(secret, body).toString("base64url")}`, nonce };
}

export type OAuthStateResult = { ok: true; claims: OAuthStateClaims } | { ok: false };

/** Checks a returned state against the cookie and the person now signed in. Constant-time on the secrets. */
export function verifyOAuthState(
  secret: string,
  state: string | null | undefined,
  cookieNonce: string | null | undefined,
  expected: OAuthStateClaims,
  now: Date = new Date(),
): OAuthStateResult {
  if (!state || !cookieNonce) return { ok: false };
  const [body, signature, extra] = state.split(".");
  if (!body || !signature || extra !== undefined) return { ok: false };
  const given = Buffer.from(signature, "base64url");
  const wanted = sign(secret, body);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return { ok: false };
  let parsed: z.infer<typeof payloadSchema>;
  try {
    const result = payloadSchema.safeParse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    if (!result.success) return { ok: false };
    parsed = result.data;
  } catch {
    return { ok: false };
  }
  if (parsed.e < now.getTime()) return { ok: false };
  const nonceA = Buffer.from(parsed.n);
  const nonceB = Buffer.from(cookieNonce);
  if (nonceA.length !== nonceB.length || !timingSafeEqual(nonceA, nonceB)) return { ok: false };
  if (parsed.t !== expected.tenantId || parsed.m !== expected.membershipId || parsed.p !== expected.provider) return { ok: false };
  return { ok: true, claims: { tenantId: parsed.t, membershipId: parsed.m, provider: parsed.p } };
}
