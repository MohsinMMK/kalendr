import { describe, expect, it } from "vitest";

import { createOAuthState, OAUTH_STATE_MAX_AGE_SECONDS, verifyOAuthState } from "./calendar-oauth-state";

const secret = "s".repeat(40);
const claims = { tenantId: "tenant-a", membershipId: "member-1", provider: "google" as const };

describe("OAuth state", () => {
  it("accepts the state it made, with the cookie, for the same person", () => {
    const { state, nonce } = createOAuthState(secret, claims);
    expect(verifyOAuthState(secret, state, nonce, claims)).toEqual({ ok: true, claims });
  });

  it("refuses a missing cookie, a different cookie, or a different browser's cookie", () => {
    const { state, nonce } = createOAuthState(secret, claims);
    expect(verifyOAuthState(secret, state, null, claims).ok).toBe(false);
    expect(verifyOAuthState(secret, state, `${nonce}x`, claims).ok).toBe(false);
    expect(verifyOAuthState(secret, state, createOAuthState(secret, claims).nonce, claims).ok).toBe(false);
  });

  it("refuses a state made for another staff member, business or provider", () => {
    const { state, nonce } = createOAuthState(secret, claims);
    expect(verifyOAuthState(secret, state, nonce, { ...claims, membershipId: "member-2" }).ok).toBe(false);
    expect(verifyOAuthState(secret, state, nonce, { ...claims, tenantId: "tenant-b" }).ok).toBe(false);
    expect(verifyOAuthState(secret, state, nonce, { ...claims, provider: "microsoft" }).ok).toBe(false);
  });

  it("refuses a tampered, foreign-signed or expired state", () => {
    const now = new Date("2026-11-19T10:00:00Z");
    const { state, nonce } = createOAuthState(secret, claims, now);
    const [body, signature] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ t: "tenant-a", m: "member-9", p: "google", n: nonce, e: now.getTime() + 1_000_000 })).toString("base64url");
    expect(verifyOAuthState(secret, `${forged}.${signature}`, nonce, claims, now).ok).toBe(false);
    expect(verifyOAuthState("other-secret".repeat(4), state, nonce, claims, now).ok).toBe(false);
    expect(verifyOAuthState(secret, state, nonce, claims, new Date(now.getTime() + (OAUTH_STATE_MAX_AGE_SECONDS + 1) * 1_000)).ok).toBe(false);
    expect(verifyOAuthState(secret, `${body}`, nonce, claims, now).ok).toBe(false);
    expect(verifyOAuthState(secret, "garbage.more.parts", nonce, claims, now).ok).toBe(false);
  });
});
