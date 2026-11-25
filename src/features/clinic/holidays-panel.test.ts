import { describe, expect, it } from "vitest";

import { withHolidayClosed } from "./holidays-panel";

const base = { country: "TT", region: null, optedOut: {}, customDays: [] };
const diwali = { id: "diwali", date: "2026-11-08" };

describe("withHolidayClosed", () => {
  it("opts a holiday out for its year and back in", () => {
    const open = withHolidayClosed(base, diwali, false);
    expect(open.optedOut).toEqual({ "2026": ["diwali"] });
    expect(withHolidayClosed(open, diwali, true).optedOut).toEqual({});
  });
  it("keeps other holidays' choices", () => {
    const both = withHolidayClosed(withHolidayClosed(base, { id: "12-25", date: "2026-12-25" }, false), diwali, false);
    expect(both.optedOut["2026"]).toEqual(["12-25", "diwali"]);
  });
});
