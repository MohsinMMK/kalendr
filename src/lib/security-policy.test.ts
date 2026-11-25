import { describe, expect, it } from "vitest";

import { parseSecurityPolicy, secondFactorRequired, securityPolicyInput, stepUpIsFresh } from "./security-policy";

describe("security policy", () => {
  it("reads anything missing or malformed as the default rules", () => {
    expect(parseSecurityPolicy(undefined)).toEqual({ requireSecondFactorForAll: false });
    expect(parseSecurityPolicy("nope")).toEqual({ requireSecondFactorForAll: false });
    expect(parseSecurityPolicy({ requireSecondFactorForAll: "yes" })).toEqual({ requireSecondFactorForAll: false });
    expect(parseSecurityPolicy({ requireSecondFactorForAll: true })).toEqual({ requireSecondFactorForAll: true });
  });

  it("always requires a second factor of owners and admins, and of everyone when the business asks", () => {
    const relaxed = { requireSecondFactorForAll: false };
    expect(secondFactorRequired("owner", relaxed)).toBe(true);
    expect(secondFactorRequired("admin", relaxed)).toBe(true);
    expect(secondFactorRequired("receptionist", relaxed)).toBe(false);
    expect(secondFactorRequired("billing", { requireSecondFactorForAll: true })).toBe(true);
  });

  it("refuses unknown keys in the settings request", () => {
    expect(securityPolicyInput.safeParse({ requireSecondFactorForAll: true, extra: 1 }).success).toBe(false);
    expect(securityPolicyInput.safeParse({}).success).toBe(false);
  });

  it("treats a check as fresh for exactly ten minutes", () => {
    const now = new Date("2026-11-19T10:00:00Z");
    expect(stepUpIsFresh(new Date(now.getTime() - 10 * 60_000), now)).toBe(true);
    expect(stepUpIsFresh(new Date(now.getTime() - 10 * 60_000 - 1), now)).toBe(false);
    expect(stepUpIsFresh(null, now)).toBe(false);
  });
});
