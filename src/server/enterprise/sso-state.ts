import "server-only";

import { createHash, randomBytes } from "node:crypto";

import type { CacheItem, CacheProvider } from "@node-saml/node-saml";
import { and, eq, gt, lt } from "drizzle-orm";

import { getDatabase } from "@/db/client";
import { authVerifications } from "@/db/schema";

/**
 * Short-lived company sign-in state (feature 53), kept in the same table Better Auth uses for its own one-time values:
 * the request ids we sent to the identity provider, and the one-time ticket that turns a checked sign-in into a session.
 * Every identifier is hashed, every value is single-use (deleted as it is read), and every row expires.
 */

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function database() {
  const handle = getDatabase();
  if (!handle) throw new Error("The database is not available.");
  return handle;
}

async function put(identifier: string, value: string, ttlMs: number): Promise<void> {
  const db = database();
  // Opportunistic cleanup keeps the table small without a job.
  await db.delete(authVerifications).where(and(eq(authVerifications.identifier, identifier), lt(authVerifications.expiresAt, new Date())));
  await db.insert(authVerifications).values({ identifier, value, expiresAt: new Date(Date.now() + ttlMs) });
}

/** Reads and deletes in one statement, so of two copies of the same request only one gets the value. */
async function take(identifier: string): Promise<string | null> {
  const [row] = await database().delete(authVerifications)
    .where(and(eq(authVerifications.identifier, identifier), gt(authVerifications.expiresAt, new Date())))
    .returning({ value: authVerifications.value });
  return row?.value ?? null;
}

/** The place node-saml remembers the id of each login request it makes, so a response can only answer a request we sent, once. */
export function samlRequestCache(connectionId: string, ttlMs = 10 * 60_000): CacheProvider {
  const key = (id: string) => `sso:saml-request:${connectionId}:${hash(id)}`;
  return {
    async saveAsync(id: string, value: string): Promise<CacheItem | null> {
      await put(key(id), value, ttlMs);
      return { value, createdAt: Date.now() };
    },
    async getAsync(id: string): Promise<string | null> {
      const [row] = await database().select({ value: authVerifications.value }).from(authVerifications)
        .where(and(eq(authVerifications.identifier, key(id)), gt(authVerifications.expiresAt, new Date()))).limit(1);
      return row?.value ?? null;
    },
    async removeAsync(id: string | null): Promise<string | null> {
      return id === null ? null : take(key(id));
    },
    consumeAsync: (id: string) => take(key(id)),
  };
}

/**
 * The browser that starts a company sign-in gets a random cookie; only the hash of it travels through the provider (in the OIDC
 * state we keep, or in SAML's RelayState) and into the ticket. The ticket is only redeemed alongside the same cookie, so a reply
 * someone else obtained (their own sign-in, sent to another person's browser) cannot sign that browser in as them.
 */
export const SSO_BROWSER_COOKIE = "kalendr.sso_browser";

export function newBrowserBinding(): { cookie: string; binding: string } {
  const cookie = randomBytes(32).toString("base64url");
  return { cookie, binding: hash(cookie) };
}

export function bindingMatches(cookie: string | null | undefined, binding: string): boolean {
  return Boolean(cookie) && /^[0-9a-f]{64}$/.test(binding) && hash(cookie!) === binding;
}

export interface OidcPending {
  connectionId: string;
  /** The hash of the starting browser's cookie. */
  binding: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export async function saveOidcPending(pending: OidcPending): Promise<void> {
  await put(`sso:oidc-state:${hash(pending.state)}`, JSON.stringify(pending), 10 * 60_000);
}

export async function takeOidcPending(state: string): Promise<OidcPending | null> {
  const raw = await take(`sso:oidc-state:${hash(state)}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OidcPending;
  } catch {
    return null;
  }
}

export interface SsoTicket {
  userId: string;
  tenantId: string;
  connectionId: string;
  /** The hash of the cookie of the browser that started this sign-in. */
  binding: string;
}

/** A 256-bit one-time ticket, valid for two minutes: the bridge between the identity provider's reply and a Kalendr session. */
export async function issueSsoTicket(ticket: SsoTicket): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await put(`sso:ticket:${hash(raw)}`, JSON.stringify(ticket), 2 * 60_000);
  return raw;
}

export async function redeemSsoTicket(raw: string): Promise<SsoTicket | null> {
  const value = await take(`sso:ticket:${hash(raw)}`);
  if (!value) return null;
  try {
    return JSON.parse(value) as SsoTicket;
  } catch {
    return null;
  }
}
