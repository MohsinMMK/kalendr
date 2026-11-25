import { describe, expect, it } from "vitest";

import { resolveBusinessProfile } from "./terminology";
import { limitToFeatures } from "./feature-limits";

const clinic = resolveBusinessProfile({ businessType: "healthcare" }).features;
const agency = resolveBusinessProfile({ businessType: "real_estate" }).features;

describe("limitToFeatures", () => {
  it("leaves everything alone when every feature is on", () => {
    const input = { bookingFor: "dependent", dateOfBirth: "1990-01-01", qualifications: "MBBS" };
    expect(limitToFeatures(input, clinic)).toEqual({ value: input, refused: null });
  });

  it("drops date of birth and credentials when they are off", () => {
    const { value, refused } = limitToFeatures({
      firstName: "Asha",
      dateOfBirth: "1990-01-01",
      registrationNumber: "R-1",
      qualifications: "BA",
      newPatient: { dateOfBirth: "2001-02-02", isDependent: false },
    }, agency);
    expect(refused).toBeNull();
    expect(value).toEqual({ firstName: "Asha", newPatient: { isDependent: false } });
  });

  it("refuses booking for someone else when dependents are off", () => {
    expect(limitToFeatures({ bookingFor: "dependent" }, agency).refused).toBe("dependents");
    expect(limitToFeatures({ newPatient: { isDependent: true } }, agency).refused).toBe("dependents");
    expect(limitToFeatures({ isDependent: true }, agency).refused).toBe("dependents");
  });
});
