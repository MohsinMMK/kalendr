import { describe, expect, it } from "vitest";

import { inviteExpiry, isInvitePending, lastSignInLabel } from "./staff-invite-state";

const now = new Date("2026-11-25T10:00:00Z");
const after = (ms: number) => new Date(now.getTime() + ms);
const hour = 3_600_000;
const day = 24 * hour;

describe("isInvitePending", () => {
  it("is pending only when no password was chosen and nobody signed in", () => {
    expect(isInvitePending({ passwordSetAt: null, lastSignInAt: null })).toBe(true);
    expect(isInvitePending({ passwordSetAt: now, lastSignInAt: null })).toBe(false);
    // Google, company sign-in, passkey and magic-link people never set a password.
    expect(isInvitePending({ passwordSetAt: null, lastSignInAt: now })).toBe(false);
  });
});

describe("inviteExpiry", () => {
  it("says nothing when no invite is on record", () => {
    expect(inviteExpiry(null, now)).toBeNull();
  });

  it("counts down in days, hours, then 'within the hour'", () => {
    expect(inviteExpiry(after(3 * day + hour), now)).toEqual({ expired: false, label: "expires in 3 days" });
    expect(inviteExpiry(after(day + 1), now)?.label).toBe("expires in 1 day");
    expect(inviteExpiry(after(5 * hour + 1000), now)?.label).toBe("expires in 5 hours");
    expect(inviteExpiry(after(hour), now)?.label).toBe("expires in 1 hour");
    expect(inviteExpiry(after(20 * 60_000), now)?.label).toBe("expires within the hour");
  });

  it("reports an expired link, including one that ends right now", () => {
    expect(inviteExpiry(after(-1), now)).toEqual({ expired: true, label: "expired" });
    expect(inviteExpiry(now.toISOString(), now)).toEqual({ expired: true, label: "expired" });
  });
});

describe("lastSignInLabel", () => {
  it("names the time since the last sign-in", () => {
    expect(lastSignInLabel(null, now)).toBe("Never signed in");
    expect(lastSignInLabel(after(-10 * 60_000), now)).toBe("Signed in just now");
    expect(lastSignInLabel(after(-5 * hour), now)).toBe("Signed in today");
    expect(lastSignInLabel(after(-3 * day), now)).toBe("Signed in 3 days ago");
    expect(lastSignInLabel(after(-1 * day - hour), now)).toBe("Signed in 1 day ago");
    expect(lastSignInLabel(after(-65 * day), now)).toBe("Signed in 2 months ago");
    expect(lastSignInLabel(after(-400 * day), now)).toBe("Signed in over a year ago");
  });
});
