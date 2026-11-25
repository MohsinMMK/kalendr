import { describe, expect, it } from "vitest";

import { exploreHref, parseExploreQuery } from "./explore-url";

describe("directory address", () => {
  it("reads clean filters", () => {
    expect(parseExploreQuery({ q: "  smile  dental ", city: "Pune", type: "dental", page: "2" })).toEqual({ q: "smile dental", city: "Pune", type: "dental", page: 2 });
  });
  it("falls back to no filter for odd values", () => {
    expect(parseExploreQuery({ type: "casino", page: "-4" })).toEqual({ q: "", city: "", type: "", page: 1 });
    expect(parseExploreQuery({ page: "abc" }).page).toBe(1);
    expect(parseExploreQuery({ q: ["a", "b"] }).q).toBe("a");
    expect(parseExploreQuery({ q: "x".repeat(300) }).q).toHaveLength(80);
  });
  it("builds a short address, leaving out empty filters", () => {
    expect(exploreHref({})).toBe("/explore");
    expect(exploreHref({ q: "smile", page: 1 })).toBe("/explore?q=smile");
    expect(exploreHref({ city: "Navi Mumbai", type: "dental", page: 3 })).toBe("/explore?city=Navi+Mumbai&type=dental&page=3");
  });
});
