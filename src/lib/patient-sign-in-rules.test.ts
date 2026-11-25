import { describe, expect, it } from "vitest";

import {
  manageLinkExpired,
  manageLinkExpiry,
  patientSessionLifetimeMs,
  stepUpSatisfied,
  wrongCodeDelaySeconds,
} from "./patient-sign-in-rules";

const day = 24 * 60 * 60 * 1_000;

describe("wrong-code delay", () => {
  it("grows after each wrong code and stops at 30 seconds", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(wrongCodeDelaySeconds)).toEqual([0, 2, 4, 8, 16, 30, 30, 30]);
  });
});

describe("session length", () => {
  it("is a day, or 30 days when the device is remembered", () => {
    expect(patientSessionLifetimeMs(false)).toBe(day);
    expect(patientSessionLifetimeMs(true)).toBe(30 * day);
  });
});

describe("manage link expiry", () => {
  const endsAt = new Date("2026-10-01T10:00:00Z");
  it("opens until 30 days after the visit ends", () => {
    expect(manageLinkExpiry(endsAt).toISOString()).toBe("2026-10-31T10:00:00.000Z");
    expect(manageLinkExpired(endsAt, new Date("2026-10-31T09:59:59Z"))).toBe(false);
    expect(manageLinkExpired(endsAt, new Date("2026-10-31T10:00:00Z"))).toBe(true);
    // 31 days after, the case in the Done-when.
    expect(manageLinkExpired(endsAt, new Date(endsAt.getTime() + 31 * day))).toBe(true);
  });
});

describe("step-up", () => {
  it("asks a forwarded link, lets a code or the customer's own portal session through", () => {
    expect(stepUpSatisfied({ hasGrant: false, portalSessionForCustomer: false, paid: false })).toBe(false);
    expect(stepUpSatisfied({ hasGrant: true, portalSessionForCustomer: false, paid: false })).toBe(true);
    expect(stepUpSatisfied({ hasGrant: false, portalSessionForCustomer: true, paid: false })).toBe(true);
  });
  it("always asks for a paid booking, whatever the portal session says", () => {
    expect(stepUpSatisfied({ hasGrant: false, portalSessionForCustomer: true, paid: true })).toBe(false);
    expect(stepUpSatisfied({ hasGrant: true, portalSessionForCustomer: true, paid: true })).toBe(true);
  });
});
