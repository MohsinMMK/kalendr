import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { demoAppointments, demoPatients } from "@/lib/demo-data";
import type { Appointment } from "@/lib/domain";
import { staffSnapshotFixture } from "@/test/staff-fixture";

import { AppointmentTask } from "./appointment-task";
import { StaffApiError } from "./queries/http";
import { staffMutation } from "./staff-snapshot-provider";

const base = demoAppointments.find((item) => item.status === "booked")!;
const requestedStart = "2026-09-01T04:30:00.000Z";
const offered = ["2026-09-02T05:00:00.000Z", "2026-09-03T06:30:00.000Z"];

function setAppointment(patch: Partial<Appointment>) {
  staff.snapshot = { ...staffSnapshotFixture, patients: demoPatients, appointments: [{ ...base, version: 3, ...patch }] };
}

const staff = { snapshot: null as unknown as typeof staffSnapshotFixture, loading: false, error: "", role: "owner" as const, refresh: vi.fn() };
vi.mock("./staff-snapshot-provider", async (importOriginal) => ({
  ...await importOriginal<typeof import("./staff-snapshot-provider")>(),
  useOptionalStaffSnapshot: () => staff,
  fetchAvailabilitySlots: vi.fn(),
  staffMutation: vi.fn(),
}));

beforeEach(() => {
  staff.refresh = vi.fn().mockResolvedValue(undefined);
  setAppointment({ status: "requested", startsAt: requestedStart, proposedStarts: offered });
  vi.mocked(staffMutation).mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("approval card", () => {
  it("shows only for a request that is waiting", () => {
    const { unmount } = render(<AppointmentTask appointmentId={base.id} />);
    expect(screen.getByRole("heading", { name: "Waiting for your approval" })).toBeInTheDocument();
    unmount();
    setAppointment({ status: "booked" });
    render(<AppointmentTask appointmentId={base.id} />);
    expect(screen.queryByRole("heading", { name: "Waiting for your approval" })).not.toBeInTheDocument();
  });

  it("approves the requested time in one click", async () => {
    const user = userEvent.setup();
    render(<AppointmentTask appointmentId={base.id} />);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(staffMutation).toHaveBeenCalledWith(`/api/staff/appointments/${base.id}`, "PATCH", { action: "approve", expectedVersion: 3 }));
    expect(staff.refresh).toHaveBeenCalled();
  });

  it("lists the other offered times and approves one with chosenStart", async () => {
    const user = userEvent.setup();
    render(<AppointmentTask appointmentId={base.id} />);
    expect(screen.getByRole("heading", { name: "These also work for them" })).toBeInTheDocument();
    const rows = screen.getAllByRole("button", { name: /^Approve this time/ });
    expect(rows).toHaveLength(2);
    await user.click(rows[1]!);
    await waitFor(() => expect(staffMutation).toHaveBeenCalledWith(`/api/staff/appointments/${base.id}`, "PATCH", { action: "approve", chosenStart: offered[1], expectedVersion: 3 }));
  });

  it("sends the reason and message when declining", async () => {
    const user = userEvent.setup();
    render(<AppointmentTask appointmentId={base.id} />);
    await user.click(screen.getByRole("button", { name: "Decline" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Decline" })).toBeDisabled();
    await user.click(within(dialog).getByRole("combobox", { name: "Reason" }));
    await user.click(await screen.findByRole("option", { name: "We are fully booked" }));
    await user.type(within(dialog).getByLabelText(/Message to the .* \(they will see it\)/), "Try next week");
    expect(within(dialog).getByText("13 / 500")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(staffMutation).toHaveBeenCalledWith(`/api/staff/appointments/${base.id}`, "PATCH", { action: "decline", reason: "fully_booked", message: "Try next week", expectedVersion: 3 }));
  });

  it("shows the plain message and stays open when the time is taken", async () => {
    const user = userEvent.setup();
    const message = "That time is no longer free. Choose another time for this request, or decline it.";
    vi.mocked(staffMutation).mockRejectedValue(new StaffApiError(message, 409, "request_slot_taken"));
    render(<AppointmentTask appointmentId={base.id} />);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Waiting for your approval" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(staff.refresh).not.toHaveBeenCalled();
  });

  it("shows a quiet banner instead of the card for declined and expired requests", () => {
    setAppointment({ status: "declined", declineReason: "outside_services" });
    const { unmount } = render(<AppointmentTask appointmentId={base.id} />);
    expect(screen.getByRole("status")).toHaveTextContent("Declined: It is outside what we offer");
    expect(screen.queryByRole("heading", { name: "Waiting for your approval" })).not.toBeInTheDocument();
    expect(screen.getByText(/No further staff action/)).toBeInTheDocument();
    unmount();
    setAppointment({ status: "expired" });
    render(<AppointmentTask appointmentId={base.id} />);
    expect(screen.getByRole("status")).toHaveTextContent("Expired: nobody answered before the start time");
  });
});
