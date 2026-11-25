import { describe, expect, it } from "vitest";

import { roleDescriptionsFor, roleLabelsFor, rolePresets } from "./permissions";
import {
  cleanRoleNames,
  cleanStoredTerminology,
  maxTermLength,
  resolveBusinessProfile,
  roleNameKeys,
  storedTerminologyOf,
} from "./terminology";

describe("role names", () => {
  it("covers exactly the staff roles", () => {
    expect([...roleNameKeys].sort()).toEqual(Object.keys(rolePresets).sort());
  });

  it("keeps the standard names until a business renames a role", () => {
    const labels = roleLabelsFor(resolveBusinessProfile({ businessType: "wellness" }));
    expect(labels).toEqual({ owner: "Owner", admin: "Admin", receptionist: "Receptionist", practitioner: "Stylist", billing: "Billing", read_only: "Read only" });
  });

  it("uses the business's own name for a renamed role and leaves the others", () => {
    const profile = resolveBusinessProfile({ businessType: "wellness", terminology: { roles: { receptionist: "Front desk", practitioner: "Team" } } });
    const labels = roleLabelsFor(profile);
    expect(labels.receptionist).toBe("Front desk");
    expect(labels.practitioner).toBe("Team");
    expect(labels.owner).toBe("Owner");
    expect(profile.roleNameOverrides).toEqual({ receptionist: "Front desk", practitioner: "Team" });
  });

  it("does not change what a role may do or how it is described", () => {
    const before = resolveBusinessProfile({ businessType: "wellness" });
    const after = resolveBusinessProfile({ businessType: "wellness", terminology: { roles: { admin: "Manager" } } });
    expect(roleDescriptionsFor(after)).toEqual(roleDescriptionsFor(before));
    expect(Object.keys(rolePresets)).toContain("admin");
  });

  it("cleans names: trims, folds spaces, drops blanks, long names, unknown roles and non-text", () => {
    expect(cleanRoleNames({
      owner: "  Head   of   house ",
      admin: "   ",
      receptionist: "x".repeat(maxTermLength + 1),
      practitioner: "x".repeat(maxTermLength),
      billing: 7,
      read_only: null,
      janitor: "Janitor",
    })).toEqual({ owner: "Head of house", practitioner: "x".repeat(maxTermLength) });
    expect(cleanRoleNames(null)).toEqual({});
    expect(cleanRoleNames(["owner"])).toEqual({});
  });

  it("puts the standard name back when a name is emptied", () => {
    const saved = cleanStoredTerminology({ roles: { receptionist: "Front desk" } });
    const emptied = cleanStoredTerminology({ ...saved, roles: { ...saved.roles, receptionist: "" } });
    expect(emptied.roles).toBeUndefined();
    expect(roleLabelsFor(resolveBusinessProfile({ businessType: "wellness", terminology: emptied })).receptionist).toBe("Receptionist");
  });

  it("is stored beside the words and survives a round trip", () => {
    const profile = resolveBusinessProfile({
      businessType: "wellness",
      terminology: { provider: { singular: "Team member", plural: "Team" }, roles: { admin: "Manager" } },
    });
    const stored = storedTerminologyOf(profile);
    expect(stored).toEqual({ provider: { singular: "Team member", plural: "Team" }, roles: { admin: "Manager" } });
    expect(resolveBusinessProfile({ businessType: "wellness", terminology: stored }).roleNameOverrides).toEqual({ admin: "Manager" });
  });

  it("stores no roles key when none were renamed", () => {
    expect(storedTerminologyOf(resolveBusinessProfile({ businessType: "wellness", terminology: { roles: { owner: " " } } }))).toEqual({});
  });
});
