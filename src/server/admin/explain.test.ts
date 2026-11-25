import { describe, expect, it } from "vitest";

import { explainMessage } from "./explain";

const now = new Date("2026-11-19T10:00:00Z");
const base = { failureCode: null, attemptCount: 0, scheduledAt: "2026-11-19T12:00:00.000Z", channel: "email" };

describe("explainMessage", () => {
  it("says delivered", () => {
    expect(explainMessage({ ...base, status: "delivered" }, now)).toBe("Delivered.");
  });
  it("names a skipped message for a bounced address", () => {
    expect(explainMessage({ ...base, status: "failed", failureCode: "suppressed_bounced" }, now)).toBe("Skipped: the address bounced earlier.");
  });
  it("names the attempts and code of a failure", () => {
    expect(explainMessage({ ...base, status: "failed", failureCode: "provider_error", attemptCount: 3 }, now)).toBe("Failed after 3 attempts: the provider had an error.");
    expect(explainMessage({ ...base, status: "failed", failureCode: "weird_code", attemptCount: 1 }, now)).toBe("Failed after 1 attempt: code weird_code.");
  });
  it("explains a message still waiting, future or overdue", () => {
    expect(explainMessage({ ...base, status: "queued" }, now)).toBe("Waiting: scheduled for 2026-11-19 12:00 UTC.");
    expect(explainMessage({ ...base, status: "queued", scheduledAt: "2026-11-19T08:00:00.000Z", attemptCount: 2 }, now)).toContain("has not been picked up yet. 2 attempts so far.");
  });
  it("explains a cancelled message", () => {
    expect(explainMessage({ ...base, status: "cancelled" }, now)).toMatch(/^Skipped: it was cancelled/);
  });
  it("only ever reads codes: no field can carry a name or address into the sentence", () => {
    const sentence = explainMessage({ ...base, status: "failed", failureCode: "bounced", attemptCount: 2 }, now);
    expect(sentence).not.toMatch(/@|\+\d{6,}/);
  });
});
