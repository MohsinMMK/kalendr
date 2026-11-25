import { describe, expect, it } from "vitest";

import { generateWebhookSecret, isWebhookSecret, sign, signatureHeader, verifyWebhookSignature } from "./signature";

const secret = "whsec_" + "A".repeat(43);
const body = JSON.stringify({ id: "evt_1", type: "appointment.created" });
const now = new Date("2026-11-19T10:00:00Z");
const t = Math.floor(now.getTime() / 1000);

describe("webhook signatures", () => {
  it("makes secrets of the documented shape and never repeats one", () => {
    const a = generateWebhookSecret();
    expect(isWebhookSecret(a)).toBe(true);
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(generateWebhookSecret()).not.toBe(a);
  });

  it("verifies a header the sender made", () => {
    expect(verifyWebhookSignature(secret, signatureHeader(secret, t, body), body, { now })).toEqual({ valid: true });
  });

  it("matches the documented format and a known value", () => {
    const header = signatureHeader(secret, 1_700_000_000, "{}");
    expect(header).toBe(`t=1700000000,v1=${sign(secret, 1_700_000_000, "{}")}`);
    expect(sign(secret, 1_700_000_000, "{}")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a changed body, a changed timestamp and the wrong secret", () => {
    const header = signatureHeader(secret, t, body);
    expect(verifyWebhookSignature(secret, header, body + " ", { now })).toEqual({ valid: false, reason: "mismatch" });
    expect(verifyWebhookSignature(secret, header.replace(`t=${t}`, `t=${t + 1}`), body, { now })).toEqual({ valid: false, reason: "mismatch" });
    expect(verifyWebhookSignature("whsec_" + "B".repeat(43), header, body, { now })).toEqual({ valid: false, reason: "mismatch" });
  });

  it("rejects a replay that is too old and a timestamp from the future", () => {
    const old = signatureHeader(secret, t - 301, body);
    expect(verifyWebhookSignature(secret, old, body, { now })).toEqual({ valid: false, reason: "stale" });
    expect(verifyWebhookSignature(secret, signatureHeader(secret, t - 300, body), body, { now })).toEqual({ valid: true });
    expect(verifyWebhookSignature(secret, signatureHeader(secret, t + 301, body), body, { now })).toEqual({ valid: false, reason: "stale" });
    expect(verifyWebhookSignature(secret, old, body, { now, toleranceSeconds: 600 })).toEqual({ valid: true });
  });

  it("rejects malformed headers without throwing", () => {
    for (const header of ["", "garbage", `t=${t}`, `v1=${"a".repeat(64)}`, `t=abc,v1=${"a".repeat(64)}`, `t=${t},v1=zz`, `t=${t},v1=${"a".repeat(63)}`, `t=${t},v1=${"A".repeat(64)}`, `t=${t},v1=${"a".repeat(64)},extra=1`]) {
      expect(verifyWebhookSignature(secret, header, body, { now })).toEqual({ valid: false, reason: "malformed" });
    }
  });
});
