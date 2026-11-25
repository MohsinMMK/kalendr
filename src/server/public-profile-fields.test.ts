import { describe, expect, it } from "vitest";

import { customerProfile, profileFromRow, publicProfileFields, storedProfileFields } from "./business-profile";

const row = {
  business_type: "wellness",
  terminology: { customer: { singular: "guest", plural: "guests" }, roles: { receptionist: "Front desk", practitioner: "Team" } },
  features: {},
};

describe("the business words customers receive", () => {
  it("keep the renamed words but leave the staff role names out", () => {
    const profile = profileFromRow(row);
    expect(storedProfileFields(profile).terminology).toHaveProperty("roles");
    const fields = publicProfileFields(profile);
    expect(fields.terminology).toEqual({ customer: { singular: "guest", plural: "guests" } });
    expect(JSON.stringify(fields)).not.toContain("Front desk");
  });

  it("are unchanged when no role was renamed", () => {
    const profile = profileFromRow({ ...row, terminology: { customer: { singular: "guest", plural: "guests" } } });
    expect(publicProfileFields(profile)).toEqual(storedProfileFields(profile));
  });

  it("give customer pages a whole profile with the same words and no role names", () => {
    const profile = profileFromRow(row);
    expect(Object.keys(profile.roleNameOverrides).length).toBeGreaterThan(0);
    const shown = customerProfile(profile);
    expect(shown.roleNameOverrides).toEqual({});
    expect(shown.terms).toEqual(profile.terms);
    const plain = profileFromRow({ ...row, terminology: {} });
    expect(customerProfile(plain)).toBe(plain);
  });
});
