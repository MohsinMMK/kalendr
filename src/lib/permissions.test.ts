import { describe, expect, it } from "vitest";

import { cleanOverrides, hasPermission, permissionKeys, resolvePermissions, rolePresets } from "./permissions";

describe("cleanOverrides", () => {
  it("keeps only overrides that differ from the role's preset", () => {
    expect(cleanOverrides("receptionist", {
      "appointments.book": true,
      "records.view": true,
      "profile.own": false,
    })).toEqual({ "records.view": true, "profile.own": false });
  });

  it("drops unknown keys and non-boolean values", () => {
    expect(cleanOverrides("practitioner", { "made.up": true, "hours.own": "yes", "team.manage": 1 })).toEqual({});
    expect(cleanOverrides("practitioner", null)).toEqual({});
    expect(cleanOverrides("practitioner", "hours.own")).toEqual({});
  });

  it("never gives the owner overrides", () => {
    expect(cleanOverrides("owner", { "team.manage": false })).toEqual({});
  });
});

describe("resolvePermissions", () => {
  it("returns the preset when there are no overrides", () => {
    expect(resolvePermissions("practitioner", {})).toEqual([...rolePresets.practitioner].sort((a, b) => permissionKeys.indexOf(a) - permissionKeys.indexOf(b)));
    expect(resolvePermissions("owner", {})).toEqual([...permissionKeys]);
  });

  it("adds and removes per person", () => {
    const permissions = resolvePermissions("practitioner", { "hours.own": true, "records.view": false });
    expect(permissions).toContain("hours.own");
    expect(permissions).not.toContain("records.view");
  });

  it("gives every role its own profile but nobody else their hours by default", () => {
    for (const role of ["receptionist", "practitioner", "billing", "read_only"] as const) {
      expect(hasPermission(resolvePermissions(role, {}), "profile.own")).toBe(true);
      expect(hasPermission(resolvePermissions(role, {}), "hours.own")).toBe(false);
    }
    expect(hasPermission(undefined, "profile.own")).toBe(false);
  });
});

describe("privacy.manage", () => {
  it("is given to the owner and admins, and to nobody else by default", () => {
    expect(hasPermission(resolvePermissions("owner", {}), "privacy.manage")).toBe(true);
    expect(hasPermission(resolvePermissions("admin", {}), "privacy.manage")).toBe(true);
    for (const role of ["receptionist", "practitioner", "billing", "read_only"] as const) {
      expect(hasPermission(resolvePermissions(role, {}), "privacy.manage")).toBe(false);
    }
  });

  it("can be switched on for one person", () => {
    expect(hasPermission(resolvePermissions("billing", { "privacy.manage": true }), "privacy.manage")).toBe(true);
  });
});

describe("messages.retry", () => {
  it("is given to the owner and admins, and to nobody else by default", () => {
    expect(hasPermission(resolvePermissions("owner", {}), "messages.retry")).toBe(true);
    expect(hasPermission(resolvePermissions("admin", {}), "messages.retry")).toBe(true);
    for (const role of ["receptionist", "practitioner", "billing", "read_only"] as const) {
      expect(hasPermission(resolvePermissions(role, {}), "messages.retry")).toBe(false);
    }
  });

  it("can be switched on for one person", () => {
    expect(hasPermission(resolvePermissions("receptionist", { "messages.retry": true }), "messages.retry")).toBe(true);
  });
});

describe("calendar permissions", () => {
  it("lets staff who take bookings connect their own calendars, and only the owner and admins manage sync", () => {
    for (const role of ["owner", "admin", "receptionist", "practitioner"] as const) {
      expect(hasPermission(resolvePermissions(role, {}), "calendars.own")).toBe(true);
    }
    for (const role of ["billing", "read_only"] as const) {
      expect(hasPermission(resolvePermissions(role, {}), "calendars.own")).toBe(false);
    }
    for (const role of ["owner", "admin"] as const) expect(hasPermission(resolvePermissions(role, {}), "calendars.manage")).toBe(true);
    for (const role of ["receptionist", "practitioner", "billing", "read_only"] as const) {
      expect(hasPermission(resolvePermissions(role, {}), "calendars.manage")).toBe(false);
    }
  });

  it("can be switched on for one person", () => {
    expect(hasPermission(resolvePermissions("billing", { "calendars.own": true }), "calendars.own")).toBe(true);
  });
});

describe("repeating appointments permission", () => {
  it("lets the front desk, owners and admins book and change a series, and nobody else by default", () => {
    for (const role of ["owner", "admin", "receptionist"] as const) {
      expect(hasPermission(resolvePermissions(role, {}), "series.manage")).toBe(true);
    }
    for (const role of ["practitioner", "billing", "read_only"] as const) {
      expect(hasPermission(resolvePermissions(role, {}), "series.manage")).toBe(false);
    }
  });

  it("can be switched on or off for one person", () => {
    expect(hasPermission(resolvePermissions("practitioner", { "series.manage": true }), "series.manage")).toBe(true);
    expect(hasPermission(resolvePermissions("receptionist", { "series.manage": false }), "series.manage")).toBe(false);
  });
});

describe("waitlist permission", () => {
  it("lets the front desk, owners and admins run the waitlist offers, and nobody else by default", () => {
    for (const role of ["owner", "admin", "receptionist"] as const) {
      expect(hasPermission(resolvePermissions(role, {}), "waitlist.manage")).toBe(true);
    }
    for (const role of ["practitioner", "billing", "read_only"] as const) {
      expect(hasPermission(resolvePermissions(role, {}), "waitlist.manage")).toBe(false);
    }
  });

  it("can be switched on or off for one person", () => {
    expect(hasPermission(resolvePermissions("practitioner", { "waitlist.manage": true }), "waitlist.manage")).toBe(true);
    expect(hasPermission(resolvePermissions("receptionist", { "waitlist.manage": false }), "waitlist.manage")).toBe(false);
  });
});

describe("billing.manage (feature 14)", () => {
  it("is the owner's by default and not the admin's", () => {
    expect(resolvePermissions("owner", {})).toContain("billing.manage");
    expect(resolvePermissions("admin", {})).not.toContain("billing.manage");
    expect(resolvePermissions("receptionist", {})).not.toContain("billing.manage");
  });
  it("goes with the billing role, and the owner can hand it to one person", () => {
    expect(resolvePermissions("billing", {})).toContain("billing.manage");
    expect(resolvePermissions("admin", { "billing.manage": true })).toContain("billing.manage");
  });
});

describe("spam.manage and services.manage", () => {
  it("are given to the owner and admins, and to nobody else by default", () => {
    for (const permission of ["spam.manage", "services.manage"] as const) {
      expect(hasPermission(resolvePermissions("owner", {}), permission)).toBe(true);
      expect(hasPermission(resolvePermissions("admin", {}), permission)).toBe(true);
      for (const role of ["receptionist", "practitioner", "billing", "read_only"] as const) {
        expect(hasPermission(resolvePermissions(role, {}), permission)).toBe(false);
      }
    }
  });
});
