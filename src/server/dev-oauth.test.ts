import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { devOAuthEnabled, issueDevGrant, readDevGrant } from "./dev-oauth";

afterEach(() => vi.unstubAllEnvs());

describe("development sign-in stand-in", () => {
  it("is off unless asked for, and never on a public address", () => {
    vi.stubEnv("KALENDR_DEV_OAUTH", "");
    expect(devOAuthEnabled()).toBe(false);
    vi.stubEnv("KALENDR_DEV_OAUTH", "true");
    vi.stubEnv("BETTER_AUTH_URL", "https://book.example.com");
    expect(devOAuthEnabled()).toBe(false);
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3100");
    expect(devOAuthEnabled()).toBe(true);
  });

  it("reads back what it issued, and only that, for ten minutes", () => {
    const now = 1_000_000;
    const grant = issueDevGrant({ email: "a@example.com", name: "A", verified: true }, now);
    expect(readDevGrant(grant, now + 60_000)).toMatchObject({ email: "a@example.com", verified: true });
    expect(readDevGrant(grant, now + 11 * 60_000)).toBeNull();
    const [payload] = grant.split(".");
    expect(readDevGrant(`${payload}.forged`, now)).toBeNull();
    expect(readDevGrant("nonsense", now)).toBeNull();
  });
});
