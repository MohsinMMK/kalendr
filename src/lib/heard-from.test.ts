import { describe, expect, it } from "vitest";

import { heardFromOptions, isHeardFrom, summarizeHeardFrom } from "./heard-from";

describe("heard from", () => {
  it("accepts only the known answers", () => {
    expect(isHeardFrom("walk_by")).toBe(true);
    expect(isHeardFrom("billboard")).toBe(false);
    expect(isHeardFrom(undefined)).toBe(false);
  });

  it("uses the business's words for referrals", () => {
    expect(heardFromOptions({ clinical: true }).find((option) => option.value === "referral")?.label).toBe("Referred by a doctor");
    expect(heardFromOptions({ clinical: false }).find((option) => option.value === "referral")?.label).toBe("Referred by someone else");
  });

  it("counts answers from the last 90 days, most common first", () => {
    const now = new Date("2026-11-11T12:00:00Z");
    const summary = summarizeHeardFrom(
      [
        { startsAt: "2026-11-10T09:00:00Z", heardFrom: "friend" },
        { startsAt: "2026-11-01T09:00:00Z", heardFrom: "search" },
        { startsAt: "2026-11-20T09:00:00Z", heardFrom: "search" },
        { startsAt: "2026-11-05T09:00:00Z" },
        { startsAt: "2026-07-01T09:00:00Z", heardFrom: "social" },
      ],
      now,
    );
    expect(summary.total).toBe(3);
    expect(summary.rows.map((row) => [row.value, row.count])).toEqual([
      ["search", 2],
      ["friend", 1],
    ]);
    expect(summary.rows[0].share).toBeCloseTo(2 / 3);
  });
});
