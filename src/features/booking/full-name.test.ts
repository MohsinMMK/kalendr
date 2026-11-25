import { describe, expect, it } from "vitest";

import { publicBookingSchema } from "@/lib/contracts";

import { fullNameProblem, joinFullName, splitFullName } from "./full-name";

describe("splitFullName", () => {
  it("makes the last word the last name and the rest the first name", () => {
    expect(splitFullName("Priya Nair")).toEqual({ firstName: "Priya", lastName: "Nair" });
    expect(splitFullName("Mary Anne van der Berg")).toEqual({ firstName: "Mary Anne van der", lastName: "Berg" });
  });

  it("trims and collapses spaces", () => {
    expect(splitFullName("  Priya    Nair  ")).toEqual({ firstName: "Priya", lastName: "Nair" });
  });

  it("keeps one word as a first name with an empty last name", () => {
    expect(splitFullName("Priya")).toEqual({ firstName: "Priya", lastName: "" });
    expect(splitFullName("Priya ")).toEqual({ firstName: "Priya", lastName: "" });
    expect(splitFullName("   ")).toEqual({ firstName: "", lastName: "" });
  });
});

describe("joinFullName", () => {
  it("never leaves a trailing space", () => {
    expect(joinFullName("Priya", "")).toBe("Priya");
    expect(joinFullName("Priya", "Nair")).toBe("Priya Nair");
  });
});

describe("fullNameProblem", () => {
  it("asks for a full name when empty or under two characters", () => {
    expect(fullNameProblem("", "")).toBe("Enter your full name");
    expect(fullNameProblem("A", "")).toBe("Enter your full name");
    expect(fullNameProblem("Jo", "")).toBeNull();
  });

  it("says so when a part is over 80 characters", () => {
    expect(fullNameProblem("x".repeat(81), "Nair")).toMatch(/80 characters/);
    expect(fullNameProblem("Priya", "y".repeat(81))).toMatch(/80 characters/);
    expect(fullNameProblem("x".repeat(80), "y".repeat(80))).toBeNull();
  });
});

describe("publicBookingSchema last name", () => {
  const base = {
    clinicSlug: "kalendr-test",
    patientType: "new",
    bookingFor: "self",
    locationId: "loc",
    serviceId: "svc",
    practitionerId: "pr",
    slotId: "slot",
    startsAt: "2026-12-01T09:00:00+05:30",
    endsAt: "2026-12-01T09:30:00+05:30",
    firstName: "Priya",
    phone: "+919845012345",
    email: "",
    preferredChannel: "sms",
    messagingConsent: true,
    acceptedPrivacyNotice: true,
  };

  it("accepts an empty last name for a one-word name", () => {
    expect(publicBookingSchema.safeParse({ ...base, lastName: "" }).success).toBe(true);
    expect(publicBookingSchema.safeParse({ ...base, lastName: "Nair" }).success).toBe(true);
  });

  it("turns a whitespace-only last name into an empty one", () => {
    const parsed = publicBookingSchema.safeParse({ ...base, lastName: "   " });
    expect(parsed.success && parsed.data.lastName).toBe("");
  });

  it("rejects a joined name under two characters", () => {
    expect(publicBookingSchema.safeParse({ ...base, firstName: "P", lastName: "" }).success).toBe(false);
    expect(publicBookingSchema.safeParse({ ...base, firstName: "P", lastName: "N" }).success).toBe(true);
  });

  it("still rejects a last name that is too long", () => {
    expect(publicBookingSchema.safeParse({ ...base, lastName: "x".repeat(81) }).success).toBe(false);
  });
});
