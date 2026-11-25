import { describe, expect, it } from "vitest";

import { staffClinicProfileSchema } from "@/server/contracts";

import { clinicProfileBody, serviceBookingUrl } from "./patient-page-settings";

describe("serviceBookingUrl", () => {
  it("links to the booking page with the service already chosen", () => {
    expect(serviceBookingUrl("https://kalendr.example", "cedar-hair", "service_haircut")).toBe(
      "https://kalendr.example/book/cedar-hair?service=service_haircut",
    );
  });

  it("escapes ids that are not URL-safe", () => {
    expect(serviceBookingUrl("http://localhost:3001", "a b", "x&y")).toBe("http://localhost:3001/book/a%20b?service=x%26y");
  });
});

describe("clinicProfileBody", () => {
  const fields = { name: "Cedar", legalName: "", phone: "+919876543210", locationName: "", address: "12 Main Road", city: "Pune", about: "" };

  it("sends the legal name and location name only when they are filled in", () => {
    expect(clinicProfileBody(fields)).toEqual({ name: "Cedar", phone: "+919876543210", address: "12 Main Road", city: "Pune", about: null });
    expect(clinicProfileBody({ ...fields, legalName: " Cedar Pvt Ltd ", locationName: "Main studio" })).toMatchObject({ legalName: "Cedar Pvt Ltd", locationName: "Main studio" });
  });

  it("is accepted by the clinic API contract", () => {
    expect(staffClinicProfileSchema.safeParse(clinicProfileBody({ ...fields, legalName: "Cedar Pvt Ltd", locationName: "Main studio" })).success).toBe(true);
  });
});
