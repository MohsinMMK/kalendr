import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db/client", () => ({
  getDatabase: () => null,
  withTenant: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ authIsConfigured: false }));

import { firstLocationName } from "@/lib/clinic-registration";
import { businessTypeIds, businessTypes } from "@/lib/business-types";
import { staffCreateResourceSchema, staffCreateServiceSchema } from "@/server/contracts";

import {
  clinicRegistrationSchema,
  isClinicRegistrationOpen,
} from "./clinic-registration";

describe("clinic registration contract", () => {
  it("accepts a complete owner registration and requires practice details when the owner sees patients", () => {
    const parsed = clinicRegistrationSchema.safeParse({
      clinicName: "Lotus Dental",
      slug: "lotus-dental",
      phone: "+919000000301",
      email: "owner@example.com",
      password: "a-sufficiently-long-password",
      ownerName: "Meera Iyer",
      city: "Pune",
      address: "11 Example Street",
    });
    expect(parsed.success).toBe(true);
    const missingPractice = clinicRegistrationSchema.safeParse({
      clinicName: "Lotus Dental",
      slug: "lotus-dental",
      phone: "+919000000301",
      email: "owner@example.com",
      password: "a-sufficiently-long-password",
      ownerName: "Meera Iyer",
      city: "Pune",
      address: "11 Example Street",
      ownerPractices: true,
    });
    expect(missingPractice.success).toBe(false);
  });

  it("keeps registration closed without a configured database", () => {
    expect(isClinicRegistrationOpen()).toBe(false);
  });
  it("rejects unusable phone numbers and unknown timezones", () => {
    const valid = {
      clinicName: "Lotus",
      slug: "lotus",
      phone: "+919000000301",
      email: "owner@example.com",
      password: "a-long-example-password",
      ownerName: "Meera Iyer",
      city: "Pune",
      address: "11 Lotus Road",
    };
    expect(
      clinicRegistrationSchema.safeParse({ ...valid, phone: "not-a-number" })
        .success,
    ).toBe(false);
    expect(
      clinicRegistrationSchema.safeParse({ ...valid, timezone: "Asia/Unknown" })
        .success,
    ).toBe(false);
  });
  it("records the business type, defaulting existing callers to healthcare", () => {
    const base = {
      clinicName: "Corner Homes",
      slug: "corner-homes",
      phone: "+919000000301",
      email: "owner@example.com",
      password: "a-long-example-password",
      ownerName: "Meera Iyer",
      city: "Pune",
      address: "11 Lotus Road",
    };
    expect(clinicRegistrationSchema.parse(base).businessType).toBe("healthcare");
    expect(clinicRegistrationSchema.parse({ ...base, businessType: "real_estate" }).businessType).toBe("real_estate");
    expect(clinicRegistrationSchema.safeParse({ ...base, businessType: "spaceship" }).success).toBe(false);
  });

  it("names the first place after the business type", () => {
    expect(firstLocationName("healthcare")).toBe("Main clinic");
    expect(firstLocationName("wellness")).toBe("Main salon");
    expect(firstLocationName("real_estate")).toBe("Main office");
    expect(firstLocationName("other")).toBe("Main location");
  });

  it("accepts every starter service and resource kind a business type offers", () => {
    for (const id of businessTypeIds) {
      for (const service of businessTypes[id].starterServices) {
        expect(staffCreateServiceSchema.safeParse({ ...service, requiredResourceKind: service.requiredResourceKind ?? null }).success).toBe(true);
      }
      for (const kind of businessTypes[id].resourceKinds) {
        expect(staffCreateResourceSchema.safeParse({ name: "Station 1", kind }).success).toBe(true);
      }
    }
  });
});
