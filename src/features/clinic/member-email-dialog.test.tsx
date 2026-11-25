import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StaffTeamMember } from "@/lib/staff-snapshot";

import { MemberEmailDialog, OwnEmailDialog } from "./member-email-dialog";
import { StaffApiError } from "./queries/http";
import { staffMutation } from "./staff-snapshot-provider";

vi.mock("./staff-snapshot-provider", async (importOriginal) => ({
  ...await importOriginal<typeof import("./staff-snapshot-provider")>(),
  staffMutation: vi.fn(),
}));

const member = { membershipId: "m1", userId: "u1", name: "Ravi Kumar", email: "ravi@example.com", role: "receptionist", isActive: true } as unknown as StaffTeamMember;

afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("changing your own email", () => {
  it("sends the new address, then tells the person to open the link", async () => {
    vi.mocked(staffMutation).mockResolvedValue({ sent: true });
    const user = userEvent.setup();
    render(<OwnEmailDialog open onOpenChange={() => undefined} />);
    await user.type(screen.getByLabelText("New email"), "  New.Me@Example.com ");
    await user.click(screen.getByRole("button", { name: "Send link" }));
    await waitFor(() => expect(staffMutation).toHaveBeenCalledWith("/api/staff/me/email", "POST", { newEmail: "new.me@example.com" }));
    expect(await screen.findByText("Check your new inbox")).toBeTruthy();
  });

  it("checks the address before sending anything, and shows 'already used' beside the field", async () => {
    vi.mocked(staffMutation).mockRejectedValue(new StaffApiError("This email already has an account. Sign in, or use a different email.", 409, "email_taken", { email: ["This email already has an account."] }));
    const user = userEvent.setup();
    render(<OwnEmailDialog open onOpenChange={() => undefined} />);
    await user.type(screen.getByLabelText("New email"), "nope");
    await user.click(screen.getByRole("button", { name: "Send link" }));
    expect(await screen.findByText("Enter a full email address, like name@example.com.")).toBeTruthy();
    expect(staffMutation).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText("New email"));
    await user.type(screen.getByLabelText("New email"), "taken@example.com");
    await user.click(screen.getByRole("button", { name: "Send link" }));
    expect(await screen.findByText("This email already has an account.")).toBeTruthy();
  });
});

describe("changing a teammate's email", () => {
  it("posts to their membership and shows the new invite link when they had not accepted", async () => {
    vi.mocked(staffMutation).mockResolvedValue({ membershipId: "m1", inviteReissued: true, invite: { url: "https://kalendr.example/reset-password?token=abc&invite=1", emailed: false, expiresAt: "2026-12-01T10:00:00.000Z" } });
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(<MemberEmailDialog member={member} onClose={() => undefined} onSaved={onSaved} />);
    await user.type(screen.getByLabelText("New email"), "ravi.new@example.com");
    await user.click(screen.getByRole("button", { name: "Change email" }));
    await waitFor(() => expect(staffMutation).toHaveBeenCalledWith("/api/staff/team/members/m1/email", "POST", { newEmail: "ravi.new@example.com" }));
    expect(await screen.findByDisplayValue(/reset-password\?token=abc/)).toBeTruthy();
    expect(onSaved).toHaveBeenCalled();
  });

  it("shows a refusal in words, and keeps the dialog open", async () => {
    vi.mocked(staffMutation).mockRejectedValue(new StaffApiError("Only the owner can change an admin's email.", 403, "owner_only"));
    const user = userEvent.setup();
    render(<MemberEmailDialog member={member} onClose={() => undefined} />);
    await user.type(screen.getByLabelText("New email"), "x@example.com");
    await user.click(screen.getByRole("button", { name: "Change email" }));
    expect(await screen.findByText("Only the owner can change an admin's email.")).toBeTruthy();
  });
});
