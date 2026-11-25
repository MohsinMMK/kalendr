import "server-only";

import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDatabase } from "@/db/client";
import { authVerifications } from "@/db/schema";
import { auth } from "@/lib/auth";

import { sendInviteEmail, sendPasswordResetEmail } from "./auth-email";
import { appOrigin } from "./env";

export const inviteLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const resetLifetimeMs = 60 * 60 * 1000;

export interface AccountLink {
  /** Shown once to whoever sent it, so it can be shared another way (WhatsApp, in person). */
  url: string;
  emailed: boolean;
  expiresAt: string;
}

function appUrl(): string {
  return appOrigin();
}

/**
 * Creates a one-time link to choose a password. Invites and resets share Better Auth's reset
 * token, so the same /reset-password page and POST /api/auth/reset-password finish both.
 */
async function createPasswordLink(userId: string, kind: "invite" | "reset"): Promise<{ url: string; expiresAt: Date }> {
  const context = await auth.$context;
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + (kind === "invite" ? inviteLifetimeMs : resetLifetimeMs));
  // A new link replaces any earlier one, so a link sent to the wrong place stops working.
  // Identifiers are hashed, so earlier links are found by the user they belong to.
  await getDatabase()?.delete(authVerifications).where(eq(authVerifications.value, userId));
  await context.internalAdapter.createVerificationValue({
    value: userId,
    identifier: `reset-password:${token}`,
    expiresAt,
  });
  const query = new URLSearchParams({ token, ...(kind === "invite" ? { invite: "1" } : {}) });
  return { url: `${appUrl()}/reset-password?${query.toString()}`, expiresAt };
}

export async function sendStaffInvite(input: {
  userId: string;
  email: string;
  name: string;
  clinicName: string;
  inviterName: string;
}): Promise<AccountLink> {
  const link = await createPasswordLink(input.userId, "invite");
  const emailed = await sendInviteEmail({ ...input, url: link.url }).catch(() => false);
  return { url: link.url, emailed, expiresAt: link.expiresAt.toISOString() };
}

/**
 * The invite for an email that already has a login (`staff-login-invites.ts`). The link has the same shape as a new person's
 * invite, so whoever sent it can't tell the two apart from the link, but it sets no password: Better Auth's reset endpoint only
 * knows `reset-password:` tokens. The page it opens names the business and asks the person to sign in and answer. A new link
 * replaces the earlier one for the same invite.
 */
export async function sendStaffLoginInvite(input: {
  inviteId: string;
  email: string;
  name: string;
  clinicName: string;
  inviterName: string;
  expiresAt: Date;
}): Promise<AccountLink> {
  const context = await auth.$context;
  const token = randomBytes(24).toString("base64url");
  await getDatabase()?.delete(authVerifications).where(eq(authVerifications.value, input.inviteId));
  await context.internalAdapter.createVerificationValue({ value: input.inviteId, identifier: `staff-invite:${token}`, expiresAt: input.expiresAt });
  const url = `${appUrl()}/reset-password?${new URLSearchParams({ token, invite: "1" }).toString()}`;
  const emailed = await sendInviteEmail({ email: input.email, name: input.name, clinicName: input.clinicName, inviterName: input.inviterName, url, existingLogin: true }).catch(() => false);
  return { url, emailed, expiresAt: input.expiresAt.toISOString() };
}

export async function sendStaffPasswordReset(input: { userId: string; email: string; name: string }): Promise<AccountLink> {
  const link = await createPasswordLink(input.userId, "reset");
  const emailed = await sendPasswordResetEmail({ ...input, url: link.url }).catch(() => false);
  return { url: link.url, emailed, expiresAt: link.expiresAt.toISOString() };
}

/** Signs someone out everywhere. Used when they lose their last active clinic membership. */
export async function revokeAllSessions(userId: string): Promise<void> {
  const context = await auth.$context;
  await context.internalAdapter.deleteUserSessions(userId);
}
