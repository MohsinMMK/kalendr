import { describe, expect, it } from "vitest";

import {
  isReservedClinicSlug,
  parseClinicSlug,
  practitionerInitials,
  slugFromName,
} from "./clinic-slug";

describe("clinic slugs", () => {
  it("builds a booking slug from a clinic name", () => {
    expect(slugFromName("Lotus Dental Studio")).toBe("lotus-dental-studio");
    expect(slugFromName("  Riverbend  Family  Clinic ")).toBe("riverbend-family-clinic");
  });

  it("rejects reserved and malformed slugs", () => {
    expect(isReservedClinicSlug("settings")).toBe(true);
    expect(isReservedClinicSlug("lotus-dental")).toBe(false);
    expect(parseClinicSlug("Settings")).toEqual({
      ok: false,
      message: "That booking address is reserved. Choose another.",
    });
    expect(parseClinicSlug("A").ok).toBe(false);
    expect(parseClinicSlug("lotus-dental")).toEqual({ ok: true, value: "lotus-dental" });
  });

  it("derives initials without titles", () => {
    expect(practitionerInitials("Dr Kavya Rao")).toBe("KR");
    expect(practitionerInitials("Asha Mehta")).toBe("AM");
  });
});
