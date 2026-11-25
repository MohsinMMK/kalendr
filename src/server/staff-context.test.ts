import { beforeEach, describe, expect, it, vi } from "vitest";

const inserted = vi.hoisted(() => [] as unknown[]);

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: vi.fn() } }, authIsConfigured: false }));
vi.mock("@/db/client", () => ({
  getDatabase: () => null,
  withTenant: async (_tenantId: string, run: (transaction: unknown) => Promise<unknown>) =>
    run({ insert: () => ({ values: async (values: unknown) => { inserted.push(values); } }) }),
}));

import { resolvePermissions, type StaffRole } from "@/lib/permissions";

import { ApiError } from "./api-error";
import { can, requirePermission, requireRecentStepUp, type StaffContext } from "./staff-context";

function context(role: StaffRole, overrides: unknown = {}, preview = false): StaffContext {
  return {
    tenantId: "tenant",
    clinicSlug: "lotus-dental",
    clinicName: "Lotus Dental Studio",
    role,
    permissions: resolvePermissions(role, overrides),
    membershipId: "membership",
    userId: "user",
    userName: "Staff",
    userEmail: "staff@example.com",
    preview,
  };
}

beforeEach(() => {
  inserted.length = 0;
});

describe("staff permissions", () => {
  it("follows the role preset", () => {
    expect(can(context("receptionist"), "appointments.book")).toBe(true);
    expect(can(context("practitioner"), "appointments.book")).toBe(false);
    expect(can(context("practitioner"), "records.view")).toBe(true);
    expect(can(context("billing"), "appointments.status")).toBe(false);
    expect(can(context("admin"), "settings.manage")).toBe(true);
    expect(can(context("receptionist"), "settings.manage")).toBe(false);
  });

  it("applies per-person overrides on top of the preset", () => {
    const doctor = context("practitioner", { "hours.own": true, "records.view": false });
    expect(can(doctor, "hours.own")).toBe(true);
    expect(can(doctor, "records.view")).toBe(false);
  });

  it("refuses with a 403 and records the attempt", async () => {
    expect(() => requirePermission(context("practitioner"), "appointments.book")).toThrow(ApiError);
    expect(() => requirePermission(context("read_only"), "appointments.status")).toThrow(/permission/);
    expect(() => requirePermission(context("practitioner"), "appointments.status")).not.toThrow();
    await vi.waitFor(() => expect(inserted).toHaveLength(2));
    expect(inserted[0]).toMatchObject({
      action: "staff.permission.refused",
      outcome: "denied",
      metadata: { permission: "appointments.book", role: "practitioner" },
    });
  });

  it("does not log refusals in preview mode", async () => {
    expect(() => requirePermission(context("read_only", {}, true), "team.manage")).toThrow(ApiError);
    await Promise.resolve();
    expect(inserted).toHaveLength(0);
  });
});

describe("step-up", () => {
  const now = new Date("2026-11-19T10:00:00Z");
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  it("passes within ten minutes of a second-factor check", () => {
    expect(() => requireRecentStepUp({ preview: false, secondFactorEnrolled: true, secondFactorAt: minutesAgo(9) }, now)).not.toThrow();
  });

  it("asks for a code after ten minutes, or when this sign-in never used one", () => {
    expect(() => requireRecentStepUp({ preview: false, secondFactorEnrolled: true, secondFactorAt: minutesAgo(11) }, now)).toThrow(expect.objectContaining({ code: "step_up_required", status: 403 }));
    expect(() => requireRecentStepUp({ preview: false, secondFactorEnrolled: true, secondFactorAt: null }, now)).toThrow(expect.objectContaining({ code: "step_up_required" }));
  });

  it("sends someone with no second factor to set one up, and lets preview through", () => {
    expect(() => requireRecentStepUp({ preview: false }, now)).toThrow(expect.objectContaining({ code: "second_factor_required" }));
    expect(() => requireRecentStepUp({ preview: true }, now)).not.toThrow();
  });
});
