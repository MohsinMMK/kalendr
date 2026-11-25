/**
 * The short code in an SMS link, such as https://app.example/m/aB3dE5gH7k. It must fit a
 * one-segment message, and a retry of the same message must reuse the same link.
 *
 * The code is an HMAC of the business id, the appointment id and the hash of the booking's current
 * manage token, so it is the same on every retry, can't be guessed without the server key, and
 * changes when the manage token is rotated (a reschedule): a link from an earlier text message then
 * stays dead even after the next message re-creates the row. The table stores only
 * its SHA-256, like manage tokens, so a copy of the table gives no working link.
 *
 * No "server-only" import because the worker builds links too.
 */
import { createHash, createHmac, hkdfSync } from "node:crypto";

import type postgres from "postgres";

import { env, type EnvironmentSource } from "../env";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CODE_LENGTH = 10;
const BASE = BigInt(62);
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function codeKey(source: EnvironmentSource): Buffer {
  const { KALENDR_RECORDS_KEY: encoded } = env(source);
  // Same fallback as the sealed manage link: development without a key, never production.
  const base = encoded
    ? Buffer.from(encoded, "base64")
    : createHash("sha256").update("kalendr-development-only-records-key").digest();
  return Buffer.from(hkdfSync("sha256", base, Buffer.alloc(0), "kalendr short link v1", 32));
}

export function shortLinkCode(tenantId: string, appointmentId: string, manageTokenHash: string, source: EnvironmentSource = process.env): string {
  const digest = createHmac("sha256", codeKey(source)).update(`${tenantId}\u0000${appointmentId}\u0000${manageTokenHash}`).digest();
  // 80 bits mapped onto 62^10 (about 2^59.5); the bias from the remainder is below one in a million.
  let number = BigInt(`0x${digest.subarray(0, 10).toString("hex")}`);
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code = `${ALPHABET[Number(number % BASE)]}${code}`;
    number /= BASE;
  }
  return code;
}

export function hashShortLinkCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export const SHORT_CODE_PATTERN = /^[0-9A-Za-z]{10}$/;

/**
 * Manage tokens have no expiry of their own today, so the link lives while the booking is
 * useful: until 30 days after it ends (long enough to rebook or see the receipt).
 */
export function shortLinkExpiry(appointmentEndsAt: Date): Date {
  return new Date(appointmentEndsAt.getTime() + THIRTY_DAYS_MS);
}

export interface ShortLinkInput {
  tenantId: string;
  appointmentId: string;
  expiresAt: Date;
}

/**
 * Makes sure the booking has a short link and returns its code. One row per booking, so a
 * retry reuses it; after a reschedule rotates the manage token the row gets the new code. The transaction must
 * already be scoped to the business (row-level security).
 */
export async function ensureShortLink(
  tenantDb: postgres.TransactionSql,
  input: ShortLinkInput,
  source: EnvironmentSource = process.env,
): Promise<string> {
  const [appointment] = await tenantDb<{ manage_token_hash: string }[]>`
    select manage_token_hash from appointments where tenant_id = ${input.tenantId} and id = ${input.appointmentId}
  `;
  if (!appointment) throw new Error("No booking for this short link");
  const code = shortLinkCode(input.tenantId, input.appointmentId, appointment.manage_token_hash, source);
  await tenantDb`
    insert into short_links (tenant_id, appointment_id, code_hash, expires_at)
    values (${input.tenantId}, ${input.appointmentId}, ${hashShortLinkCode(code)}, ${input.expiresAt})
    on conflict (tenant_id, appointment_id) do update set
      code_hash = excluded.code_hash,
      expires_at = excluded.expires_at
  `;
  return code;
}

/** `${origin}/m/${code}`, with no trailing slash on the origin. */
export function shortLinkUrl(origin: string, code: string): string {
  return `${origin.replace(/\/$/, "")}/m/${code}`;
}
