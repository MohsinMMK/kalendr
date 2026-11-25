import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolvePermissions, type StaffRole } from "@/lib/permissions";

const state = vi.hoisted(() => ({ context: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));
vi.mock("./staff-context", () => ({ requireStaffPageContext: async () => state.context }));

import { permissionDeniedPath, requirePageAccess, requirePagePermission } from "./staff-page-guard";

function asRole(role: StaffRole, overrides: Record<string, boolean> = {}) {
  state.context = { role, permissions: resolvePermissions(role, overrides), tenantId: "t", preview: false };
}

beforeEach(() => { state.context = null; });

describe("requirePagePermission", () => {
  it("returns the signed-in person's context when they hold the permission", async () => {
    asRole("receptionist");
    await expect(requirePagePermission("inbox.reply")).resolves.toMatchObject({ role: "receptionist" });
  });

  it("sends a person without it to access-denied, with the permission reason", async () => {
    asRole("practitioner");
    await expect(requirePagePermission("campaigns.manage")).rejects.toThrow(`redirect:${permissionDeniedPath}`);
    expect(permissionDeniedPath).toBe("/access-denied?reason=permission");
  });

  it("opens when any one of several permissions is held", async () => {
    asRole("receptionist");
    await expect(requirePagePermission(["campaigns.manage", "appointments.book"])).resolves.toBeDefined();
    await expect(requirePagePermission(["campaigns.manage", "spam.manage"])).rejects.toThrow("redirect:");
  });

  it("follows a per-person override either way", async () => {
    asRole("read_only", { "spam.manage": true });
    await expect(requirePagePermission("spam.manage")).resolves.toBeDefined();
    asRole("admin", { "spam.manage": false });
    await expect(requirePagePermission("spam.manage")).rejects.toThrow("redirect:");
  });
});

describe("requirePageAccess", () => {
  it("lets every role into a member page", async () => {
    for (const role of ["owner", "admin", "receptionist", "practitioner", "billing", "read_only"] as const) {
      asRole(role);
      await expect(requirePageAccess("dashboard")).resolves.toBeDefined();
    }
  });

  it("refuses a restricted role at each guarded page and lets the right role in", async () => {
    asRole("read_only");
    for (const page of ["bookings", "classes", "follow-ups", "messages", "settings", "settings-import", "settings-privacy-requests", "appointment-new", "appointment-series", "campaigns", "billing", "reports", "records", "activity"] as const) {
      await expect(requirePageAccess(page), page).rejects.toThrow(`redirect:${permissionDeniedPath}`);
    }
    asRole("admin");
    await expect(requirePageAccess("settings")).resolves.toBeDefined();
    asRole("receptionist");
    await expect(requirePageAccess("messages")).resolves.toBeDefined();
    await expect(requirePageAccess("settings")).rejects.toThrow("redirect:");
  });
});
