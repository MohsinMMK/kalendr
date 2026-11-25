import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { env, isLoopbackAddress, publicAppUrl } from "./env";

/**
 * A stand-in for Google and Microsoft so staff sign-in can be tried, and tested end to end,
 * with no OAuth app. It speaks just enough OAuth for Better Auth to treat it as the real
 * provider: an authorize page where you type the email you want to appear as, a token
 * endpoint and a userinfo endpoint. Everything else (the invite rule, account linking, the
 * second factor) is the same code the real providers run through.
 *
 * It is on only when KALENDR_DEV_OAUTH=true and the app's own address is on this machine
 * (localhost, 127.0.0.1). A production build on a public address refuses to start with it on,
 * and the browser tests run a production build on localhost, which is the one allowed case.
 */
export function devOAuthEnabled(): boolean {
  const settings = env();
  return settings.KALENDR_DEV_OAUTH === "true" && isLoopbackAddress(settings.BETTER_AUTH_URL ?? publicAppUrl());
}

const grantSchema = z.object({
  email: z.string(),
  name: z.string(),
  verified: z.boolean(),
  exp: z.number(),
});
export type DevGrant = z.infer<typeof grantSchema>;

function signingKey(): string {
  return env().BETTER_AUTH_SECRET ?? "kalendr-dev-oauth";
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(`dev-oauth:${payload}`).digest("base64url");
}

/** One value that serves as both the authorization code and the access token. Lives 10 minutes. */
export function issueDevGrant(input: { email: string; name: string; verified: boolean }, now: number = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ ...input, exp: now + 10 * 60_000 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readDevGrant(value: string, now: number = Date.now()): DevGrant | null {
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const grant = grantSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return grant.exp > now ? grant : null;
  } catch {
    return null;
  }
}
