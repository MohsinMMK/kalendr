import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mustRefuseNewSession } from "./sso-guard";

describe("required company sign-in and new sessions", () => {
  const base = { userId: "u1", heldSessionUserId: null, path: "/sign-in/email", companySignInRequired: true };

  it("refuses a password, link, social or passkey sign-in for a person on a required domain", () => {
    for (const path of ["/sign-in/email", "/magic-link/verify", "/callback/google", "/passkey/verify-authentication", ""]) {
      expect(mustRefuseNewSession({ ...base, path })).toBe(true);
    }
  });

  it("lets company sign-in through, and leaves businesses that do not require it alone", () => {
    expect(mustRefuseNewSession({ ...base, path: "/sso/complete" })).toBe(false);
    expect(mustRefuseNewSession({ ...base, companySignInRequired: false })).toBe(false);
  });

  it("lets a session be re-issued to the person who already holds one, but not to anyone else", () => {
    expect(mustRefuseNewSession({ ...base, path: "/two-factor/verify-totp", heldSessionUserId: "u1" })).toBe(false);
    expect(mustRefuseNewSession({ ...base, path: "/two-factor/verify-totp", heldSessionUserId: "someone-else" })).toBe(true);
  });
});
