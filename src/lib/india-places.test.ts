import { describe, expect, it } from "vitest";

import { featuredPlaces, filterIndiaPlaces } from "./india-places";

describe("india place search", () => {
  it("shows the six featured states until someone searches", () => {
    expect(filterIndiaPlaces("").map((place) => place.state)).toEqual([
      "Telangana",
      "Karnataka",
      "Maharashtra",
      "Delhi",
      "Tamil Nadu",
      "Rajasthan",
    ]);
    expect(featuredPlaces).toHaveLength(6);
    expect(featuredPlaces.some((place) => place.city === "Hyderabad")).toBe(true);
  });

  it("filters by state, city, or landmark", () => {
    expect(filterIndiaPlaces("charminar").map((place) => place.state)).toEqual(["Telangana"]);
    expect(filterIndiaPlaces("kerala").map((place) => place.state)).toEqual(["Kerala"]);
    expect(filterIndiaPlaces("zzzz")).toEqual([]);
  });
});
