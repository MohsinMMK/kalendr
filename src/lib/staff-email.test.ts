import { describe, expect, it } from "vitest";

import {
  accountEmailNoticePayloadSchema,
  accountEmailNoticeSecretSchema,
  staffMemberEmailChangeSchema,
  staffOwnEmailChangeSchema,
} from "./staff-email";

describe("staff email change schemas", () => {
  it("trims and lower-cases the new address", () => {
    expect(staffOwnEmailChangeSchema.parse({ newEmail: "  Asha.Rao@Example.COM " })).toEqual({ newEmail: "asha.rao@example.com" });
    expect(staffMemberEmailChangeSchema.parse({ newEmail: "Ravi@Clinic.in" })).toEqual({ newEmail: "ravi@clinic.in" });
  });

  it("says what is wrong in plain words", () => {
    const result = staffOwnEmailChangeSchema.safeParse({ newEmail: "not an email" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("Enter a full email address, like name@example.com.");
    expect(staffOwnEmailChangeSchema.safeParse({ newEmail: `${"a".repeat(250)}@example.com` }).success).toBe(false);
  });

  it("refuses extra fields, so a caller can't slip in an id or a role", () => {
    expect(staffMemberEmailChangeSchema.safeParse({ newEmail: "a@b.co", userId: "someone-else" }).success).toBe(false);
    expect(staffOwnEmailChangeSchema.safeParse({}).success).toBe(false);
  });

  it("only knows the four notice kinds, and the sealed address is not in the queued payload", () => {
    expect(accountEmailNoticePayloadSchema.safeParse({ kind: "changed", sealed: "l1.abc" }).success).toBe(true);
    expect(accountEmailNoticePayloadSchema.safeParse({ kind: "something_else", sealed: "l1.abc" }).success).toBe(false);
    expect(Object.keys(accountEmailNoticePayloadSchema.shape)).toEqual(["kind", "sealed"]);
    expect(accountEmailNoticeSecretSchema.safeParse({ email: "a@b.co", name: "A", business: "B", when: "now" }).success).toBe(true);
  });
});
