import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db/client", () => ({ withTenant: vi.fn() }));

import { resolveEntitlements, type SubscriptionFacts } from "@/lib/entitlements";

import { ApiError } from "./api-error";
import { planLimitError, requireFeature, requireWithinLimit } from "./entitlements";

const now = new Date("2026-11-19T10:00:00Z");
const day = 86_400_000;
const facts = (overrides: Partial<SubscriptionFacts>): SubscriptionFacts => ({
  planKey: "starter", status: "active", trialEndsAt: null, currentPeriodEnd: new Date(now.getTime() + 20 * day), cancelAtPeriodEnd: false, pendingPlanKey: null, pastDueSince: null, ...overrides,
});
const entitled = (overrides: Partial<SubscriptionFacts>, at = now) => ({ entitlements: resolveEntitlements(facts(overrides), {}, at) });

function refusal(run: () => void): ApiError {
  try { run(); } catch (error) { if (error instanceof ApiError) return error; throw error; }
  throw new Error("expected a refusal");
}

describe("requireWithinLimit", () => {
  it("allows the third staff calendar on Starter and refuses the fourth, naming Growth", () => {
    expect(() => requireWithinLimit(entitled({}), "staffCalendars", 2)).not.toThrow();
    const error = refusal(() => requireWithinLimit(entitled({}), "staffCalendars", 3));
    expect(error.status).toBe(402);
    expect(error.code).toBe("plan_limit");
    expect(error.message).toContain("Growth");
    expect(error.details).toEqual({ subject: "staffCalendars", requiredPlan: "growth", currentPlan: "starter", limit: 3 });
  });
  it("refuses a second location on Starter and names Growth", () => {
    expect(refusal(() => requireWithinLimit(entitled({}), "locations", 1)).details).toMatchObject({ requiredPlan: "growth", limit: 1 });
  });
  it("refuses the 51st booking on Free and names Starter", () => {
    const free = { entitlements: resolveEntitlements(null, {}, now) };
    expect(() => requireWithinLimit(free, "bookingsPerMonth", 49)).not.toThrow();
    expect(refusal(() => requireWithinLimit(free, "bookingsPerMonth", 50)).details).toMatchObject({ requiredPlan: "starter", currentPlan: "free" });
  });
  it("never refuses on an unlimited plan, and lets a context with no entitlements through (test fixtures)", () => {
    expect(() => requireWithinLimit(entitled({ planKey: "scale" }), "staffCalendars", 500)).not.toThrow();
    expect(() => requireWithinLimit({}, "staffCalendars", 500)).not.toThrow();
  });
  it("says there is no higher plan when even Scale is not enough", () => {
    const error = planLimitError("staffCalendars", entitled({ planKey: "growth" }).entitlements, 10);
    expect(error.details).toMatchObject({ requiredPlan: "scale" });
  });
});

describe("requireFeature", () => {
  it("refuses WhatsApp on Free, naming Starter", () => {
    const error = refusal(() => requireFeature({ entitlements: resolveEntitlements(null, {}, now) }, "whatsapp"));
    expect(error.code).toBe("plan_limit");
    expect(error.details).toMatchObject({ subject: "whatsapp", requiredPlan: "starter", currentPlan: "free", limit: null });
  });
  it("names Growth for the API and the custom domain on Starter", () => {
    expect(refusal(() => requireFeature(entitled({}), "api")).details).toMatchObject({ requiredPlan: "growth" });
    expect(refusal(() => requireFeature(entitled({}), "customDomain")).message).toContain("Growth");
  });
  it("allows online payments on Starter", () => {
    expect(() => requireFeature(entitled({}), "onlinePayments")).not.toThrow();
  });
});

describe("plan over time (the dunning timeline)", () => {
  const failedAt = new Date("2026-11-10T00:00:00Z");
  const renewalFailed = { status: "past_due" as const, pastDueSince: failedAt };
  it("keeps full service on day 6", () => {
    const entitlements = resolveEntitlements(facts(renewalFailed), {}, new Date(failedAt.getTime() + 6 * day));
    expect(entitlements.planKey).toBe("starter");
    expect(entitlements.graceEndsAt?.toISOString()).toBe("2026-11-17T00:00:00.000Z");
  });
  it("is Free on day 8", () => {
    expect(resolveEntitlements(facts(renewalFailed), {}, new Date(failedAt.getTime() + 8 * day)).planKey).toBe("free");
  });
});
