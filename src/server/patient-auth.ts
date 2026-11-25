import "server-only";

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";

import { getDatabase, type KalendrDatabase } from "@/db/client";
import { patientAccounts, patientLoginCodes, patientSessions } from "@/db/schema";
import { deviceLabel } from "@/lib/device-label";
import { normalizeContact, type PatientContactKind } from "@/lib/patient-contact";

import { ApiError } from "./api-error";
import { createOpaqueToken, sha256 } from "./crypto";
import { env } from "./env";
import { queuePatientDelivery } from "./patient-delivery";
import { isPreviewMode } from "./preview-repository";
import { patientSessionLifetimeMs, wrongCodeDelaySeconds } from "@/lib/patient-sign-in-rules";

const codeLifetimeMs = 10 * 60 * 1_000;
const maxAttemptsPerCode = 5;
const maxCodesPerHour = 5;

export const patientSessionCookie = process.env.NODE_ENV === "production" ? "__Host-kalendr_patient" : "kalendr_patient";

export interface PatientAccount {
  id: string;
  contactKind: PatientContactKind;
  contactValue: string;
}

function database(): KalendrDatabase {
  if (isPreviewMode()) throw new ApiError(409, "preview_only", "The preview keeps accounts in this browser tab.");
  const connection = getDatabase();
  if (!connection) throw new ApiError(503, "database_unavailable", "Sign-in is unavailable.");
  return connection;
}

function contactHash(kind: PatientContactKind, contact: string): string {
  return sha256(`${kind}:${contact}`);
}

/** Six digits are easy to brute-force offline, so the stored hash needs a secret the database doesn't hold. */
function codeHash(hash: string, code: string): string {
  const secret = env().BETTER_AUTH_SECRET;
  if (!secret) throw new ApiError(503, "auth_unavailable", "Sign-in is unavailable.");
  return createHmac("sha256", secret).update(`${hash}:${code}`).digest("hex");
}

function requireContact(kind: PatientContactKind, raw: string): string {
  const contact = normalizeContact(kind, raw);
  if (!contact) {
    throw new ApiError(400, "validation_error", kind === "email" ? "Enter a valid email address." : "Enter a valid phone number.");
  }
  return contact;
}

/** Creates a code and returns it. Only the delivery step and tests may see the plain code. */
export async function issueLoginCode(kind: PatientContactKind, rawContact: string): Promise<string> {
  const connection = database();
  const hash = contactHash(kind, requireContact(kind, rawContact));
  const hourAgo = new Date(Date.now() - 60 * 60 * 1_000);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  // Counted in the database, so the limit holds across every web server.
  await connection.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${hash}, 0))`);
    const [recent] = await transaction
      .select({ count: sql<number>`count(*)::int` })
      .from(patientLoginCodes)
      .where(and(eq(patientLoginCodes.contactHash, hash), gt(patientLoginCodes.createdAt, hourAgo)));
    if ((recent?.count ?? 0) >= maxCodesPerHour) {
      throw new ApiError(429, "too_many_codes", "Too many codes requested. Try again in an hour.");
    }
    await transaction.delete(patientLoginCodes).where(and(eq(patientLoginCodes.contactHash, hash), lt(patientLoginCodes.createdAt, hourAgo)));
    await transaction.insert(patientLoginCodes).values({
      contactHash: hash,
      codeHash: codeHash(hash, code),
      expiresAt: new Date(Date.now() + codeLifetimeMs),
    });
  });
  return code;
}

/**
 * Asks for a sign-in code. The code is sealed and handed to the worker, which sends it by WhatsApp, then text message,
 * then email (a phone number is never emailed: only the contact given is used). The answer is the same whether or not
 * anyone has an account.
 */
export async function requestLoginCode(kind: PatientContactKind, rawContact: string, options: { via?: "text" } = {}): Promise<void> {
  const contact = requireContact(kind, rawContact);
  const code = await issueLoginCode(kind, rawContact);
  await queuePatientDelivery({
    purpose: "sign_in",
    payload: kind === "phone" ? { phone: contact, code } : { email: contact, code },
    via: options.via === "text" ? "text" : "auto",
    lifetimeMs: codeLifetimeMs,
  });
}

export interface PatientSessionGrant {
  token: string;
  expiresAt: Date;
}

export interface VerifyOptions {
  /** "Remember this device for 30 days". */
  remember?: boolean;
  /** The browser's user agent, reduced to a label like "Chrome on macOS" for the devices list. */
  userAgent?: string | null;
}

/**
 * Accounts are only created here, after the code is proved, so asking for a code never reveals whether someone is a
 * patient anywhere. Every failure gives the same answer.
 */
export async function verifyLoginCode(kind: PatientContactKind, rawContact: string, code: string, options: VerifyOptions = {}): Promise<PatientSessionGrant> {
  const connection = database();
  const contact = requireContact(kind, rawContact);
  const hash = contactHash(kind, contact);
  const grant = await connection.transaction(async (transaction) => {
    const [latest] = await transaction
      .select()
      .from(patientLoginCodes)
      .where(and(eq(patientLoginCodes.contactHash, hash), isNull(patientLoginCodes.consumedAt), gt(patientLoginCodes.expiresAt, new Date())))
      .orderBy(desc(patientLoginCodes.createdAt))
      .limit(1)
      .for("update");
    if (!latest || latest.attemptCount >= maxAttemptsPerCode) return null;
    // After a wrong code the next try waits. A refused try is not checked and not counted.
    if (latest.lockedUntil && latest.lockedUntil.getTime() > Date.now()) {
      return { locked: Math.max(1, Math.ceil((latest.lockedUntil.getTime() - Date.now()) / 1_000)) } as const;
    }
    const matches = timingSafeEqual(Buffer.from(latest.codeHash), Buffer.from(codeHash(hash, code)));
    if (!matches) {
      // Must commit, so this returns rather than throws.
      const wrong = latest.attemptCount + 1;
      await transaction.update(patientLoginCodes)
        .set({ attemptCount: wrong, lockedUntil: new Date(Date.now() + wrongCodeDelaySeconds(wrong) * 1_000) })
        .where(eq(patientLoginCodes.id, latest.id));
      return null;
    }
    await transaction.update(patientLoginCodes).set({ consumedAt: new Date() }).where(eq(patientLoginCodes.id, latest.id));
    const [account] = await transaction
      .insert(patientAccounts)
      .values({ contactKind: kind, contactValue: contact, lastSignInAt: new Date() })
      .onConflictDoUpdate({
        target: [patientAccounts.contactKind, patientAccounts.contactValue],
        set: { lastSignInAt: new Date(), updatedAt: new Date() },
      })
      .returning({ id: patientAccounts.id });
    if (!account) throw new Error("Patient account upsert did not return a row");
    await transaction.delete(patientSessions).where(and(eq(patientSessions.accountId, account.id), lt(patientSessions.expiresAt, new Date())));
    const token = createOpaqueToken();
    const remember = options.remember === true;
    const expiresAt = new Date(Date.now() + patientSessionLifetimeMs(remember));
    await transaction.insert(patientSessions).values({
      accountId: account.id,
      tokenHash: sha256(token),
      expiresAt,
      remember,
      deviceLabel: deviceLabel(options.userAgent),
    });
    return { token, expiresAt };
  });
  if (grant && "locked" in grant) {
    throw new ApiError(429, "code_retry_later", `Wait ${grant.locked} second${grant.locked === 1 ? "" : "s"}, then try the code again.`, undefined, {
      "Retry-After": String(grant.locked),
    });
  }
  if (!grant) throw new ApiError(400, "invalid_code", "That code isn't right or has expired. Check it, or ask for a new one.");
  return grant;
}

export function patientSessionTokenFrom(headers: Headers): string | null {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === patientSessionCookie) return part.slice(separator + 1).trim();
  }
  return null;
}

export async function getPatientAccount(headers: Headers): Promise<PatientAccount | null> {
  const token = patientSessionTokenFrom(headers);
  if (!token) return null;
  const [row] = await database()
    .select({ id: patientAccounts.id, contactKind: patientAccounts.contactKind, contactValue: patientAccounts.contactValue })
    .from(patientSessions)
    .innerJoin(patientAccounts, eq(patientAccounts.id, patientSessions.accountId))
    .where(and(eq(patientSessions.tokenHash, sha256(token)), gt(patientSessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export async function requirePatientAccount(headers: Headers): Promise<PatientAccount> {
  const account = await getPatientAccount(headers);
  if (!account) throw new ApiError(401, "unauthorized", "Please sign in again.");
  return account;
}

/**
 * For actions that expose or remove a customer's data (feature 7): the sign-in code must have been entered within
 * the last `minutes` minutes. A session is created when the code is verified, so its age is the code's age. A customer
 * with an older session signs out and in again to get a fresh code.
 */
export async function requireFreshPatientSession(headers: Headers, minutes: number): Promise<void> {
  const token = patientSessionTokenFrom(headers);
  const [row] = token
    ? await database().select({ createdAt: patientSessions.createdAt }).from(patientSessions)
      .where(and(eq(patientSessions.tokenHash, sha256(token)), gt(patientSessions.expiresAt, new Date()))).limit(1)
    : [];
  if (!row || Date.now() - row.createdAt.getTime() > minutes * 60 * 1_000) {
    throw new ApiError(403, "fresh_code_required", "For your safety, sign in again with a new code before doing this.");
  }
}

export async function endPatientSession(headers: Headers): Promise<void> {
  const token = patientSessionTokenFrom(headers);
  if (token) await database().delete(patientSessions).where(eq(patientSessions.tokenHash, sha256(token)));
}

function cookieAttributes(): string {
  return `Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function sessionCookieHeader(grant: PatientSessionGrant): string {
  return `${patientSessionCookie}=${grant.token}; ${cookieAttributes()}; Expires=${grant.expiresAt.toUTCString()}`;
}

export function clearedSessionCookieHeader(): string {
  return `${patientSessionCookie}=; ${cookieAttributes()}; Max-Age=0`;
}
