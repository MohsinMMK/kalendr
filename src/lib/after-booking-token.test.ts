import { describe, expect, it } from "vitest";

import { isRedirectUrl, afterBookingSchema } from "./after-booking";
import { redirectAddress, signSummary, verifySummary } from "./after-booking-token";

const secret = "s".repeat(48);
const claims = { bookingId: "appt_1", serviceId: "svc_1", startsAt: "2026-12-01T10:00:00.000Z" };

describe("signed booking summary", () => {
  it("verifies, and says only booking, service and time", () => {
    const token = signSummary(secret, claims);
    expect(verifySummary(secret, token)).toMatchObject(claims);
    expect(Object.keys(verifySummary(secret, token) ?? {}).sort()).toEqual(["bookingId", "expiresAt", "serviceId", "startsAt"]);
  });
  it("stops working after fifteen minutes", () => {
    const token = signSummary(secret, claims, new Date("2026-12-01T09:00:00Z"));
    expect(verifySummary(secret, token, new Date("2026-12-01T09:14:00Z"))).not.toBeNull();
    expect(verifySummary(secret, token, new Date("2026-12-01T09:16:00Z"))).toBeNull();
  });
  it("refuses a changed body, a changed signature and another key", () => {
    const token = signSummary(secret, claims);
    const [body, mac] = token.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ b: "other", s: "svc_1", t: claims.startsAt, e: Date.now() + 60_000 })).toString("base64url");
    expect(verifySummary(secret, `${forged}.${mac}`)).toBeNull();
    expect(verifySummary(secret, `${body}.${"A".repeat(mac.length)}`)).toBeNull();
    expect(verifySummary("t".repeat(48), token)).toBeNull();
    expect(verifySummary(secret, "nonsense")).toBeNull();
    expect(verifySummary(secret, `${token}.extra`)).toBeNull();
  });
});

describe("thank-you address", () => {
  it("always carries the booking id, and the details only when asked", () => {
    const bare = new URL(redirectAddress("https://shop.example.com/thanks?ref=1", { ...claims, token: "tok" }, false));
    expect(bare.searchParams.get("ref")).toBe("1");
    expect(bare.searchParams.get("kalendr_booking")).toBe("appt_1");
    expect([...bare.searchParams.keys()].sort()).toEqual(["kalendr_booking", "ref"]);
    const full = new URL(redirectAddress("https://shop.example.com/thanks", { ...claims, token: "tok" }, true));
    expect([...full.searchParams.keys()].sort()).toEqual(["kalendr_booking", "kalendr_service", "kalendr_start", "kalendr_token"]);
  });
  it("never puts a name, email or phone in the address", () => {
    const address = redirectAddress("https://shop.example.com/thanks", { ...claims, token: signSummary(secret, claims) }, true);
    expect(address).not.toMatch(/@|firstName|phone|email|name=/i);
  });
});

describe("thank-you page rules", () => {
  it("allows https only (and a local http test page in development), with no sign-in or fragment", () => {
    expect(isRedirectUrl("https://example.com/thanks")).toBe(true);
    expect(isRedirectUrl("http://example.com/thanks")).toBe(false);
    expect(isRedirectUrl("http://localhost:3000/thanks")).toBe(true);
    expect(isRedirectUrl("javascript:alert(1)")).toBe(false);
    expect(isRedirectUrl("https://user:pass@example.com/")).toBe(false);
    expect(isRedirectUrl("https://example.com/#frag")).toBe(false);
    expect(isRedirectUrl("not a url")).toBe(false);
  });
  it("needs an address when the choice is to redirect", () => {
    const base = { redirectUrl: null, passDetailsOnRedirect: false, successMessage: null, hideSuccessDetails: false };
    expect(afterBookingSchema.safeParse({ ...base, mode: "redirect" }).success).toBe(false);
    expect(afterBookingSchema.safeParse({ ...base, mode: "kalendr_page" }).success).toBe(true);
    expect(afterBookingSchema.safeParse({ ...base, mode: "redirect", redirectUrl: "https://example.com/t" }).success).toBe(true);
  });
});
