import { describe, expect, it } from "vitest";

import { env } from "@/server/env";

import {
  adminClientIp, adminHostAllowed, adminIpAllowed, adminSecondFactorIsFresh, clearedImpersonationCookie,
  impersonationCookie, parseIpAllowlist, readOnlyImpersonationPermissions, roleCan,
} from "./admin-access";

describe("second factor age", () => {
  const now = new Date("2026-11-19T12:00:00Z");
  it("accepts a check from the last 12 hours and refuses an older or missing one", () => {
    expect(adminSecondFactorIsFresh(new Date("2026-11-19T00:30:00Z"), now)).toBe(true);
    expect(adminSecondFactorIsFresh(new Date("2026-11-18T23:59:00Z"), now)).toBe(false);
    expect(adminSecondFactorIsFresh(null, now)).toBe(false);
  });
  it("refuses a time in the future", () => {
    expect(adminSecondFactorIsFresh(new Date("2026-11-19T15:00:00Z"), now)).toBe(false);
  });
});

describe("admin host", () => {
  it("lets any host through when none is configured", () => {
    expect(adminHostAllowed("anything.example", undefined)).toBe(true);
  });
  it("matches the configured host, ignoring case and port, and refuses others", () => {
    expect(adminHostAllowed("Admin.Example.com", "admin.example.com")).toBe(true);
    expect(adminHostAllowed("admin.example.com:443", "admin.example.com")).toBe(true);
    expect(adminHostAllowed("www.example.com", "admin.example.com")).toBe(false);
    expect(adminHostAllowed(null, "admin.example.com")).toBe(false);
    expect(adminHostAllowed("admin.example.com.evil.test", "admin.example.com")).toBe(false);
  });
});

describe("admin IP allow-list", () => {
  it("reads the client from the right of X-Forwarded-For, so a forged first entry does not help", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.9, 198.51.100.7" });
    expect(adminClientIp(headers, 1)).toBe("198.51.100.7");
    expect(adminClientIp(headers, 2)).toBe("203.0.113.9");
  });
  it("falls back to X-Real-IP, and to nothing", () => {
    expect(adminClientIp(new Headers({ "x-real-ip": "198.51.100.7" }), 1)).toBe("198.51.100.7");
    expect(adminClientIp(new Headers(), 1)).toBeNull();
    expect(adminClientIp(new Headers({ "x-forwarded-for": "not-an-ip" }), 1)).toBeNull();
  });
  it("normalises ports and mapped IPv4", () => {
    expect(adminClientIp(new Headers({ "x-forwarded-for": "198.51.100.7:51000" }), 1)).toBe("198.51.100.7");
    expect(adminClientIp(new Headers({ "x-forwarded-for": "::ffff:198.51.100.7" }), 1)).toBe("198.51.100.7");
  });
  it("allows everyone with no list and only listed addresses with one", () => {
    expect(adminIpAllowed(null, [])).toBe(true);
    const list = parseIpAllowlist("198.51.100.7, 2001:db8::1, junk");
    expect(list).toEqual(["198.51.100.7", "2001:db8::1"]);
    expect(adminIpAllowed("198.51.100.7", list)).toBe(true);
    expect(adminIpAllowed("198.51.100.8", list)).toBe(false);
    expect(adminIpAllowed(null, list)).toBe(false);
  });
  it("is validated in the environment schema", () => {
    expect(() => env({ KALENDR_ADMIN_IP_ALLOWLIST: "10.0.0.1, nope" })).toThrow(/KALENDR_ADMIN_IP_ALLOWLIST/);
    expect(env({ KALENDR_ADMIN_IP_ALLOWLIST: "10.0.0.1,10.0.0.2" }).KALENDR_ADMIN_IP_ALLOWLIST).toBe("10.0.0.1,10.0.0.2");
    expect(() => env({ KALENDR_ADMIN_HOST: "https://admin.example.com/" })).toThrow(/KALENDR_ADMIN_HOST/);
    expect(env({ KALENDR_ADMIN_HOST: "Admin.Example.com" }).KALENDR_ADMIN_HOST).toBe("admin.example.com");
    expect(env({}).KALENDR_ADMIN_HOST).toBeUndefined();
  });
});

describe("role capabilities", () => {
  it("gives support the day-to-day work, billing read-only, and super everything", () => {
    expect(roleCan("support", "findMessages")).toBe(true);
    expect(roleCan("support", "impersonate")).toBe(true);
    expect(roleCan("support", "impersonateWrite")).toBe(false);
    expect(roleCan("support", "manageRollouts")).toBe(false);
    expect(roleCan("billing", "readOverview")).toBe(true);
    expect(roleCan("billing", "operate")).toBe(false);
    expect(roleCan("billing", "impersonate")).toBe(false);
    expect(roleCan("billing", "findMessages")).toBe(false);
    for (const capability of ["findMessages", "operate", "impersonate", "impersonateWrite", "manageRollouts", "manageOperators"] as const) expect(roleCan("super", capability)).toBe(true);
  });
});

describe("impersonation cookie", () => {
  it("is HttpOnly, SameSite=Strict, site-wide and lasts 30 minutes", () => {
    const cookie = impersonationCookie("abc", false);
    expect(cookie).toContain("kalendr_support_session=abc");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=1800");
    expect(cookie).not.toContain("Secure");
  });
  it("is Secure in production and cleared with Max-Age 0", () => {
    expect(impersonationCookie("abc", true)).toContain("Secure");
    expect(clearedImpersonationCookie(true)).toMatch(/kalendr_support_session=;.*Max-Age=0/);
  });
});

describe("read-only support session", () => {
  it("can read records, the schedule and the activity log and nothing else", () => {
    expect([...readOnlyImpersonationPermissions].sort()).toEqual(["audit.view", "records.view", "reports.revenue", "reports.view", "schedule.read"]);
  });
});
