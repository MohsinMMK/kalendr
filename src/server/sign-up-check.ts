import "server-only";

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";

import { getDatabase } from "@/db/client";
import { authUsers, authVerifications } from "@/db/schema";

import { ApiError } from "./api-error";
import { emailIsConfigured, sendAccountEmail } from "./auth-email";
import { sha256 } from "./crypto";
import { env } from "./env";

/**
 * Proof that a new owner controls their email, before their business exists (/start).
 *
 * The owner types an email, we send a 6-digit code, they type it back. Google or Microsoft can stand in for the code
 * when the provider says the email is verified. Either way the result is the same short-lived signed proof, kept in
 * an httpOnly cookie, and `registerClinic` needs it. No user and no session is made here: the account, the business
 * and the owner's membership are still created together in one transaction, so "no membership, no session" holds.
 *
 * Codes live in `auth_verifications` (it has no tenant, unlike the booking email check), keyed by the hashed email.
 * The code is kept as a keyed hash, lives 10 minutes and allows 5 tries.
 */

export const SIGN_UP_PROOF_COOKIE = "kalendr_sign_up";
export const SIGN_UP_PROOF_MINUTES = 60;
const CODE_MINUTES = 10;
const CODE_ATTEMPTS = 5;

export type SignUpMethod = "email" | "google" | "microsoft";
export interface SignUpProof {
  email: string;
  method: SignUpMethod;
  /** The name the provider gave, used to fill "Your name". */
  name?: string;
  expiresAt: number;
}

const normalise = (email: string): string => email.trim().toLowerCase();
const identifierFor = (email: string): string => `sign-up-code:${sha256(`sign-up:${normalise(email)}`)}`;

function secret(): string {
  const value = env().BETTER_AUTH_SECRET;
  if (!value) throw new ApiError(503, "sign_up_unavailable", "Sign-up is not available right now. Please try again shortly.");
  return value;
}

const keyed = (purpose: string, value: string): string => createHmac("sha256", secret()).update(`${purpose}:${value}`).digest("base64url");

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function database() {
  const db = getDatabase();
  if (!db) throw new ApiError(503, "database_unavailable", "Sign-up is not available right now. Please try again shortly.");
  return db;
}

/** An address that already has an account signs in instead; registration would refuse it anyway. */
async function assertNoAccount(email: string): Promise<void> {
  const [existing] = await database().select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, normalise(email))).limit(1);
  if (existing) {
    throw new ApiError(409, "email_taken", "This email already has an account. Sign in instead.", { email: ["This email already has an account."] });
  }
}

/** Sends a new code, replacing any earlier one for this address. */
export async function sendSignUpCode(email: string): Promise<{ sent: true; expiresInMinutes: number }> {
  await assertNoAccount(email);
  const identifier = identifierFor(email);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const db = database();
  await db.delete(authVerifications).where(eq(authVerifications.identifier, identifier));
  const [row] = await db
    .insert(authVerifications)
    .values({
      identifier,
      value: JSON.stringify({ code: keyed(identifier, code), attempts: 0 }),
      expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
    })
    .returning({ id: authVerifications.id });
  if (emailIsConfigured()) {
    await sendAccountEmail(normalise(email), "sign_in_code", { code, purpose: "sign_up" }, `sign-up:${row?.id ?? identifier}`);
  } else if (process.env.NODE_ENV !== "production") {
    // Local development has no email provider: the code is printed where the developer can see it.
    console.info(`[kalendr] Email delivery is not configured. Sign-up code: ${code}`);
  } else {
    throw new ApiError(503, "email_unavailable", "We can't send email right now. Please try again shortly.");
  }
  return { sent: true, expiresInMinutes: CODE_MINUTES };
}

/** Checks a code. A wrong guess is counted; the fifth wrong guess uses the code up. */
export async function verifySignUpCode(email: string, code: string): Promise<SignUpProof> {
  const identifier = identifierFor(email);
  const db = database();
  const [row] = await db
    .select()
    .from(authVerifications)
    .where(and(eq(authVerifications.identifier, identifier), gt(authVerifications.expiresAt, new Date())))
    .limit(1);
  const wrong = new ApiError(400, "invalid_code", "That code isn't right or has expired. Check it, or send a new one.", { code: ["That code isn't right."] });
  if (!row) throw wrong;
  const stored = JSON.parse(row.value) as { code: string; attempts: number };
  if (stored.attempts >= CODE_ATTEMPTS) {
    throw new ApiError(429, "too_many_attempts", "Too many wrong codes. Send a new code and try again.");
  }
  if (!sameText(stored.code, keyed(identifier, code))) {
    await db.update(authVerifications).set({ value: JSON.stringify({ ...stored, attempts: stored.attempts + 1 }) }).where(eq(authVerifications.id, row.id));
    throw wrong;
  }
  await db.delete(authVerifications).where(eq(authVerifications.identifier, identifier));
  return { email: normalise(email), method: "email", expiresAt: Date.now() + SIGN_UP_PROOF_MINUTES * 60_000 };
}

/** A proof for an email a provider has verified (Google or Microsoft sign-up). */
export async function providerProof(input: { email: string; name?: string; method: Exclude<SignUpMethod, "email"> }): Promise<SignUpProof> {
  await assertNoAccount(input.email);
  return {
    email: normalise(input.email),
    method: input.method,
    ...(input.name ? { name: input.name.slice(0, 160) } : {}),
    expiresAt: Date.now() + SIGN_UP_PROOF_MINUTES * 60_000,
  };
}

export function sealSignUpProof(proof: SignUpProof): string {
  const body = Buffer.from(JSON.stringify(proof)).toString("base64url");
  return `${body}.${keyed("sign-up-proof", body)}`;
}

export function openSignUpProof(value: string | undefined | null): SignUpProof | null {
  if (!value) return null;
  const [body, mac] = value.split(".");
  if (!body || !mac) return null;
  try {
    if (!sameText(mac, keyed("sign-up-proof", body))) return null;
    const proof = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SignUpProof;
    if (typeof proof.email !== "string" || typeof proof.expiresAt !== "number" || proof.expiresAt < Date.now()) return null;
    if (proof.method !== "email" && proof.method !== "google" && proof.method !== "microsoft") return null;
    return proof;
  } catch {
    return null;
  }
}

export function proofCookie(proof: SignUpProof) {
  return {
    name: SIGN_UP_PROOF_COOKIE,
    value: sealSignUpProof(proof),
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env().NODE_ENV === "production",
    path: "/",
    maxAge: SIGN_UP_PROOF_MINUTES * 60,
  };
}

/** The Set-Cookie header value that stores a proof. */
export function proofSetCookie(proof: SignUpProof): string {
  const cookie = proofCookie(proof);
  return [`${cookie.name}=${encodeURIComponent(cookie.value)}`, `Path=${cookie.path}`, `Max-Age=${cookie.maxAge}`, "HttpOnly", "SameSite=Lax", ...(cookie.secure ? ["Secure"] : [])].join("; ");
}

export const clearProofCookie = `${SIGN_UP_PROOF_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;

/** Reads the proof from a request's cookies. */
export function proofFromRequest(request: Request): SignUpProof | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SIGN_UP_PROOF_COOKIE) return openSignUpProof(decodeURIComponent(rest.join("=")));
  }
  return null;
}
