import { describe, expect, it } from "vitest";

import { approvalSettingsSchema, decideApproval, isFreeMailAddress } from "./approval";

const startsAt = new Date("2026-12-10T10:00:00.000Z");
const hoursBefore = (hours: number) => new Date(startsAt.getTime() - hours * 3_600_000);

describe("approval rule", () => {
  it("books at once when the rule is never and always asks when it is always", () => {
    expect(decideApproval({ settings: { rule: "never", noticeHours: 24 }, startsAt, now: hoursBefore(1), email: "a@b.co" })).toBe("booked");
    expect(decideApproval({ settings: { rule: "always", noticeHours: 24 }, startsAt, now: hoursBefore(900), email: "a@b.co" })).toBe("requested");
  });

  it("asks only for last-minute bookings under short notice, up to and including the notice hours", () => {
    const settings = { rule: "short_notice", noticeHours: 24 } as const;
    expect(decideApproval({ settings, startsAt, now: hoursBefore(23), email: "" })).toBe("requested");
    expect(decideApproval({ settings, startsAt, now: hoursBefore(24), email: "" })).toBe("requested");
    expect(decideApproval({ settings, startsAt, now: hoursBefore(24.01), email: "" })).toBe("booked");
    expect(decideApproval({ settings, startsAt, now: hoursBefore(24 * 7), email: "" })).toBe("booked");
  });

  it("asks for free-mail addresses and books company addresses", () => {
    const settings = { rule: "free_mail", noticeHours: 24 } as const;
    expect(decideApproval({ settings, startsAt, now: hoursBefore(100), email: "someone@gmail.com" })).toBe("requested");
    expect(decideApproval({ settings, startsAt, now: hoursBefore(100), email: "Someone@GMAIL.com " })).toBe("requested");
    expect(decideApproval({ settings, startsAt, now: hoursBefore(100), email: "ops@acme-corp.in" })).toBe("booked");
  });

  it("treats a missing or malformed address as the risky choice", () => {
    expect(isFreeMailAddress("")).toBe(true);
    expect(isFreeMailAddress(null)).toBe(true);
    expect(isFreeMailAddress("no-at-sign")).toBe(true);
    expect(isFreeMailAddress("a@")).toBe(true);
    expect(isFreeMailAddress("a@sub.gmail.com")).toBe(false);
  });

  it("validates the editor's settings", () => {
    expect(approvalSettingsSchema.safeParse({ rule: "short_notice", noticeHours: 24, requestsHoldSlot: true, hideLocationUntilConfirmed: false }).success).toBe(true);
    expect(approvalSettingsSchema.safeParse({ rule: "sometimes", noticeHours: 24, requestsHoldSlot: true, hideLocationUntilConfirmed: false }).success).toBe(false);
    expect(approvalSettingsSchema.safeParse({ rule: "always", noticeHours: 0, requestsHoldSlot: true, hideLocationUntilConfirmed: false }).success).toBe(false);
    expect(approvalSettingsSchema.safeParse({ rule: "always", noticeHours: 721, requestsHoldSlot: true, hideLocationUntilConfirmed: false }).success).toBe(false);
  });
});
