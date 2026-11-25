/** @vitest-environment node */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lookups = vi.hoisted(() => ({
  business: vi.fn<(host: string) => Promise<{ tenantId: string; slug: string } | null>>(),
  origins: vi.fn<(slug: string) => Promise<string[]>>(),
}));
vi.mock("@/server/host-lookup", () => ({ lookupHostBusiness: lookups.business, lookupEmbedOrigins: lookups.origins }));

import { proxy } from "./proxy";

function request(host: string, path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://${host}${path}`, { headers: { host, ...headers } });
}
const rewritten = (response: Response): string | null => response.headers.get("x-middleware-rewrite");

describe("proxy host routing (feature 13)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.kalendr.example");
    vi.stubEnv("KALENDR_CNAME_TARGET", "edge.kalendr.example");
    vi.stubEnv("KALENDR_BOOKING_FRAME_ANCESTORS", "");
    lookups.business.mockReset();
    lookups.origins.mockReset();
    lookups.origins.mockResolvedValue([]);
    lookups.business.mockImplementation(async (host) => (host === "book.acme.test" ? { tenantId: "t1", slug: "acme" } : null));
  });

  it("leaves Kalendr's own address alone and never asks the database", async () => {
    const response = await proxy(request("app.kalendr.example", "/schedule"));
    expect(response.status).toBe(200);
    expect(rewritten(response)).toBeNull();
    expect(response.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
    expect(lookups.business).not.toHaveBeenCalled();
  });

  it("serves every host as Kalendr's own until the deployment names a CNAME target", async () => {
    vi.stubEnv("KALENDR_CNAME_TARGET", "");
    const response = await proxy(request("10.0.3.7:3000", "/schedule"));
    expect(response.status).toBe(200);
    expect(rewritten(response)).toBeNull();
    expect(lookups.business).not.toHaveBeenCalled();
  });

  it("answers the health and readiness probes on any host, such as a load balancer's IP address", async () => {
    for (const path of ["/api/health", "/api/ready"]) {
      const response = await proxy(request("10.0.3.7:3000", path));
      expect(response.status, path).toBe(200);
    }
    expect(lookups.business).not.toHaveBeenCalled();
    // Only those two paths: any other API route on an unknown host is still refused.
    expect((await proxy(request("10.0.3.7:3000", "/api/staff/me"))).status).toBe(404);
  });

  it("treats localhost as Kalendr's own so development keeps working", async () => {
    const response = await proxy(request("localhost:3000", "/sign-in"));
    expect(response.status).toBe(200);
    expect(lookups.business).not.toHaveBeenCalled();
  });

  it("answers a plain 404 for a host no business owns", async () => {
    const response = await proxy(request("random.example.org", "/"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rewrites a business's address to its public pages, with the CSP computed for the page that renders", async () => {
    const home = await proxy(request("book.acme.test", "/"));
    expect(rewritten(home)).toContain("/b/acme");
    const flow = await proxy(request("book.acme.test", "/book"));
    expect(rewritten(flow)).toContain("/book/acme");
    expect(flow.headers.get("content-security-policy")).toMatch(/checkout\.razorpay\.com/);
  });

  it("refuses staff pages and staff or sign-in APIs on a business's address", async () => {
    for (const path of ["/sign-in", "/dashboard", "/settings", "/api/staff/me", "/api/auth/get-session", "/api/internal/domain-check?domain=x"]) {
      expect((await proxy(request("book.acme.test", path))).status, path).toBe(404);
    }
    expect((await proxy(request("book.acme.test", "/api/public/availability"))).status).toBe(200);
  });

  it("refuses a path that names another business", async () => {
    expect((await proxy(request("book.acme.test", "/b/rival"))).status).toBe(404);
  });

  it("refuses prefetches on an unknown host too", async () => {
    expect((await proxy(request("random.example.org", "/book", { "next-router-prefetch": "1" }))).status).toBe(404);
  });

  it("answers 503, not 404, when the database cannot be reached", async () => {
    lookups.business.mockRejectedValue(new Error("down"));
    expect((await proxy(request("book.acme.test", "/"))).status).toBe(503);
  });

  it("frames the booking page only on the sites this business saved", async () => {
    lookups.origins.mockResolvedValue(["https://www.acme-clinic.com"]);
    const own = await proxy(request("app.kalendr.example", "/book/acme"));
    expect(own.headers.get("content-security-policy")).toMatch(/frame-ancestors 'self' https:\/\/www\.acme-clinic\.com/);
    expect(lookups.origins).toHaveBeenCalledWith("acme");
    const custom = await proxy(request("book.acme.test", "/book"));
    expect(custom.headers.get("content-security-policy")).toMatch(/frame-ancestors 'self' https:\/\/www\.acme-clinic\.com/);
    // A business with no saved sites is framed by no one.
    lookups.origins.mockResolvedValue([]);
    const none = await proxy(request("app.kalendr.example", "/book/acme"));
    expect(none.headers.get("content-security-policy")).toMatch(/frame-ancestors 'self'(;|$)/);
  });

  it("never lets a saved origin be anything but a plain https origin in the header", async () => {
    lookups.origins.mockResolvedValue(["https://ok.example.com", "http://plain.example.com", "https://x.com; script-src *", "javascript:alert(1)"]);
    const response = await proxy(request("app.kalendr.example", "/book/acme"));
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toMatch(/frame-ancestors 'self' https:\/\/ok\.example\.com;/);
    expect(policy).not.toContain("plain.example.com");
    expect(policy).not.toContain("script-src *");
  });
});
