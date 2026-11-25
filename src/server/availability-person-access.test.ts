/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db/client", () => ({ withTenant: vi.fn() }));

vi.mock("./staff-context", async () => {
  const { ApiError } = await import("./api-error");
  return {
    can: (context: { permissions: string[] }, permission: string) => context.permissions.includes(permission),
    requirePermission: (context: { permissions: string[] }, permission: string) => {
      if (!context.permissions.includes(permission)) throw new ApiError(403, "forbidden", "No.");
    },
  };
});
vi.mock("./staff-credentials", () => ({ clinicDateKey: vi.fn() }));

import type { KalendrTransaction } from "@/db/client";

import { personAccess } from "./availability-admin";
import type { StaffContext } from "./staff-context";

/** A transaction whose every select resolves to the next queued rows, however the query chain ends. */
function fakeTransaction(...results: unknown[][]): KalendrTransaction {
  const queue = [...results];
  const chain = (): unknown => {
    const rows = queue.shift() ?? [];
    const node: Record<string, unknown> = {};
    for (const step of ["from", "where", "limit", "orderBy"]) node[step] = () => node;
    node.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
    return node;
  };
  return { select: chain } as unknown as KalendrTransaction;
}

const context = (locationIds: string[] | null): StaffContext => ({
  tenantId: "t1", userId: "me", role: "manager", permissions: ["hours.edit", "schedule.read"], locationIds,
} as unknown as StaffContext);

const person = (authUserId: string | null) => [{ id: "p1", authUserId }];

describe("personAccess and branch limits", () => {
  it("refuses a write for a doctor who works at another location", async () => {
    const transaction = fakeTransaction(person("someone"), [{ locationId: "b" }]);
    await expect(personAccess(transaction, context(["a"]), "p1", "write")).rejects.toMatchObject({ status: 403, code: "cannot_manage_location" });
  });

  it("refuses a write for a doctor at both an own and another location, or at none", async () => {
    await expect(personAccess(fakeTransaction(person("x"), [{ locationId: "a" }, { locationId: "b" }]), context(["a"]), "p1", "write")).rejects.toMatchObject({ status: 403 });
    await expect(personAccess(fakeTransaction(person("x"), []), context(["a"]), "p1", "write")).rejects.toMatchObject({ status: 403 });
  });

  it("allows a write when every location of the doctor is the person's own", async () => {
    await expect(personAccess(fakeTransaction(person("x"), [{ locationId: "a" }]), context(["a", "c"]), "p1", "write")).resolves.toMatchObject({ id: "p1" });
  });

  it("hides a doctor at other locations only from a read (404), but keeps one with no locations", async () => {
    await expect(personAccess(fakeTransaction(person("x"), [{ locationId: "b" }]), context(["a"]), "p1", "read")).rejects.toMatchObject({ status: 404, code: "practitioner_not_found" });
    await expect(personAccess(fakeTransaction(person("x"), [{ locationId: "a" }, { locationId: "b" }]), context(["a"]), "p1", "read")).resolves.toBeTruthy();
    await expect(personAccess(fakeTransaction(person("x"), []), context(["a"]), "p1", "read")).resolves.toBeTruthy();
  });

  it("never limits the caller's own profile, or someone with no location limit", async () => {
    await expect(personAccess(fakeTransaction(person("me")), context(["a"]), "p1", "write")).resolves.toBeTruthy();
    await expect(personAccess(fakeTransaction(person("x")), context(null), "p1", "write")).resolves.toBeTruthy();
  });
});
