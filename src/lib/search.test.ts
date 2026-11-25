import { describe, expect, it } from "vitest";

import { resolvePermissions, type StaffRole } from "./permissions";
import { SEARCH_MAX_LENGTH, normaliseSearchQuery, searchIsOwnOnly, searchKindsFor, staffSearchQuerySchema } from "./search";

const kinds = (role: StaffRole) => searchKindsFor(resolvePermissions(role, {}));

describe("search text", () => {
  it("trims, collapses spaces and caps the length", () => {
    expect(normaliseSearchQuery("  Asha   Rao ")).toBe("Asha Rao");
    expect(normaliseSearchQuery("x".repeat(500))).toHaveLength(SEARCH_MAX_LENGTH);
  });
  it("turns control characters into spaces, so a NUL byte never reaches the database", () => {
    expect(normaliseSearchQuery("a\u0000b\tc")).toBe("a b c");
  });
  it("needs two characters", () => {
    expect(staffSearchQuerySchema.safeParse({ q: "a" }).success).toBe(false);
    expect(staffSearchQuerySchema.safeParse({ q: "   a  " }).success).toBe(false);
    expect(staffSearchQuerySchema.safeParse({ q: "ab" }).success).toBe(true);
  });
  it("caps the number of results per kind", () => {
    expect(staffSearchQuerySchema.parse({ q: "ab" }).limit).toBe(5);
    expect(staffSearchQuerySchema.safeParse({ q: "ab", limit: "50" }).success).toBe(false);
  });
});

describe("what each role may find", () => {
  it("lets owners and admins find everything", () => {
    expect(kinds("owner")).toEqual(["customer", "appointment", "service", "person", "invoice", "campaign", "routing_form"]);
    expect(kinds("admin")).toEqual(["customer", "appointment", "service", "person", "invoice", "campaign", "routing_form"]);
  });
  it("keeps campaigns to people who run them", () => {
    expect(kinds("receptionist")).not.toContain("campaign");
    expect(kinds("receptionist")).toContain("invoice");
  });
  it("keeps invoices away from people who cannot issue or read money", () => {
    expect(kinds("practitioner")).not.toContain("invoice");
    expect(kinds("practitioner")).not.toContain("campaign");
  });
  it("gives billing customers and invoices but not the schedule", () => {
    expect(kinds("billing")).toEqual(["customer", "invoice"]);
  });
  it("shows a read-only account nothing", () => {
    expect(kinds("read_only")).toEqual([]);
  });
  it("narrows only team members to their own records", () => {
    expect(searchIsOwnOnly("practitioner")).toBe(true);
    for (const role of ["owner", "admin", "receptionist", "billing", "read_only"] as const) expect(searchIsOwnOnly(role)).toBe(false);
  });
});
