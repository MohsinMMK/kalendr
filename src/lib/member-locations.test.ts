import { describe, expect, it } from "vitest";

import { locationLimitLabel, normaliseLocationIds, sameLocationIds } from "./member-locations";

const names: Record<string, string> = { a: "Tolichowki", b: "Banjara Hills", c: "Madhapur", d: "Gachibowli" };
const nameOf = (id: string) => names[id] ?? "Location";

describe("locationLimitLabel", () => {
  it("says nothing for someone who works at every location", () => {
    expect(locationLimitLabel([], nameOf)).toBeNull();
    expect(locationLimitLabel(undefined, nameOf)).toBeNull();
  });

  it("names one location as the only one", () => {
    expect(locationLimitLabel(["a"], nameOf)).toBe("Tolichowki only");
  });

  it("names two or three locations and counts more", () => {
    expect(locationLimitLabel(["a", "b"], nameOf)).toBe("Tolichowki and Banjara Hills");
    expect(locationLimitLabel(["a", "b", "c"], nameOf)).toBe("Tolichowki, Banjara Hills and Madhapur");
    expect(locationLimitLabel(["a", "b", "c", "d"], nameOf)).toBe("4 locations");
  });

  it("counts a repeated id once", () => {
    expect(locationLimitLabel(["a", "a"], nameOf)).toBe("Tolichowki only");
  });
});

describe("location id lists", () => {
  it("sorts and de-duplicates, so order never counts as a change", () => {
    expect(normaliseLocationIds(["b", "a", "b"])).toEqual(["a", "b"]);
    expect(sameLocationIds(["b", "a"], ["a", "b"])).toBe(true);
    expect(sameLocationIds(["a"], ["a", "b"])).toBe(false);
    expect(sameLocationIds([], [])).toBe(true);
  });
});
