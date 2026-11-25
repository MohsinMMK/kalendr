/**
 * Long lists draw only the rows that are on screen. Rows have a known height, so where each one sits is
 * simple arithmetic and scrolling never has to measure the page.
 */
export interface RowLayout {
  /** Distance from the top of the list to the top of each row. */
  offsets: number[];
  /** Total height of the list. */
  total: number;
}

export function layoutRows(heights: readonly number[]): RowLayout {
  const offsets: number[] = new Array(heights.length);
  let total = 0;
  for (let index = 0; index < heights.length; index += 1) {
    offsets[index] = total;
    total += heights[index];
  }
  return { offsets, total };
}

/** The first row whose bottom edge is below `position`. */
function firstRowBelow(layout: RowLayout, heights: readonly number[], position: number): number {
  let low = 0;
  let high = heights.length - 1;
  let found = heights.length;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (layout.offsets[middle] + heights[middle] > position) { found = middle; high = middle - 1; } else low = middle + 1;
  }
  return found;
}

/** The rows to draw for a scroll position: those in view plus a few either side so fast scrolling never shows a gap. */
export function visibleRange(layout: RowLayout, heights: readonly number[], scrollTop: number, viewportHeight: number, overscan = 6): { start: number; end: number } {
  if (heights.length === 0) return { start: 0, end: 0 };
  const first = firstRowBelow(layout, heights, Math.max(0, scrollTop));
  const last = firstRowBelow(layout, heights, scrollTop + viewportHeight);
  return { start: Math.max(0, first - overscan), end: Math.min(heights.length, last + 1 + overscan) };
}
