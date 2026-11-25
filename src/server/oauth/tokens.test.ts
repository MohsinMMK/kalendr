/** @vitest-environment node */

import { describe, expect, it } from "vitest";

import { accessTokenPattern, hashToken, newToken, pkceChallenge, sameText } from "./tokens";

describe("OAuth tokens", () => {
  it("makes 256-bit values behind a readable prefix, never the same twice", () => {
    const access = newToken("access");
    expect(access).toMatch(accessTokenPattern);
    expect(newToken("refresh")).toMatch(/^krt_[A-Za-z0-9_-]{43}$/);
    expect(newToken("code")).toMatch(/^kac_/);
    expect(newToken("secret")).toMatch(/^kcs_/);
    expect(new Set(Array.from({ length: 50 }, () => newToken("access"))).size).toBe(50);
  });

  it("hashes to a 64-character digest that is not the value", () => {
    const value = newToken("access");
    expect(hashToken(value)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(value)).not.toContain(value);
    expect(hashToken(value)).toBe(hashToken(value));
  });

  it("computes the PKCE challenge the way RFC 7636 shows", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("compares in a way that tolerates different lengths", () => {
    expect(sameText("abc", "abc")).toBe(true);
    expect(sameText("abc", "abd")).toBe(false);
    expect(sameText("abc", "abcd")).toBe(false);
  });
});
