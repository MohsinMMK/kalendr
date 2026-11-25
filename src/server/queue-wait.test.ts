import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { waitRange } from "./queue-screens";

describe("waitRange", () => {
  it("has no wait when no one is ahead", () => {
    expect(waitRange(0, 15, 1)).toBeNull();
  });

  it("gives a range in steps of five around people ahead times visit length", () => {
    expect(waitRange(2, 15, 1)).toEqual({ low: 20, high: 40 });
    expect(waitRange(4, 15, 2)).toEqual({ low: 20, high: 40 });
  });

  it("never shows an empty or zero-width range", () => {
    expect(waitRange(1, 2, 3)).toEqual({ low: 0, high: 5 });
    expect(waitRange(1, 0, 0)).toEqual({ low: 0, high: 5 });
  });
});
