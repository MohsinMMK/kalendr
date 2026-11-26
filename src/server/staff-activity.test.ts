import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db/client", () => ({ withTenant: vi.fn(), getDatabase: () => null }));
vi.mock("./staff-context", () => ({ requirePermission: vi.fn() }));

import { resolveBusinessProfile } from "@/lib/terminology";

import { describeActivity } from "./staff-activity";

describe("describeActivity", () => {
  it("spells out a role change and the permissions that moved", () => {
    expect(describeActivity("staff.member.role_changed", {
      name: "Asha Rao",
      role: { from: "receptionist", to: "practitioner" },
      granted: ["records.view"],
      revoked: ["appointments.book"],
    })).toEqual({
      summary: "Changed Asha Rao's role",
      changes: ["Role: Receptionist → Doctor", "Allowed: Open patient records", "Taken away: Book and change visits"],
    });
  });

  it("uses a salon's own words for roles and permissions", () => {
    const salon = resolveBusinessProfile({ businessType: "wellness" });
    const result = describeActivity("staff.member.role_changed", {
      name: "Tara Iyer",
      role: { from: "receptionist", to: "practitioner" },
      revoked: ["appointments.book"],
    }, salon);
    expect(result.changes).toEqual(["Role: Receptionist → Stylist", "Taken away: Book and change appointments"]);
    expect(JSON.stringify(result)).not.toMatch(/doctor|patient|visit/i);
  });

  it("notes that deactivation signs the person out", () => {
    expect(describeActivity("staff.member.deactivated", { name: "Asha Rao" }).changes[0]).toBe("Signed out on every device");
  });

  it("names a job title change in words, never the field's code", () => {
    expect(describeActivity("staff.member.job_title_changed", { name: "Asha Rao", changed: ["jobTitle"] }).summary).toBe("Changed Asha Rao's job title");
    expect(describeActivity("staff.profile.updated", { self: true, name: "Asha Rao", changed: ["jobTitle"] }).summary).not.toMatch(/jobTitle/);
  });

  it("says which locations changed, counted, since the row keeps ids only", () => {
    expect(describeActivity("staff.member.locations_changed", { name: "Asha Rao", locations: { from: [], to: ["loc_a"] } })).toEqual({
      summary: "Changed which locations Asha Rao works at",
      changes: ["Locations: Every location → 1 location"],
    });
    expect(describeActivity("staff.member.locations_changed", { name: "Asha Rao", locations: { from: ["loc_a"], to: ["loc_a", "loc_b"] } }).changes)
      .toEqual(["Locations: 1 location → 2 locations"]);
  });

  it("describes self-service profile edits", () => {
    expect(describeActivity("staff.practitioner.updated", { self: true, name: "Dr Iyer", changed: ["hours"] }).summary).toBe("Updated their own working hours");
    expect(describeActivity("staff.profile.updated", { self: true, name: "Asha", changed: ["name"] }).summary).toBe("Updated their own profile");
  });

  it("names the refused permission", () => {
    const entry = describeActivity("staff.permission.refused", { permission: "team.manage", role: "receptionist" });
    expect(entry.summary).toMatch(/^Was refused: /);
    expect(entry.changes).toEqual(["Signed in as Receptionist"]);
  });

  it("falls back to the action code for unknown events", () => {
    expect(describeActivity("something.new", {})).toEqual({ summary: "something.new", changes: [] });
  });

  it("words Kalendr support sessions and pauses for the business owner", () => {
    expect(describeActivity("support.session.started", { write: false }).summary).toBe("Kalendr support started a session (read-only)");
    expect(describeActivity("support.session.started", { write: true }).summary).toBe("Kalendr support started a session (changes allowed)");
    expect(describeActivity("support.session.ended", {}).summary).toBe("Kalendr support ended a session");
    expect(describeActivity("support.business.paused", {}).summary).toBe("Kalendr support paused this business");
    expect(describeActivity("support.business.resumed", {}).summary).toBe("Kalendr support resumed this business");
  });
});
