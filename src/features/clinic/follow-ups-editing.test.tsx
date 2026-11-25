/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FollowUpsWorkspace, recallMoves, waitlistMoves } from "./follow-ups-workspace";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => { cleanup(); window.sessionStorage.clear(); });

async function openRecalls() {
  const user = userEvent.setup();
  render(<FollowUpsWorkspace />);
  await user.click(screen.getByRole("tab", { name: /Recalls/ }));
  return user;
}

describe("follow-ups in-place editing (preview)", () => {
  it("offers every sensible status move except the current one", () => {
    const labels = (items: ReturnType<typeof recallMoves>) => items.map((item) => ("label" in item ? item.label : ""));
    expect(labels(recallMoves("overdue", vi.fn()))).toEqual(["Mark contacted", "Snooze", "Mark booked", "Close"]);
    expect(labels(recallMoves("closed", vi.fn()))).toContain("Reopen as due");
    expect(labels(waitlistMoves("active", vi.fn()))).toEqual(["Mark offered", "Mark fulfilled", "Expire", "Decline"]);
    expect(labels(waitlistMoves("declined", vi.fn()))).toContain("Reactivate");
  });

  it("moves a recall to booked from its menu", async () => {
    const user = await openRecalls();
    await user.click(screen.getByRole("button", { name: "Change status for Varun Gupta" }));
    await user.click(await screen.findByRole("menuitem", { name: "Mark booked" }));
    const row = screen.getByRole("button", { name: "Review Varun Gupta" }).closest("tr") as HTMLElement;
    await waitFor(() => expect(within(row).getAllByText("Booked").length).toBeGreaterThan(0));
  });

  it("changes a recall due date in place", async () => {
    const user = await openRecalls();
    await user.click(screen.getByRole("button", { name: /Change due date for Sneha .*currently 31 Aug/ }));
    const input = await screen.findByLabelText("Due date");
    fireEvent.change(input, { target: { value: "2026-10-05" } });
    await user.click(screen.getByRole("button", { name: "Save due date" }));
    expect(await screen.findByRole("button", { name: /Change due date for Sneha .*currently 5 Oct/ })).toBeInTheDocument();
  });

  it("changes a waitlist date range in place and rejects an end before the start", async () => {
    const user = userEvent.setup();
    render(<FollowUpsWorkspace />);
    await user.click(screen.getByRole("button", { name: /Change wanted dates for Sara Ahmed/ }));
    fireEvent.change(await screen.findByLabelText("Wanted to"), { target: { value: "2020-01-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent("End date must be on or after");
    expect(screen.getByRole("button", { name: "Save wanted dates" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Wanted to"), { target: { value: "2027-01-01" } });
    await user.click(screen.getByRole("button", { name: "Save wanted dates" }));
    expect(await screen.findByRole("button", { name: /Change wanted dates for Sara Ahmed.* to 1 Jan/ })).toBeInTheDocument();
  });
});
