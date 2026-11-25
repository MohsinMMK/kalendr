import { afterEach, describe, expect, it, vi } from "vitest";

import { bookingFrameAncestors, contentSecurityPolicy, isBillingPath, isBookingPath, isPaymentPath, isVisitPath, visitPermissionsPolicy } from "@/lib/security-headers";

function directive(policy: string, name: string): string {
  return policy.split("; ").find((part) => part.startsWith(`${name} `)) ?? "";
}

describe("content security policy and the bot check", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("allows nothing from Cloudflare when Turnstile is off", () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    const policy = contentSecurityPolicy({ nonce: "abc" });
    expect(policy).not.toContain("challenges.cloudflare.com");
    expect(directive(policy, "frame-src")).not.toContain("cloudflare");
  });

  it("allows Turnstile's script and challenge frame, next to the nonce, when it is on", () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "1x00000000000000000000AA");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "1x0000000000000000000000000000000AA");
    const policy = contentSecurityPolicy({ nonce: "abc" });
    expect(directive(policy, "script-src")).toContain("'nonce-abc' 'strict-dynamic' https://challenges.cloudflare.com");
    expect(directive(policy, "frame-src")).toContain("https://challenges.cloudflare.com");
    expect(directive(policy, "connect-src")).not.toContain("cloudflare");
  });
});

describe("video call pages", () => {
  it("allows Daily's frame and servers only on the call pages", () => {
    const call = contentSecurityPolicy({ nonce: "abc", video: true });
    expect(directive(call, "frame-src")).toContain("https://*.daily.co");
    expect(directive(call, "connect-src")).toContain("wss://*.wss.daily.co");
    expect(directive(call, "media-src")).toContain("blob:");
    const rest = contentSecurityPolicy({ nonce: "abc" });
    expect(rest).not.toContain("daily.co");
    expect(rest).not.toContain("media-src");
  });

  it("knows which paths are call pages", () => {
    expect(isVisitPath("/visit/abc")).toBe(true);
    expect(isVisitPath("/visit/host/abc")).toBe(true);
    expect(isVisitPath("/visitors")).toBe(false);
    expect(isVisitPath("/book/x")).toBe(false);
  });

  it("gives the camera and microphone to the call pages, and the call frame on the business's own address only", () => {
    expect(visitPermissionsPolicy("riverbend")).toBe('camera=(self "https://riverbend.daily.co"), microphone=(self "https://riverbend.daily.co"), geolocation=(), browsing-topics=()');
    expect(visitPermissionsPolicy("")).toBe("camera=(self), microphone=(self), geolocation=(), browsing-topics=()");
    expect(visitPermissionsPolicy("bad domain.evil.com/x")).toBe("camera=(self), microphone=(self), geolocation=(), browsing-topics=()");
  });
});

describe("payment pages", () => {
  it("treats Settings as a page where an owner pays Kalendr", () => {
    expect(isBillingPath("/settings")).toBe(true);
    expect(isBillingPath("/settings/privacy-requests")).toBe(true);
    expect(isBillingPath("/settingsx")).toBe(false);
    expect(isBillingPath("/dashboard")).toBe(false);
  });

  it("allows Razorpay's checkout only when payments is on", () => {
    const off = contentSecurityPolicy({ nonce: "abc" });
    expect(off).not.toContain("razorpay");
    const on = contentSecurityPolicy({ nonce: "abc", payments: true });
    expect(directive(on, "script-src")).toContain("https://checkout.razorpay.com");
    expect(directive(on, "frame-src")).toContain("https://api.razorpay.com");
    expect(directive(on, "frame-src")).toContain("https://checkout.razorpay.com");
    expect(directive(on, "connect-src")).toContain("https://lumberjack.razorpay.com");
    expect(directive(on, "img-src")).toBe("img-src 'self' data: blob: https://cdn.razorpay.com");
    expect(directive(on, "script-src")).toContain("'nonce-abc' 'strict-dynamic'");
  });

  it("treats only booking, manage and pay pages as payment pages", () => {
    expect(isPaymentPath("/book/lotus")).toBe(true);
    expect(isPaymentPath("/manage/abc")).toBe(true);
    expect(isPaymentPath("/pay/xyz")).toBe(true);
    expect(isPaymentPath("/pay/test/order_1")).toBe(true);
    expect(isPaymentPath("/portal/visits/lotus-dental/appt_1")).toBe(true);
    expect(isPaymentPath("/portal")).toBe(false);
    expect(isPaymentPath("/dashboard")).toBe(false);
    expect(isPaymentPath("/booking-notes")).toBe(false);
    expect(isPaymentPath("/visit/abc")).toBe(false);
  });
});

describe("embeds and tracking (feature 52)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("allows the analytics hosts only where the policy asks for them", () => {
    const booking = contentSecurityPolicy({ nonce: "abc", tracking: true });
    expect(directive(booking, "script-src")).toContain("https://connect.facebook.net");
    expect(directive(booking, "script-src")).toContain("https://www.googletagmanager.com");
    expect(directive(booking, "script-src")).toContain("https://plausible.io");
    expect(directive(booking, "connect-src")).toContain("https://www.google-analytics.com");
    const rest = contentSecurityPolicy({ nonce: "abc" });
    for (const host of ["facebook", "googletagmanager", "google-analytics", "plausible"]) expect(rest).not.toContain(host);
  });

  it("treats only the booking pages as booking pages", () => {
    expect(isBookingPath("/book/lotus-dental")).toBe(true);
    expect(isBookingPath("/book")).toBe(true);
    for (const path of ["/manage/token", "/portal", "/schedule", "/b/lotus-dental", "/settings", "/bookings"]) expect(isBookingPath(path)).toBe(false);
  });

  it("lets other sites frame booking only from the listed origins, and nothing else gets framed", () => {
    vi.stubEnv("KALENDR_BOOKING_FRAME_ANCESTORS", "https://www.example.com, http://evil.example.com");
    expect(bookingFrameAncestors()).toBe("'self' https://www.example.com");
    expect(directive(contentSecurityPolicy({ nonce: "abc" }), "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(contentSecurityPolicy({ nonce: "abc", frameAncestors: bookingFrameAncestors() }), "frame-ancestors")).toContain("https://www.example.com");
  });
});
