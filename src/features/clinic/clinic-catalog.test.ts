import { describe, expect, it } from "vitest";

import { demoClinic, demoLocations, demoPractitioners, demoResources, demoServices } from "@/lib/demo-data";

import { resolveBusinessProfile } from "@/lib/terminology";

import { catalogLookups, clinicDayBounds } from "./clinic-catalog";

describe("clinic catalog lookups", () => {
  it("resolves live catalog names and historical fallbacks", () => {
    const lookups = catalogLookups(
      {
        clinic: demoClinic,
        profile: resolveBusinessProfile(demoClinic),
        locations: demoLocations,
        services: demoServices,
        practitioners: demoPractitioners,
        resources: demoResources,
        initialSlots: [],
        preview: true,
      },
      { services: { retired: "Retired service" }, practitioners: { retired: "Retired clinician" }, locations: {} },
    );
    expect(lookups.serviceName("service_cleaning")).toBe("Routine cleaning");
    expect(lookups.serviceName("retired")).toBe("Retired service");
    expect(lookups.practitionerName("missing")).toBe("Practitioner");
    expect(lookups.database).toBe(false);
  });

  it("builds clinic-day availability bounds in IST", () => {
    expect(clinicDayBounds("2026-09-17")).toEqual({
      from: "2026-09-17T00:00:00+05:30",
      to: "2026-09-17T23:59:59+05:30",
    });
  });
});
