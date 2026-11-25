import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signing for outgoing webhooks (feature 34). No server-only import on purpose: the docs page, the sample code and
 * the tests use the same two functions a receiver would copy.
 *
 * Header: `X-Kalendr-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>`. The HMAC is keyed with the endpoint secret
 * and covers `<t>.<raw body>`, so a captured request can not be replayed later (the receiver checks `t`) and a body
 * can not be changed (the receiver checks the HMAC over the bytes it got).
 */

export const SIGNATURE_HEADER = "X-Kalendr-Signature";
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** The purpose a webhook secret is sealed for, so it can not be opened as any other secret. */
export const WEBHOOK_SECRET_PURPOSE = "webhook.endpoint";

const SECRET_PATTERN = /^whsec_[A-Za-z0-9_-]{43}$/;

/** A new signing secret: `whsec_` and 256 random bits as 43 base64url characters. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export function isWebhookSecret(value: string): boolean {
  return SECRET_PATTERN.test(value);
}

/** The hex HMAC for one delivery. `timestampSeconds` is whole seconds since 1970. */
export function sign(secret: string, timestampSeconds: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`, "utf8").digest("hex");
}

/** The full header value to send. */
export function signatureHeader(secret: string, timestampSeconds: number, rawBody: string): string {
  return `t=${timestampSeconds},v1=${sign(secret, timestampSeconds, rawBody)}`;
}

export type SignatureFailure = "malformed" | "stale" | "mismatch";
export type SignatureResult = { valid: true } | { valid: false; reason: SignatureFailure };

export interface VerifyOptions {
  /** The receiver's clock. Defaults to now; tests pass a fixed one. */
  now?: Date;
  toleranceSeconds?: number;
}

const HEADER_PATTERN = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/;

/**
 * Checks a received header against the raw body bytes. Rejects a header that does not have exactly the expected
 * shape, a timestamp more than `toleranceSeconds` away from now in either direction (old or from the future), and a
 * signature that does not match. The comparison takes the same time whatever the input.
 */
export function verifyWebhookSignature(secret: string, header: string, rawBody: string, options: VerifyOptions = {}): SignatureResult {
  const match = HEADER_PATTERN.exec(header.trim());
  if (!match) return { valid: false, reason: "malformed" };
  const timestamp = Number(match[1]);
  const tolerance = options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - timestamp) > tolerance) return { valid: false, reason: "stale" };
  const expected = Buffer.from(sign(secret, timestamp, rawBody), "hex");
  const given = Buffer.from(match[2]!, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { valid: false, reason: "mismatch" };
  return { valid: true };
}
