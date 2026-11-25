import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import type { PaymentAccountView } from "@/lib/payments";

import { ApiError } from "../api-error";
import { env } from "../env";
import { requireFeature } from "../entitlements";
import { requirePermission, requireRecentStepUp, type StaffContext } from "../staff-context";
import { saveAccount, stripeAvailable } from "./accounts";
import { callProvider } from "./http";
import { ProviderError } from "./types";

/**
 * "Connect with Stripe": the business signs in at Stripe and allows this platform to take payments for it. We keep only the
 * connected account's id (no secret): every call is made with the platform key and a `Stripe-Account` header.
 * The `state` is signed and bound to the business, the person and a cookie, like the calendar sign-ins.
 */
export const STRIPE_STATE_COOKIE = "kalendr_stripe_connect";
const STATE_MAX_AGE_MS = 10 * 60_000;

const payloadSchema = z.object({ t: z.string().min(1), u: z.string().min(1), n: z.string().min(16), e: z.number().int() });

function secret(): string {
  const value = env().BETTER_AUTH_SECRET;
  if (!value) throw new ApiError(503, "not_configured", "Stripe can't be connected on this server yet.");
  return value;
}

function sign(body: string): Buffer {
  return createHmac("sha256", secret()).update(`stripe-connect\0${body}`).digest();
}

export function callbackUrl(origin: string): string {
  return `${origin}/api/staff/payment-account/stripe/callback`;
}

export function startStripeConnect(context: StaffContext, origin: string, now: Date = new Date()): { url: string; nonce: string } {
  requirePermission(context, "payments.settings");
  requireFeature(context, "onlinePayments");
  requireRecentStepUp(context);
  const config = env();
  if (!stripeAvailable() || !config.STRIPE_CONNECT_CLIENT_ID || !context.userId) throw new ApiError(409, "provider_unavailable", "Stripe isn't set up on this server.");
  const nonce = randomBytes(24).toString("base64url");
  const body = Buffer.from(JSON.stringify({ t: context.tenantId, u: context.userId, n: nonce, e: now.getTime() + STATE_MAX_AGE_MS })).toString("base64url");
  const state = `${body}.${sign(body).toString("base64url")}`;
  const query = new URLSearchParams({ response_type: "code", client_id: config.STRIPE_CONNECT_CLIENT_ID, scope: "read_write", state, redirect_uri: callbackUrl(origin) });
  return { url: `https://connect.stripe.com/oauth/authorize?${query}`, nonce };
}

/** True only for a state this server signed, for this business and person, still fresh, and matching the browser's cookie. */
export function stateIsValid(state: string | null, cookieNonce: string | null, context: Pick<StaffContext, "tenantId" | "userId">, now: Date = new Date()): boolean {
  if (!state || !cookieNonce) return false;
  const [body, signature] = state.split(".");
  if (!body || !signature) return false;
  const expected = sign(body);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  let parsed;
  try { parsed = payloadSchema.safeParse(JSON.parse(Buffer.from(body, "base64url").toString("utf8"))); } catch { return false; }
  if (!parsed.success) return false;
  const nonce = Buffer.from(parsed.data.n);
  const cookie = Buffer.from(cookieNonce);
  return parsed.data.t === context.tenantId && parsed.data.u === context.userId && parsed.data.e > now.getTime()
    && nonce.length === cookie.length && timingSafeEqual(nonce, cookie);
}

const tokenSchema = z.object({ stripe_user_id: z.string().min(1).max(80), livemode: z.boolean() });

/** Trades the one-time code for the connected account's id and saves it. Stripe is called once, outside any transaction. */
export async function finishStripeConnect(context: StaffContext, input: { code: string; state: string | null; cookieNonce: string | null }, origin: string): Promise<PaymentAccountView> {
  requirePermission(context, "payments.settings");
  requireFeature(context, "onlinePayments");
  requireRecentStepUp(context);
  if (!stateIsValid(input.state, input.cookieNonce, context)) throw new ApiError(400, "invalid_state", "That sign-in has expired. Start connecting Stripe again.");
  const key = env().STRIPE_CONNECT_SECRET_KEY;
  if (!key || !stripeAvailable()) throw new ApiError(409, "provider_unavailable", "Stripe isn't set up on this server.");
  let token;
  try {
    token = await callProvider(fetch, "https://connect.stripe.com/oauth/token", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: input.code }).toString(),
    }, tokenSchema);
  } catch (error: unknown) {
    if (error instanceof ProviderError) throw new ApiError(502, "provider_unavailable", "Stripe didn't accept that. Start connecting again.");
    throw error;
  }
  return saveAccount(context, { provider: "stripe", keyId: token.stripe_user_id, secret: null, webhookSecret: null, mode: token.livemode ? "live" : "test" }, origin);
}
