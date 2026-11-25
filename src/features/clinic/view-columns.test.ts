import { describe, expect, it, vi } from "vitest";

import type { GridColumn } from "@/lib/grid-columns";

import type { GridColumns } from "./use-grid-columns";
import { cleanViewColumns, withViewColumns } from "./view-columns";

const column = (id: string, hidden = false): GridColumn => ({ id, label: id, title: id.toUpperCase(), renamed: false, hidden });
const business = (): GridColumns => {
  const all = [column("time"), column("customer"), column("service"), column("price", true)];
  return {
    all, visible: all.filter((item) => !item.hidden), canEdit: true, changed: false,
    rename: vi.fn(), hide: vi.fn(), show: vi.fn(), move: vi.fn(), moveTo: vi.fn(), resize: vi.fn(), reset: vi.fn(), canMove: () => true,
  };
};

describe("cleanViewColumns", () => {
  it("keeps known ids once, in order, and treats none as the business's columns", () => {
    expect(cleanViewColumns(["price", "nope", "time", "price"], ["time", "price"])).toEqual(["price", "time"]);
    expect(cleanViewColumns(null, ["time"])).toEqual([]);
    expect(cleanViewColumns([], ["time"])).toEqual([]);
  });
});

describe("withViewColumns", () => {
  it("leaves the business's columns alone without a view", () => {
    const grid = business();
    expect(withViewColumns(grid, [], vi.fn())).toBe(grid);
  });

  it("shows the view's columns in its order with the business's names, and edits only the view", () => {
    const grid = business();
    const set = vi.fn();
    const view = withViewColumns(grid, ["price", "time"], set);
    expect(view.visible.map((item) => [item.id, item.title])).toEqual([["price", "PRICE"], ["time", "TIME"]]);
    expect(view.all.filter((item) => item.hidden).map((item) => item.id)).toEqual(["customer", "service"]);
    expect(view.changed).toBe(true);
    expect(view.personal).toBe(true);

    view.hide("price");
    expect(set).toHaveBeenLastCalledWith(["time"]);
    view.show("service");
    expect(set).toHaveBeenLastCalledWith(["price", "time", "service"]);
    view.move("time", -1);
    expect(set).toHaveBeenLastCalledWith(["time", "price"]);
    expect(view.canMove("price", -1)).toBe(false);
    view.reset();
    expect(set).toHaveBeenLastCalledWith(null);
    expect(grid.hide).not.toHaveBeenCalled();
    expect(grid.reset).not.toHaveBeenCalled();

    view.rename("time", "When");
    expect(grid.rename).toHaveBeenCalledWith("time", "When");
  });

  it("never hides the last column", () => {
    const set = vi.fn();
    withViewColumns(business(), ["time"], set).hide("time");
    expect(set).not.toHaveBeenCalled();
  });
});
