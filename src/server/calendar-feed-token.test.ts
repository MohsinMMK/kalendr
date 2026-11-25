import { describe, expect, it } from "vitest";

import { feedTokenHash, isFeedToken, newFeedToken } from "./calendar-feed-token";

describe("calendar feed tokens", () => {
  it("are 256 bits, URL-safe, and stored only as a SHA-256 hash", () => {
    const { token, hash } = newFeedToken();
    expect(isFeedToken(token)).toBe(true);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(feedTokenHash(token));
    expect(hash).not.toContain(token);
  });

  it("never repeat, and bad shapes are refused before any lookup", () => {
    expect(newFeedToken().token).not.toBe(newFeedToken().token);
    for (const bad of ["", "short", "x".repeat(44), `${"a".repeat(42)}!`, "../etc/passwd"]) expect(isFeedToken(bad)).toBe(false);
  });
});
