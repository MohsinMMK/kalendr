import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildErasureSummary,
  daysRemaining,
  defaultRetention,
  effectiveRetention,
  evaluateConsent,
  isMinor,
  isOverdue,
  marketingAllowed,
  refusalReasons,
  requestDueAt,
  validateRetention,
} from "./rules";

const now = new Date("2026-11-19T10:00:00Z");

describe("consent defaults", () => {
  it("never allows marketing without a yes, and keeps service messages on until withdrawn", () => {
    expect(evaluateConsent("marketing_messages", undefined)).toBe(false);
    expect(evaluateConsent("appointment_messages", undefined)).toBe(true);
    expect(evaluateConsent("reviews", null)).toBe(true);
    expect(evaluateConsent("records_sharing", undefined)).toBe(true);
    expect(evaluateConsent("appointment_messages", false)).toBe(false);
    expect(evaluateConsent("marketing_messages", true)).toBe(true);
  });
});

describe("children", () => {
  it("is a minor until the eighteenth birthday", () => {
    expect(isMinor({ dateOfBirth: "2009-11-20", isDependent: false }, now)).toBe(true);
    expect(isMinor({ dateOfBirth: "2008-11-19", isDependent: false }, now)).toBe(false);
    expect(isMinor({ dateOfBirth: "2008-11-20", isDependent: false }, now)).toBe(true);
  });

  it("treats a dependant as a minor, and an unknown birth date as an adult", () => {
    expect(isMinor({ dateOfBirth: null, isDependent: true }, now)).toBe(true);
    expect(isMinor({ dateOfBirth: null, isDependent: false }, now)).toBe(false);
    expect(isMinor({ dateOfBirth: "not a date", isDependent: false }, now)).toBe(false);
  });

  it("never allows marketing to a minor, a dependant or an erased customer, even with a yes", () => {
    const adult = { latestMarketingGranted: true, dateOfBirth: "1990-01-01", isDependent: false, erased: false };
    expect(marketingAllowed(adult, now)).toBe(true);
    expect(marketingAllowed({ ...adult, dateOfBirth: "2015-01-01" }, now)).toBe(false);
    expect(marketingAllowed({ ...adult, isDependent: true }, now)).toBe(false);
    expect(marketingAllowed({ ...adult, erased: true }, now)).toBe(false);
    expect(marketingAllowed({ ...adult, latestMarketingGranted: false }, now)).toBe(false);
    expect(marketingAllowed({ ...adult, latestMarketingGranted: undefined }, now)).toBe(false);
  });
});

describe("request deadlines", () => {
  it("is due 90 days after it is made and counts whole days left", () => {
    const made = new Date("2026-11-01T00:00:00Z");
    expect(requestDueAt(made).toISOString()).toBe("2027-01-30T00:00:00.000Z");
    expect(daysRemaining(requestDueAt(made), made)).toBe(90);
    expect(daysRemaining(requestDueAt(made), new Date("2027-01-29T12:00:00Z"))).toBe(1);
    expect(daysRemaining(requestDueAt(made), new Date("2027-02-02T00:00:00Z"))).toBeLessThan(0);
  });

  it("is overdue only while open and past due", () => {
    const dueAt = new Date("2026-11-18T00:00:00Z");
    expect(isOverdue({ status: "requested", dueAt }, now)).toBe(true);
    expect(isOverdue({ status: "processing", dueAt }, now)).toBe(true);
    expect(isOverdue({ status: "completed", dueAt }, now)).toBe(false);
    expect(isOverdue({ status: "refused", dueAt }, now)).toBe(false);
    expect(isOverdue({ status: "requested", dueAt: new Date("2026-12-01T00:00:00Z") }, now)).toBe(false);
  });

  it("offers every reason except \"verified\" for a refusal", () => {
    expect(refusalReasons).not.toContain("verified");
    expect(refusalReasons).toContain("legal_retention");
  });
});

describe("retention", () => {
  it("gives clinics a longer records period than other businesses, and the owner's own setting wins", () => {
    expect(defaultRetention("healthcare").medical_records.keepDays).toBeGreaterThan(defaultRetention("salon").medical_records.keepDays);
    expect(defaultRetention("healthcare").login_codes.keepDays).toBe(1);
    const merged = effectiveRetention("dental", [{ dataKind: "message_log", keepDays: 90, action: "delete" }]);
    expect(merged.message_log).toMatchObject({ keepDays: 90, isDefault: false });
    expect(merged.cancelled_booking_details.isDefault).toBe(true);
  });

  it("refuses to change sign-in codes and keeps other values in range", () => {
    expect(validateRetention("login_codes", { keepDays: 5, action: "delete" })).toMatch(/cannot be changed/);
    expect(validateRetention("message_log", { keepDays: 5, action: "delete" })).toMatch(/between/);
    expect(validateRetention("message_log", { keepDays: 120, action: "delete" })).toBeNull();
    expect(validateRetention("finished_outbox", { keepDays: 90, action: "delete" })).toMatch(/between/);
  });

  it("ignores a stored value for a kind the owner cannot change", () => {
    expect(effectiveRetention("healthcare", [{ dataKind: "login_codes", keepDays: 400, action: "delete" }]).login_codes.keepDays).toBe(1);
  });
});

describe("erasure summary", () => {
  const facts = { removedBookingDetails: 2, removedFormAnswers: 1, removedMessageLog: 3, removedReviewNames: 0, removedRecords: 0, removedGuardian: false, keptPayments: 2, keptRecords: 1, billingKeepDays: 2920, recordsKeepDays: 2555 };

  it("says what was removed and what was kept and why", () => {
    const summary = buildErasureSummary(facts);
    expect(summary.removed.join(" ")).toMatch(/phone number/);
    expect(summary.removed.join(" ")).toMatch(/activity log/);
    expect(summary.kept.join(" ")).toMatch(/Payment and refund records \(2\).*8 years/);
    expect(summary.kept.join(" ")).toMatch(/Visit notes and reports \(1\).*7 years/);
  });

  it("does not mention payments or records that do not exist", () => {
    const summary = buildErasureSummary({ ...facts, keptPayments: 0, keptRecords: 0 });
    expect(summary.kept.join(" ")).not.toMatch(/Payment/);
    expect(summary.kept.join(" ")).not.toMatch(/Visit notes/);
  });
});

describe("wording rule", () => {
  const files = [
    "src/server/privacy/notice.ts",
    "src/server/privacy/rules.ts",
    "src/server/privacy/summary.ts",
    "src/server/privacy/export.ts",
    "src/emails/privacy-export-ready.tsx",
    "src/emails/privacy-erasure-done.tsx",
    "src/emails/privacy-request-overdue.tsx",
    "docs/privacy-centre.md",
    "docs/INCIDENT_RUNBOOK.md",
  ];

  it.each(files)("%s never claims the product is compliant", (file) => {
    const text = readFileSync(join(process.cwd(), file), "utf8");
    expect(text).not.toMatch(/complian/i);
  });
});
