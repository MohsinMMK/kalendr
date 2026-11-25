/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StaffTeamMember } from "@/lib/staff-snapshot";

import { MemberActionDialogs, type MemberActionKind } from "./team-member-actions";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const member = (overrides: Partial<StaffTeamMember> = {}): StaffTeamMember => ({
  membershipId: "m1", userId: "u1", email: "front@example.com", name: "Farah Desk", role: "receptionist", isActive: true, practitionerId: null,
  permissionOverrides: {}, permissions: [], invitePending: false, invitedAt: null, ...overrides,
});

function setup(kind: MemberActionKind, person: StaffTeamMember, answer: () => Response) {
  const fetchMock = vi.fn(async () => answer());
  vi.stubGlobal("fetch", fetchMock);
  const onClose = vi.fn();
  const onDone = vi.fn(async () => undefined);
  render(<MemberActionDialogs action={{ kind, member: person }} onClose={onClose} onDone={onDone} />);
  return { fetchMock, onClose, onDone };
}

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

describe("team member actions", () => {
  it("asks before removing, then posts and reports the bookings that wait", async () => {
    const { fetchMock, onClose, onDone } = setup("remove", member({ practitionerId: "p1" }), () => ok({ futureBookings: 3 }));
    expect(screen.getByRole("alertdialog", { name: "Remove Farah Desk from the team?" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Remove from team" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/staff/team/members/m1/remove");
    expect(init.method).toBe("POST");
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ title: "Farah Desk was removed", description: expect.stringContaining("3 upcoming") }));
    expect(onClose).toHaveBeenCalled();
  });

  it("cancels an invite through its own route", async () => {
    const { fetchMock, onDone } = setup("cancel_invite", member({ invitePending: true }), () => ok({}));
    await userEvent.click(screen.getByRole("button", { name: "Cancel invite" }));
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("/api/staff/team/members/m1/cancel-invite");
    expect(onDone).toHaveBeenCalledWith({ title: "The invite for Farah Desk was cancelled" });
  });

  it("shows the server's refusal and stays open", async () => {
    const { onClose, onDone } = setup("remove", member(), () => new Response(JSON.stringify({ error: { code: "owner_only", message: "Only the owner can do this to an owner." } }), { status: 403 }));
    await userEvent.click(screen.getByRole("button", { name: "Remove from team" }));
    expect(await screen.findByText("Only the owner can do this to an owner.")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("won't hand the business to someone without a second factor", () => {
    const { fetchMock } = setup("transfer", member({ secondFactor: false }), () => ok({}));
    expect(screen.getByRole("button", { name: "Make owner" })).toBeDisabled();
    expect(screen.getByText(/needs an authenticator app or a passkey/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hands over ownership with the chosen person", async () => {
    const { fetchMock } = setup("transfer", member({ secondFactor: true }), () => ok({}));
    await userEvent.click(screen.getByRole("button", { name: "Make owner" }));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/staff/team/ownership");
    expect(JSON.parse(String(init.body))).toEqual({ membershipId: "m1" });
  });
});
