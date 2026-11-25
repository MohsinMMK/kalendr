/** @vitest-environment node */

import { describe, expect, it } from "vitest";

import { enrolSchema, walkInSchema } from "@/lib/classes-contracts";
import { publicWaitlistSchema } from "@/lib/waitlist-contracts";
import { newCustomerBody } from "@/server/api-v1-contracts";
import { staffPatientCreateInput, staffPatientUpdateInput } from "@/server/staff-operations";

describe("a one-word customer name", () => {
  it("can be saved by staff", () => {
    expect(staffPatientCreateInput.shape.lastName.safeParse("").success).toBe(true);
    expect(staffPatientUpdateInput.safeParse({ lastName: "" }).success).toBe(true);
  });

  it("can be created through the API", () => {
    const parsed = newCustomerBody.safeParse({ firstName: "Priya", phone: "+919845012345", email: "p@example.com" });
    expect(parsed.success && parsed.data.lastName).toBe("");
  });

  it("is accepted for a class seat and the waitlist", () => {
    expect(walkInSchema.safeParse({ firstName: "Priya", lastName: "", phone: "+919845012345" }).success).toBe(true);
    expect(enrolSchema.shape.lastName.safeParse("").success).toBe(true);
    expect(publicWaitlistSchema.shape.lastName.safeParse("").success).toBe(true);
  });
});
