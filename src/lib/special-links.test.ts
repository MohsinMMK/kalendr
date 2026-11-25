import { describe, expect, it } from "vitest";

import { createCombinedLinkInput, createSpecialLinkInput, linkStatus, specialLinkPath } from "./special-links";

const later = new Date(Date.now() + 86_400_000).toISOString();

describe("createSpecialLinkInput", () => {
  it("accepts each kind with what it needs", () => {
    expect(createSpecialLinkInput.safeParse({ label: "VIP", kind: "single_use" }).success).toBe(true);
    expect(createSpecialLinkInput.safeParse({ label: "Ten", kind: "limited", maxUses: 10, expiresAt: later }).success).toBe(true);
    expect(createSpecialLinkInput.safeParse({ label: "Month", kind: "expiring", expiresAt: later }).success).toBe(true);
  });

  it("refuses a limited link without a count, an expiring one without a date, and a past end", () => {
    expect(createSpecialLinkInput.safeParse({ label: "x", kind: "limited" }).success).toBe(false);
    expect(createSpecialLinkInput.safeParse({ label: "x", kind: "expiring" }).success).toBe(false);
    expect(createSpecialLinkInput.safeParse({ label: "x", kind: "expiring", expiresAt: "2020-01-01T00:00:00Z" }).success).toBe(false);
    expect(createSpecialLinkInput.safeParse({ label: "x", kind: "single_use", maxUses: 5 }).success).toBe(false);
  });
});

describe("createCombinedLinkInput", () => {
  it("takes two to four people and a clean address", () => {
    expect(createCombinedLinkInput.safeParse({ label: "Couple", slug: "Couples-Therapy", practitionerIds: ["a", "b"] })).toMatchObject({ success: true, data: { slug: "couples-therapy" } });
    expect(createCombinedLinkInput.safeParse({ label: "Solo", slug: "solo", practitionerIds: ["a"] }).success).toBe(false);
    expect(createCombinedLinkInput.safeParse({ label: "Crowd", slug: "crowd", practitionerIds: ["a", "b", "c", "d", "e"] }).success).toBe(false);
    expect(createCombinedLinkInput.safeParse({ label: "Bad", slug: "no spaces", practitionerIds: ["a", "b"] }).success).toBe(false);
  });
});

describe("linkStatus", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  it("reads the reason that stopped the link first", () => {
    expect(linkStatus({ maxUses: 1, usedCount: 0, expiresAt: null, revokedAt: null }, now)).toBe("active");
    expect(linkStatus({ maxUses: 1, usedCount: 1, expiresAt: null, revokedAt: null }, now)).toBe("used_up");
    expect(linkStatus({ maxUses: null, usedCount: 3, expiresAt: "2026-11-20T11:59:00Z", revokedAt: null }, now)).toBe("expired");
    expect(linkStatus({ maxUses: 1, usedCount: 1, expiresAt: "2026-11-20T11:59:00Z", revokedAt: "2026-11-19T00:00:00Z" }, now)).toBe("revoked");
  });
});

describe("specialLinkPath", () => {
  it("is a short private path", () => {
    expect(specialLinkPath("abc_DEF-123")).toBe("/l/abc_DEF-123");
  });
});
