/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoPatients, demoSlots, demoWaitlist } from "@/lib/demo-data";
import { staffSnapshotFixture } from "@/test/staff-fixture";
import { TestQueryProvider } from "@/test/query-wrapper";

import { FollowUpsWorkspace } from "./follow-ups-workspace";
import { StaffAccessProvider } from "./staff-access";
import { fetchAvailabilitySlots, staffMutation } from "./staff-snapshot-provider";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const refresh = vi.fn();
const staff = {
  snapshot: { ...staffSnapshotFixture, patients: demoPatients, waitlist: demoWaitlist },
  loading: false, error: "", role: "receptionist" as const, refresh,
};
vi.mock("./staff-snapshot-provider", async (importOriginal) => ({
  ...await importOriginal<typeof import("./staff-snapshot-provider")>(),
  useOptionalStaffSnapshot: () => staff,
  fetchAvailabilitySlots: vi.fn(),
  staffMutation: vi.fn(),
  staffQuery: vi.fn(async () => ({ orderRule: "longest_waiting", services: [], slots: [] })),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function mount(permissions: string[]) {
  return render(
    <TestQueryProvider>
      <StaffAccessProvider role="receptionist" permissions={permissions as never} userId="u1"><FollowUpsWorkspace /></StaffAccessProvider>
    </TestQueryProvider>,
  );
}

describe("offering a waitlist time by hand (database mode)", () => {
  it("holds the time and sends the offer through the offer route, with an Idempotency-Key, and says so", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAvailabilitySlots).mockResolvedValue([demoSlots[0]!]);
    vi.mocked(staffMutation).mockResolvedValue({ offerId: "o1", chainId: "c1" });
    mount(["appointments.book", "waitlist.manage"]);
    await user.click(screen.getByRole("button", { name: "Review Sara Ahmed" }));
    expect(screen.getByText(/Offering holds the time for the .* and messages them/)).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /9:30/ }));
    expect(screen.getByText(/holds the time for the .* and sends them the offer/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm offer" }));
    await waitFor(() => expect(staffMutation).toHaveBeenCalledTimes(1));
    const [path, method, body, options] = vi.mocked(staffMutation).mock.calls[0]!;
    expect(path).toBe("/api/staff/waitlist/waitlist_sara/offer");
    expect(method).toBe("POST");
    expect(body).toEqual({ practitionerId: demoSlots[0]!.practitionerId, startsAt: demoSlots[0]!.startsAt, endsAt: demoSlots[0]!.endsAt });
    expect(options?.idempotencyKey).toMatch(/[0-9a-f-]{20,}/);
    expect(await screen.findByRole("heading", { name: "Offer sent" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/held for the .* and the offer is on its way/);
  });

  it("shows the server's reason and stays on the review step when the time cannot be offered", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAvailabilitySlots).mockResolvedValue([demoSlots[0]!]);
    vi.mocked(staffMutation).mockRejectedValue(new Error("That time is not open any more. Pick another."));
    mount(["appointments.book", "waitlist.manage"]);
    await user.click(screen.getByRole("button", { name: "Review Sara Ahmed" }));
    await user.click(await screen.findByRole("button", { name: /9:30/ }));
    await user.click(screen.getByRole("button", { name: "Confirm offer" }));
    expect(await screen.findByText("That time is not open any more. Pick another.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Review follow-up" })).toBeInTheDocument();
  });

  it("shows the Offers tab only to people who may see the waitlist, and explains instead of offering to people who may not make offers", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAvailabilitySlots).mockResolvedValue([demoSlots[0]!]);
    mount(["appointments.book"]);
    expect(screen.getByRole("tab", { name: "Offers" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review Sara Ahmed" }));
    expect(await screen.findByText(/need the waitlist permission to offer one/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /9:30/ })).not.toBeInTheDocument();
    cleanup();
    mount(["records.view"]);
    expect(screen.queryByRole("tab", { name: "Offers" })).not.toBeInTheDocument();
  });
});
