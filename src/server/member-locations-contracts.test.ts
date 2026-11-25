import { describe, expect, it } from "vitest";

import { staffCreateMemberSchema, staffUpdateMemberSchema } from "./contracts";

describe("location limits in the team contracts", () => {
  it("takes a list of location ids when someone is invited", () => {
    const parsed = staffCreateMemberSchema.parse({ name: "Asha Rao", email: "asha@example.com", role: "receptionist", locationIds: ["loc-a"] });
    expect(parsed.locationIds).toEqual(["loc-a"]);
    expect(staffCreateMemberSchema.parse({ name: "Asha Rao", email: "asha@example.com", role: "receptionist" }).locationIds).toBeUndefined();
  });

  it("counts a location change on its own as a change, and an empty list as lifting the limit", () => {
    expect(staffUpdateMemberSchema.parse({ locationIds: ["loc-a", "loc-b"] })).toEqual({ locationIds: ["loc-a", "loc-b"] });
    expect(staffUpdateMemberSchema.parse({ locationIds: [] })).toEqual({ locationIds: [] });
    expect(staffUpdateMemberSchema.safeParse({}).success).toBe(false);
  });

  it("refuses ids that are not plain identifiers and lists that are too long", () => {
    expect(staffUpdateMemberSchema.safeParse({ locationIds: [""] }).success).toBe(false);
    expect(staffUpdateMemberSchema.safeParse({ locationIds: ["a b; drop table"] }).success).toBe(false);
    expect(staffUpdateMemberSchema.safeParse({ locationIds: Array.from({ length: 51 }, (_, index) => `loc-${index}`) }).success).toBe(false);
    expect(staffUpdateMemberSchema.safeParse({ locationIds: "loc-a" }).success).toBe(false);
  });
});
