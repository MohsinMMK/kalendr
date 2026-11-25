import { describe, expect, it } from "vitest";

import { layeredFeature, ownFeatureSwitch } from "./feature-layers";

describe("feature layering", () => {
  it("lets the business's own explicit switch win over the rollout, both ways", () => {
    expect(layeredFeature({ waitlist: false }, "waitlist", true)).toBe(false);
    expect(layeredFeature({ waitlist: true }, "waitlist", false)).toBe(true);
  });
  it("falls back to the rollout when the business has no switch for it", () => {
    expect(layeredFeature({ other: true }, "waitlist", true)).toBe(true);
    expect(layeredFeature({}, "waitlist", false)).toBe(false);
    expect(layeredFeature(null, "waitlist", true)).toBe(true);
    expect(layeredFeature(["waitlist"], "waitlist", true)).toBe(true);
  });
  it("ignores values that are not booleans", () => {
    expect(ownFeatureSwitch({ waitlist: "yes" }, "waitlist")).toBeNull();
    expect(ownFeatureSwitch({ waitlist: 1 }, "waitlist")).toBeNull();
  });
});
