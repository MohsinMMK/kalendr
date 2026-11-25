import { describe, expect, it } from "vitest";

import { clinicItems } from "@/features/clinic/settings-sections";
import { canOpenPage, holdsAny, settingsSectionPermissions, staffPageIds, staffPageRules, type StaffPageId } from "@/lib/page-access";
import { permissionKeys, resolvePermissions, rolePresets, type StaffRole } from "@/lib/permissions";
import { defaultBusinessProfile, profileWords } from "@/lib/terminology";

const memberPages: StaffPageId[] = ["dashboard", "schedule", "patients", "doctors", "profile", "appointment"];

/** The pages each role preset may open, written out so a change to a preset or a rule shows up as a failing line here. */
const opens: Record<StaffRole, StaffPageId[]> = {
  owner: [...staffPageIds],
  admin: [...staffPageIds],
  receptionist: [...memberPages, "bookings", "appointment-series", "appointment-new", "follow-ups", "classes", "messages", "offers", "billing", "billing-invoice", "reports"],
  practitioner: [...memberPages, "bookings", "appointment-series", "classes", "offers", "reports", "records"],
  billing: [...memberPages, "billing", "billing-invoice", "reports"],
  read_only: [...memberPages],
};

describe("which staff pages each role may open", () => {
  for (const role of Object.keys(opens) as StaffRole[]) {
    it(`${role}: opens exactly its pages`, () => {
      const permissions = resolvePermissions(role, {});
      const allowed = staffPageIds.filter((page) => canOpenPage(permissions, page));
      expect(allowed.toSorted()).toEqual([...new Set(opens[role])].toSorted());
    });
  }

  it("every role can open the dashboard, so nobody lands on a refusal after signing in", () => {
    for (const role of Object.keys(rolePresets) as StaffRole[]) expect(canOpenPage(resolvePermissions(role, {}), "dashboard")).toBe(true);
    // Even a person stripped of every permission, or on a custom role with none, still has it.
    expect(canOpenPage([], "dashboard")).toBe(true);
    expect(canOpenPage(resolvePermissions("admin", Object.fromEntries(permissionKeys.map((key) => [key, false]))), "dashboard")).toBe(true);
  });

  it("a per-person override opens and closes a page", () => {
    expect(canOpenPage(resolvePermissions("read_only", { "campaigns.manage": true }), "campaigns")).toBe(true);
    expect(canOpenPage(resolvePermissions("receptionist", { "inbox.reply": false, "appointments.book": false }), "messages")).toBe(false);
    expect(canOpenPage(resolvePermissions("receptionist", { "inbox.reply": false }), "messages")).toBe(true);
  });

  it("settings opens for anyone who may open one of its sections, and for nobody else", () => {
    expect(canOpenPage(resolvePermissions("read_only", { "hours.edit": true }), "settings")).toBe(true);
    expect(canOpenPage(resolvePermissions("receptionist", { "privacy.manage": true }), "settings")).toBe(true);
    expect(canOpenPage(resolvePermissions("receptionist", {}), "settings")).toBe(false);
    expect(canOpenPage(resolvePermissions("billing", {}), "settings")).toBe(false);
  });

  it("holdsAny is true only when one of the wanted permissions is held", () => {
    expect(holdsAny(["appointments.book"], ["inbox.reply", "appointments.book"])).toBe(true);
    expect(holdsAny(["profile.own"], ["inbox.reply"])).toBe(false);
    expect(holdsAny([], ["inbox.reply"])).toBe(false);
  });

  it("every page has a rule and every rule names real permissions", () => {
    for (const page of staffPageIds) {
      const rule = staffPageRules[page];
      if (rule !== "member") for (const permission of rule.anyOf) expect(permissionKeys).toContain(permission);
    }
  });
});

describe("the settings sections", () => {
  it("the permissions that open the Settings page are exactly the ones its sections ask for", () => {
    const asked = new Set(clinicItems(profileWords(defaultBusinessProfile)).map((item) => item.permission));
    expect([...asked].toSorted()).toEqual([...settingsSectionPermissions].toSorted());
  });
});
