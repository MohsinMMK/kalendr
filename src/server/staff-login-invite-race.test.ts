/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db/client", () => ({ withTenant: vi.fn(), requireDatabase: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: {} }));

import type { KalendrTransaction } from "@/db/client";

import { deleteLoginInvite, inviteAcceptedError, loadLoginInvite } from "./staff-login-invites";

/** A transaction that records each delete and answers the invite delete with `removed` rows. */
function fakeTransaction(removed: Array<{ id: string }>) {
  const deletes: string[] = [];
  let count = 0;
  const transaction = {
    delete: () => {
      const which = ++count === 1 ? "invite" : "verification";
      deletes.push(which);
      const node = { where: () => node, returning: async () => removed, then: (resolve: (value: unknown) => unknown) => Promise.resolve([]).then(resolve) };
      return node;
    },
  } as unknown as KalendrTransaction;
  return { transaction, deletes };
}

describe("an invite that was accepted at the same moment", () => {
  it("answers 409 with the refresh message", () => {
    const error = inviteAcceptedError();
    expect(error).toMatchObject({ status: 409, code: "invite_accepted", message: "They just joined. Refresh and try again." });
  });

  it("deletes the invite and its link when the invite row is still there", async () => {
    const { transaction, deletes } = fakeTransaction([{ id: "i1" }]);
    await expect(deleteLoginInvite(transaction, { id: "i1", tenantId: "t1" })).resolves.toBe(true);
    expect(deletes).toEqual(["invite", "verification"]);
  });

  it("reports false and touches nothing else when no invite row was deleted", async () => {
    const { transaction, deletes } = fakeTransaction([]);
    await expect(deleteLoginInvite(transaction, { id: "i1", tenantId: "t1" })).resolves.toBe(false);
    expect(deletes).toEqual(["invite"]);
  });

  it("locks the invite row when asked", async () => {
    const calls: string[] = [];
    const node: Record<string, unknown> = {};
    for (const step of ["from", "where", "limit"]) node[step] = () => node;
    node.for = (strength: string) => { calls.push(strength); return Promise.resolve([{ id: "i1" }]); };
    node.then = (resolve: (value: unknown) => unknown) => { calls.push("plain"); return Promise.resolve([{ id: "i1" }]).then(resolve); };
    const transaction = { select: () => node } as unknown as KalendrTransaction;
    await loadLoginInvite(transaction, "t1", "i1", { lock: true });
    await loadLoginInvite(transaction, "t1", "i1");
    expect(calls).toEqual(["update", "plain"]);
  });
});
