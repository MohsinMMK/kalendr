import { describe, expect, it } from "vitest";

import { layoutRows, visibleRange } from "./windowing";

describe("windowed rows", () => {
  const heights = Array.from({ length: 1000 }, (_, index) => (index % 50 === 0 ? 36 : 64));
  const layout = layoutRows(heights);

  it("adds up row heights into offsets and a total", () => {
    expect(layout.offsets[0]).toBe(0);
    expect(layout.offsets[1]).toBe(36);
    expect(layout.offsets[2]).toBe(100);
    expect(layout.total).toBe(heights.reduce((sum, height) => sum + height, 0));
  });

  it("draws only the rows in view plus a little either side", () => {
    const range = visibleRange(layout, heights, 0, 640, 2);
    expect(range.start).toBe(0);
    expect(range.end).toBeLessThan(20);
  });

  it("finds the rows far down a long list without walking all of it", () => {
    const top = layout.offsets[600];
    const range = visibleRange(layout, heights, top, 600, 0);
    expect(range.start).toBe(600);
    expect(range.end - range.start).toBeLessThan(14);
  });

  it("copes with an empty list and with scrolling past the end", () => {
    expect(visibleRange(layoutRows([]), [], 0, 500)).toEqual({ start: 0, end: 0 });
    const past = visibleRange(layout, heights, layout.total + 5000, 500, 0);
    expect(past.start).toBeLessThanOrEqual(heights.length);
    expect(past.end).toBe(heights.length);
  });
});
