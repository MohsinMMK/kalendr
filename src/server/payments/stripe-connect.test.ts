import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

import { startStripeConnect, stateIsValid } from "./stripe-connect";

const context = (overrides: Partial<StaffContext> = {}): StaffContext => ({
  tenantId: "tenant-a", clinicSlug: "a", clinicName: "A", role: "owner", permissions: resolvePermissions("owner", {}), membershipId: "m", userId: "user-1",
  userName: "Owner", userEmail: "o@example.com", preview: false, secondFactorEnrolled: true, secondFactorAt: new Date(), ...overrides,
});

describe("Connect with Stripe", () => {
  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(40));
    vi.stubEnv("STRIPE_CONNECT_CLIENT_ID", "ca_test_123");
    vi.stubEnv("STRIPE_CONNECT_SECRET_KEY", "sk_test_123");
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_test_123");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends the owner to Stripe with a signed state that only they, in this browser, can bring back", () => {
    const now = new Date();
    const started = startStripeConnect(context(), "https://app.example", now);
    const url = new URL(started.url);
    expect(url.origin + url.pathname).toBe("https://connect.stripe.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("ca_test_123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/api/staff/payment-account/stripe/callback");
    const state = url.searchParams.get("state");
    expect(stateIsValid(state, started.nonce, context(), now)).toBe(true);
    // Another person, another business, another browser, a stale state and a tampered one are all refused.
    expect(stateIsValid(state, started.nonce, context({ userId: "user-2" }), now)).toBe(false);
    expect(stateIsValid(state, started.nonce, context({ tenantId: "tenant-b" }), now)).toBe(false);
    expect(stateIsValid(state, "another-browsers-cookie-value-000", context(), now)).toBe(false);
    expect(stateIsValid(state, null, context(), now)).toBe(false);
    expect(stateIsValid(state, started.nonce, context(), new Date(now.getTime() + 11 * 60_000))).toBe(false);
    expect(stateIsValid(`${state}x`, started.nonce, context(), now)).toBe(false);
    expect(stateIsValid("garbage", started.nonce, context(), now)).toBe(false);
  });

  it("needs a recent second-factor check and a server set up for Stripe", () => {
    expect(() => startStripeConnect(context({ secondFactorAt: null }), "https://app.example")).toThrow();
    expect(() => startStripeConnect(context({ permissions: resolvePermissions("receptionist", {}) }), "https://app.example")).toThrow();
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "");
    expect(() => startStripeConnect(context(), "https://app.example")).toThrow(/Stripe isn't set up/);
  });
});
