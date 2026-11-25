import { describe, expect, it } from "vitest";

import { demoClinic } from "./demo-data";
import { parsePreviewBusinessProfile, previewClinicWith } from "./preview-business-profile";

describe("preview business profile", () => {
  it("reads a saved choice and cleans it", () => {
    const raw = encodeURIComponent(JSON.stringify({ businessType: "real_estate", terminology: { customer: { singular: "buyer" }, bad: 1 }, features: { recalls: true, x: true } }));
    expect(parsePreviewBusinessProfile(raw)).toEqual({
      businessType: "real_estate",
      terminology: { customer: { singular: "buyer" } },
      features: { recalls: true },
    });
  });

  it("ignores a missing, broken or unknown choice", () => {
    expect(parsePreviewBusinessProfile(undefined)).toBeNull();
    expect(parsePreviewBusinessProfile("%7Bnot-json")).toBeNull();
    expect(parsePreviewBusinessProfile(encodeURIComponent(JSON.stringify({ businessType: "spaceship" })))).toBeNull();
    expect(previewClinicWith(null)).toBe(demoClinic);
  });

  it("applies the choice to the demo business", () => {
    expect(previewClinicWith({ businessType: "wellness" }).businessType).toBe("wellness");
  });
});
