/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mergeBusy } from "./external-busy";

const range = (from: number, to: number) => ({ startsAt: new Date(Date.UTC(2026, 11, 1, from)), endsAt: new Date(Date.UTC(2026, 11, 1, to)) });

describe("mergeBusy", () => {
  it("joins overlapping and touching ranges and keeps gaps", () => {
    expect(mergeBusy([range(13, 14), range(9, 11), range(10, 12), range(12, 12.5 as number), range(15, 16)]).map((r) => [r.startsAt.getUTCHours(), r.endsAt.getUTCHours()])).toEqual([[9, 12], [13, 14], [15, 16]]);
  });
  it("handles nothing and a range inside another", () => {
    expect(mergeBusy([])).toEqual([]);
    expect(mergeBusy([range(9, 17), range(10, 11)])).toEqual([range(9, 17)]);
  });
});
