import { describe, expect, it } from "vitest";

import { averageGapDays } from "./stats";

describe("average gap between visits", () => {
  it("is null with fewer than two visits", () => {
    expect(averageGapDays([])).toBeNull();
    expect(averageGapDays([new Date("2026-01-01")])).toBeNull();
  });
  it("averages the spaces, in any order", () => {
    expect(averageGapDays([new Date("2026-03-01"), new Date("2026-01-01"), new Date("2026-02-01")])).toBe(29.5);
    expect(averageGapDays([new Date("2026-01-01"), new Date("2026-01-31")])).toBe(30);
  });
});
