import { describe, expect, it } from "vitest";

import { canonicalJsonHash, createOpaqueToken, sha256 } from "@/server/crypto";

describe("server crypto helpers", () => {
  it("hashes objects independently of property order", () => {
    expect(canonicalJsonHash({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalJsonHash({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  it("creates URL-safe high-entropy manage tokens", () => {
    const token = createOpaqueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sha256(token)).toMatch(/^[a-f0-9]{64}$/);
  });
});
