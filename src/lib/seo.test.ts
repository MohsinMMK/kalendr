import { describe, expect, it } from "vitest";

import { businessTitle, canonicalUrl, isIndexable, pagePath, parseSeo, planHasLapsed, robotsFor } from "./seo";

const now = new Date("2026-11-21T10:00:00Z");
const day = 86_400_000;

describe("indexing rule", () => {
  const running = { listed: true, isActive: true, paused: false, planLapsed: false };
  it("indexes a listed, running business", () => expect(isIndexable(running)).toBe(true));
  it("never indexes an unlisted one", () => expect(isIndexable({ ...running, listed: false })).toBe(false));
  it("never indexes a switched-off, paused or lapsed one", () => {
    expect(isIndexable({ ...running, isActive: false })).toBe(false);
    expect(isIndexable({ ...running, paused: true })).toBe(false);
    expect(isIndexable({ ...running, planLapsed: true })).toBe(false);
  });
  it("turns that into robots directives", () => {
    expect(robotsFor(true)).toEqual({ index: true, follow: true });
    expect(robotsFor(false)).toEqual({ index: false, follow: false });
  });
});

describe("plan lapse, matching the database function", () => {
  it("treats a business with no subscription yet as new", () => expect(planHasLapsed(null, now)).toBe(false));
  it("lapses an ended trial but not a running one", () => {
    expect(planHasLapsed({ status: "trialing", trialEndsAt: new Date(now.getTime() + day), pastDueSince: null, currentPeriodEnd: null }, now)).toBe(false);
    expect(planHasLapsed({ status: "trialing", trialEndsAt: new Date(now.getTime() - day), pastDueSince: null, currentPeriodEnd: null }, now)).toBe(true);
    expect(planHasLapsed({ status: "trialing", trialEndsAt: null, pastDueSince: null, currentPeriodEnd: null }, now)).toBe(true);
  });
  it("gives a failed payment seven days", () => {
    expect(planHasLapsed({ status: "past_due", trialEndsAt: null, pastDueSince: new Date(now.getTime() - 3 * day), currentPeriodEnd: null }, now)).toBe(false);
    expect(planHasLapsed({ status: "past_due", trialEndsAt: null, pastDueSince: new Date(now.getTime() - 8 * day), currentPeriodEnd: null }, now)).toBe(true);
  });
  it("lapses a cancelled plan after its paid period", () => {
    expect(planHasLapsed({ status: "cancelled", trialEndsAt: null, pastDueSince: null, currentPeriodEnd: new Date(now.getTime() + day) }, now)).toBe(false);
    expect(planHasLapsed({ status: "cancelled", trialEndsAt: null, pastDueSince: null, currentPeriodEnd: new Date(now.getTime() - day) }, now)).toBe(true);
  });
  it("keeps active, paused and free plans served", () => {
    for (const status of ["active", "paused", "free"]) expect(planHasLapsed({ status, trialEndsAt: null, pastDueSince: null, currentPeriodEnd: null }, now)).toBe(false);
  });
});

describe("canonical address", () => {
  const appUrl = "https://kalendr.example/";
  it("uses Kalendr's address without a custom domain", () => expect(canonicalUrl({ appUrl, path: "/b/smile" })).toBe("https://kalendr.example/b/smile"));
  it("prefers a verified custom domain", () => expect(canonicalUrl({ appUrl, customHost: "Book.Smile.IN", path: "/" })).toBe("https://book.smile.in/"));
  it("ignores a stored host that is not a plain host name", () => {
    for (const host of ["evil.test/path", "a b.test", "https://x.test", "nodots", "x.test?y=1"]) {
      expect(canonicalUrl({ appUrl, customHost: host, path: "/b/smile" })).toBe("https://kalendr.example/b/smile");
    }
  });
  it("builds page paths for Kalendr's address and for a custom domain", () => {
    expect(pagePath("business", "smile")).toBe("/b/smile");
    expect(pagePath("business", "smile", "", true)).toBe("/");
    expect(pagePath("service", "smile", "check-up")).toBe("/book/smile/check-up");
    expect(pagePath("service", "smile", "check-up", true)).toBe("/book/check-up");
    expect(pagePath("person", "smile", "p1")).toBe("/b/smile/team/p1");
  });
});

describe("seo settings", () => {
  it("keeps good values and drops odd ones", () => {
    expect(parseSeo({ title: "  Our clinic ", description: "Book now" })).toEqual({ title: "Our clinic", description: "Book now" });
    expect(parseSeo({ title: 42, description: "x".repeat(500) })).toEqual({ title: undefined, description: undefined });
    expect(parseSeo(null)).toEqual({ title: undefined, description: undefined });
  });
  it("writes a title that says what the page is for", () => {
    expect(businessTitle("Smile Dental", "Andheri West", {})).toBe("Book an appointment at Smile Dental, Andheri West");
    expect(businessTitle("Smile Dental", undefined, {})).toBe("Book an appointment at Smile Dental");
    expect(businessTitle("Smile Dental", "Pune", { title: "Smile, the friendly dentist" })).toBe("Smile, the friendly dentist");
  });
});
