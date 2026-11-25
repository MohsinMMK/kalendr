import { describe, expect, it } from "vitest";

import { bookingSlugFromPath, decideCustomHostPath, hostOf, ownHostSet } from "./host-routing";

describe("host routing", () => {
  it("reads the host without its port", () => {
    expect(hostOf("Book.Example.com:3000")).toBe("book.example.com");
    expect(hostOf("[::1]:3000")).toBe("[::1]");
    expect(hostOf(null)).toBe("");
  });

  it("knows Kalendr's own hosts and treats everything else as a business's address", () => {
    const own = ownHostSet({ appUrl: "https://app.kalendr.example", ownHosts: "www.kalendr.example, https://admin.kalendr.example/x", cnameTarget: "edge.kalendr.example" });
    for (const host of ["localhost", "127.0.0.1", "[::1]", "app.kalendr.example", "www.kalendr.example", "admin.kalendr.example", "edge.kalendr.example"]) expect(own.has(host), host).toBe(true);
    expect(own.has("book.theirbusiness.com")).toBe(false);
    expect(own.has("acme.localhost")).toBe(false);
  });

  it("serves the business page at the root and the booking flow under /book", () => {
    expect(decideCustomHostPath("/", "acme")).toEqual({ kind: "serve", pathname: "/b/acme" });
    expect(decideCustomHostPath("/book", "acme")).toEqual({ kind: "serve", pathname: "/book/acme" });
    expect(decideCustomHostPath("/book/checkup", "acme")).toEqual({ kind: "serve", pathname: "/book/acme/checkup" });
    expect(decideCustomHostPath("/book/acme/checkup", "acme")).toEqual({ kind: "serve", pathname: "/book/acme/checkup" });
    expect(decideCustomHostPath("/b/acme/team", "acme")).toEqual({ kind: "serve", pathname: "/b/acme/team" });
    expect(decideCustomHostPath("/manage/abc", "acme")).toEqual({ kind: "serve", pathname: "/manage/abc" });
    expect(decideCustomHostPath("/api/public/availability", "acme")).toEqual({ kind: "serve", pathname: "/api/public/availability" });
  });

  it("serves a routing form under /f on a business's own address (feature 46)", () => {
    expect(decideCustomHostPath("/f/first-visit", "acme")).toEqual({ kind: "serve", pathname: "/f/acme/first-visit" });
    expect(decideCustomHostPath("/f/acme/first-visit", "acme")).toEqual({ kind: "serve", pathname: "/f/acme/first-visit" });
    expect(decideCustomHostPath("/f", "acme").kind).toBe("not_found");
    expect(decideCustomHostPath("/api/public/routing/acme/first-visit", "acme").kind).toBe("serve");
  });

  it("refuses another business, and every staff, sign-in, admin and webhook path", () => {
    for (const path of ["/b/other", "/b/other/team", "/sign-in", "/dashboard", "/settings", "/admin", "/schedule", "/start", "/api/staff/me", "/api/auth/sign-in/email", "/api/admin/x", "/api/internal/domain-check", "/api/webhooks/billing/razorpay", "/api/v1/appointments", "/api"]) {
      expect(decideCustomHostPath(path, "acme").kind, path).toBe("not_found");
    }
  });

  it("reads the slug a booking path names", () => {
    expect(bookingSlugFromPath("/book/Acme/checkup")).toBe("acme");
    expect(bookingSlugFromPath("/b/acme")).toBeNull();
    expect(bookingSlugFromPath("/book")).toBeNull();
  });
});
