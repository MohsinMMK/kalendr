import "server-only";

import { randomBytes } from "node:crypto";

import { hashPassword } from "better-auth/crypto";
import { and, eq, ne } from "drizzle-orm";

import type { KalendrDatabase, KalendrTransaction } from "@/db/client";
import { authAccounts, authUsers } from "@/db/schema";

import { ApiError, getPostgresConstraint, getPostgresErrorCode } from "./api-error";

/** The one message for "this sign-in email already belongs to someone", whichever way it was found. */
export function emailTakenError(): ApiError {
  return new ApiError(
    409,
    "email_taken",
    "This email already has an account. Sign in, or use a different email.",
    { email: ["This email already has an account."] },
  );
}

/**
 * The single place that decides whether a sign-in email is free: any existing account counts, because one email is one login.
 * Registration and email change ask here. The invite paths first ask `findLoginToInvite` (staff-login-invites.ts), which invites an
 * existing staff login to a second business instead of refusing it. `exceptUserId` lets a person keep their own address.
 * The unique index on `auth_users.email` is the real guard against two requests at once: see `rethrowIfEmailTaken`.
 */
export async function assertEmailAvailable(
  executor: Pick<KalendrTransaction | KalendrDatabase, "select">,
  rawEmail: string,
  exceptUserId?: string,
): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  const [existing] = await executor
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(exceptUserId ? and(eq(authUsers.email, email), ne(authUsers.id, exceptUserId)) : eq(authUsers.email, email))
    .limit(1);
  if (existing) throw emailTakenError();
}

/** Turns the database's "that email is already used" (a race the check above can't see) into the same clear answer. */
export function rethrowIfEmailTaken(error: unknown): never {
  if (getPostgresErrorCode(error) === "23505" && getPostgresConstraint(error) === "auth_users_email_uq") throw emailTakenError();
  throw error;
}

export function generateStaffPassword(): string {
  return randomBytes(18).toString("base64url");
}

export async function insertCredentialUser(
  transaction: KalendrTransaction,
  input: {
    id: string;
    name: string;
    email: string;
    password: string;
    emailVerified?: boolean;
    /** False for an invited person: the random password is a placeholder until they set their own. */
    passwordChosen: boolean;
  },
): Promise<void> {
  const email = input.email.trim().toLowerCase();
  await assertEmailAvailable(transaction, email);
  const passwordHash = await hashPassword(input.password);
  await transaction.insert(authUsers).values({
    id: input.id,
    name: input.name.trim(),
    email,
    emailVerified: input.emailVerified ?? true,
    passwordSetAt: input.passwordChosen ? new Date() : null,
  });
  await transaction.insert(authAccounts).values({
    id: crypto.randomUUID(),
    issuer: "local:credential",
    accountId: input.id,
    providerId: "credential",
    userId: input.id,
    password: passwordHash,
  });
}

export function clinicDateKey(timezone: string, at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export function localTimeValue(value: unknown): string {
  const text = String(value ?? "");
  return /^\d{2}:\d{2}/.test(text) ? text.slice(0, 5) : text;
}
