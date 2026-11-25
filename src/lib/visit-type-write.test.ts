import { describe, expect, it } from "vitest";

import { staffCreateServiceSchema, staffUpdateServiceSchema } from "@/server/contracts";

import { visitTypeCreateBody, visitTypeUpdateBody } from "./visit-type-write";

const consultation = {
  name: "Consultation",
  description: "A first visit or review of a dental concern.",
  durationMinutes: 30,
  bookingMode: "instant" as const,
  priceLabel: "",
  resourceKind: "",
  practitionerIds: ["practitioner_asha"],
};

describe("visit type write bodies", () => {
  it("creates a consultation tag without null price or chair so the API accepts it", () => {
    const body = visitTypeCreateBody(consultation);
    expect(body).toEqual({
      name: "Consultation",
      description: "A first visit or review of a dental concern.",
      durationMinutes: 30,
      bookingMode: "instant",
      practitionerIds: ["practitioner_asha"],
    });
    expect(body).not.toHaveProperty("priceLabel");
    expect(body).not.toHaveProperty("requiredResourceKind");
    expect(staffCreateServiceSchema.safeParse(body).success).toBe(true);
  });

  it("saves selected tag options including empty price and chair on update", () => {
    const body = visitTypeUpdateBody({
      ...consultation,
      durationMinutes: 20,
      bookingMode: "request",
      priceLabel: "From ₹800",
      resourceKind: "chair",
    });
    expect(staffUpdateServiceSchema.safeParse(body).success).toBe(true);
    expect(visitTypeUpdateBody(consultation)).toMatchObject({
      priceLabel: null,
      requiredResourceKind: null,
      isActive: true,
    });
    expect(staffUpdateServiceSchema.safeParse(visitTypeUpdateBody(consultation)).success).toBe(true);
  });

  it("sends where a service is offered on create and update, and leaves it out when unknown", () => {
    const withLocations = { ...consultation, locationIds: ["loc_a", "loc_b"] };
    expect(visitTypeCreateBody(withLocations)).toMatchObject({ locationIds: ["loc_a", "loc_b"] });
    const update = visitTypeUpdateBody(withLocations);
    expect(update).toMatchObject({ locationIds: ["loc_a", "loc_b"] });
    expect(staffUpdateServiceSchema.safeParse(update).success).toBe(true);
    expect(visitTypeUpdateBody(consultation)).not.toHaveProperty("locationIds");
    expect(visitTypeUpdateBody({ ...consultation, locationIds: [] })).not.toHaveProperty("locationIds");
  });
});
