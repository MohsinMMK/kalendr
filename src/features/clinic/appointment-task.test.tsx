import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoAppointments, demoPatients, demoSlots } from "@/lib/demo-data";
import type { TimeSlot } from "@/lib/domain";
import { staffSnapshotFixture } from "@/test/staff-fixture";

import { AppointmentTask } from "./appointment-task";
import { fetchAvailabilitySlots } from "./staff-snapshot-provider";

const appointment = demoAppointments.find((item) => item.status === "booked")!;
const snapshot = { ...staffSnapshotFixture, patients: demoPatients, appointments: [{ ...appointment, version: 1 }] };
const staff = { snapshot, loading: false, error: "", role: "owner" as const, refresh: vi.fn() };
vi.mock("./staff-snapshot-provider", async (importOriginal) => ({
  ...await importOriginal<typeof import("./staff-snapshot-provider")>(),
  useOptionalStaffSnapshot: () => staff,
  fetchAvailabilitySlots: vi.fn(),
}));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("database rescheduling", () => {
  it("loads once per date and hides obsolete openings immediately when changing date", async () => {
    const user = userEvent.setup();
    let finishNextDate: (slots: TimeSlot[]) => void = () => undefined;
    vi.mocked(fetchAvailabilitySlots)
      .mockResolvedValueOnce([demoSlots[0]])
      .mockImplementationOnce(() => new Promise((resolve) => { finishNextDate = resolve; }));
    render(<AppointmentTask appointmentId={appointment.id} returnDate="2026-09-01" />);
    await user.click(screen.getByRole("button", { name: "Reschedule" }));
    await user.click(await screen.findByRole("button", { name: "List" }));
    const opening = await screen.findByRole("button", { name: /9:30/ });
    expect(opening).toBeInTheDocument();
    expect(fetchAvailabilitySlots).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Next reschedule date" }));
    expect(screen.queryByRole("button", { name: /9:30/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading compatible openings");
    expect(vi.mocked(fetchAvailabilitySlots).mock.calls[0][1]?.aborted).toBe(true);
    await act(async () => finishNextDate([demoSlots[3]]));
    expect(await screen.findByRole("button", { name: /10:00/ })).toBeInTheDocument();
    await waitFor(() => expect(fetchAvailabilitySlots).toHaveBeenCalledTimes(2));
  });
});
