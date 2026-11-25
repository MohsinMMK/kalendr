import { createHash, randomBytes } from "node:crypto";

import { openPrivate, sealPrivate } from "../messaging/sealed-link";

/**
 * The private part of a campaign message's unsubscribe link. A token is 256 random bits; only its SHA-256 is used to look
 * a message up, so the database never holds a working link. A sealed copy lets a retried send build the same link.
 * No "server-only": the worker builds messages with this.
 */
export const UNSUBSCRIBE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PURPOSE = "unsubscribe";

export function hashUnsubscribeToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newUnsubscribeToken(tenantId: string, sendId: string): { hash: string; ciphertext: string | null } {
  const token = randomBytes(32).toString("base64url");
  return { hash: hashUnsubscribeToken(token), ciphertext: sealPrivate(PURPOSE, tenantId, sendId, token) };
}

export function openUnsubscribeToken(tenantId: string, sendId: string, ciphertext: string | null): string | null {
  return openPrivate(PURPOSE, tenantId, sendId, ciphertext);
}

/** The address in every marketing message. Opening it unsubscribes at once, with no sign-in. */
export function unsubscribeUrl(origin: string, token: string): string {
  return `${origin}/api/public/unsubscribe/${encodeURIComponent(token)}`;
}
