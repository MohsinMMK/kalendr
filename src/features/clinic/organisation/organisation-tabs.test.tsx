/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StaffAccessProvider } from "../staff-access";
import { RolesTab } from "./roles-tab";
import { SignInTab } from "./sign-in-tab";
import { TeamsTab } from "./teams-tab";

vi.mock("../clinic-catalog", () => ({ useCatalogLookups: () => ({ database: true, clinic: { slug: "lotus" }, locations: [{ id: "l1", name: "Main" }], locationName: () => "Main" }) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function wrap(children: ReactNode, permissions: readonly string[] = ["org.manage", "appointments.book", "appointments.status"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StaffAccessProvider role="admin" permissions={permissions as never} userId="u1">{children}</StaffAccessProvider>
    </QueryClientProvider>,
  );
}

function respond(routes: Record<string, { status?: number; data?: unknown; error?: { code: string; message: string } }>) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    const match = Object.entries(routes).find(([route]) => path.startsWith(route));
    const hit = match?.[1] ?? { status: 404, error: { code: "not_found", message: "Not found." } };
    return { ok: (hit.status ?? 200) < 400, status: hit.status ?? 200, json: async () => (hit.error ? { error: hit.error } : { data: hit.data }) } as Response;
  }));
}

describe("Organisation screens", () => {
  it("roles: an empty list invites the first role, and the editor greys out permissions the author does not hold", async () => {
    respond({ "/api/staff/roles": { data: [] } });
    wrap(<RolesTab />);
    expect(await screen.findByText("No custom roles yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New role" }));
    const dialog = await screen.findByRole("dialog", { name: "New role" });
    // The author holds booking but not payments, so payments cannot be ticked, and the reason is given.
    expect(within(dialog).getByRole("checkbox", { name: /^Book and change (?!repeating)/ })).not.toHaveAttribute("data-disabled");
    expect(within(dialog).getByRole("checkbox", { name: /Take payments/ })).toHaveAttribute("data-disabled");
    expect(within(dialog).getAllByText(/You don't have this permission yourself/).length).toBeGreaterThan(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Make role" }));
    expect(await within(dialog).findByText("Enter at least 2 characters.")).toBeInTheDocument();
  });

  it("roles: lists a role with what it starts as, its size and its holders", async () => {
    respond({ "/api/staff/roles": { data: [{ id: "r1", name: "Front desk", description: "Books and checks in", baseRole: "receptionist", permissions: ["appointments.book", "appointments.status"], version: 1, memberCount: 3 }] } });
    wrap(<RolesTab />);
    const list = await screen.findByRole("list", { name: "Custom roles" });
    expect(within(list).getByText("Front desk")).toBeInTheDocument();
    expect(within(list).getByText("Starts as Receptionist")).toBeInTheDocument();
    expect(within(list).getByText("2 permissions")).toBeInTheDocument();
    expect(within(list).getByText("3 people")).toBeInTheDocument();
  });

  it("roles: a failed load says so and can be retried; a plan refusal is explained, not retried", async () => {
    respond({ "/api/staff/roles": { status: 500, error: { code: "server", message: "Roles are unavailable." } } });
    const first = wrap(<RolesTab />);
    expect(await screen.findByText("Roles could not be loaded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    first.unmount();
    respond({ "/api/staff/roles": { status: 402, error: { code: "plan_limit", message: "Custom roles are on the Scale plan." } } });
    wrap(<RolesTab />);
    expect(await screen.findByText("Part of a higher plan")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("teams: shows nesting, privacy and the page address", async () => {
    respond({ "/api/staff/teams": { data: [
      { id: "t1", name: "Dermatology", slug: "dermatology", description: null, parentTeamId: null, locationId: null, isPrivate: false, isActive: true, version: 1, memberCount: 2, membershipIds: [] },
      { id: "t2", name: "Cosmetic", slug: "cosmetic", description: null, parentTeamId: "t1", locationId: "l1", isPrivate: true, isActive: true, version: 1, memberCount: 1, membershipIds: [] },
    ] } });
    wrap(<TeamsTab />);
    const list = await screen.findByRole("list", { name: "Teams" });
    const cosmetic = within(list).getByText("Cosmetic").closest("li")!;
    expect(within(cosmetic).getByText("Under Dermatology")).toBeInTheDocument();
    expect(within(cosmetic).getByText("Private")).toBeInTheDocument();
    expect(within(cosmetic).getByText("Main")).toBeInTheDocument();
    expect(within(list).getByText("Dermatology").closest("li")).not.toHaveTextContent("Private");
  });

  it("sign-in: a domain waiting for DNS says what we saw, and a proved one offers the connection", async () => {
    respond({ "/api/staff/org/domains": { data: [
      { id: "d1", domain: "clinic.com", verified: false, verifiedAt: null, lastCheckedAt: "2026-11-19T10:00:00.000Z", lastCheckNote: "We can't see the record yet. DNS changes can take up to an hour.", autoJoinEnabled: false, autoJoinRole: "read_only", requireSso: false, version: 1, connection: null },
      { id: "d2", domain: "group.org", verified: true, verifiedAt: "2026-11-18T10:00:00.000Z", lastCheckedAt: null, lastCheckNote: null, autoJoinEnabled: false, autoJoinRole: "read_only", requireSso: false, version: 2, connection: null, breakGlassName: null },
    ] } });
    wrap(<SignInTab />);
    expect(await screen.findByText("Waiting for the DNS record")).toBeInTheDocument();
    expect(screen.getByText(/can't see the record yet/)).toBeInTheDocument();
    expect(screen.getByText("Proved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Connect/ })).toBeInTheDocument();
    // Requiring company sign-in is not offered until a connection is switched on.
    await waitFor(() => expect(screen.getByRole("switch", { name: /Require company sign-in/ })).toHaveAttribute("data-disabled"));
  });
});
