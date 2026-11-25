import { describe, expect, it } from "vitest";

import { appointmentTypePresets, inferPracticeKind, unusedAppointmentPresets } from "./appointment-types";

describe("appointment types", () => {
  it("detects dental, hospital, and family practices from the clinic name", () => {
    expect(inferPracticeKind("Meera's Dental Studio")).toBe("dental");
    expect(inferPracticeKind("City Hospital")).toBe("hospital");
    expect(inferPracticeKind("Rao Family Clinic")).toBe("family");
    expect(inferPracticeKind("Lotus Care")).toBe("general");
  });

  it("offers dental procedures and hides types the clinic already has", () => {
    const dental = appointmentTypePresets("dental").map((item) => item.name);
    expect(dental).toEqual(expect.arrayContaining(["Consultation", "Dental cleaning", "Root canal", "Extraction"]));
    expect(unusedAppointmentPresets("dental", ["Consultation", "dental cleaning"]).map((item) => item.name)).not.toContain("Consultation");
    expect(unusedAppointmentPresets("dental", ["Consultation", "dental cleaning"]).map((item) => item.name)).toContain("Root canal");
  });
});
