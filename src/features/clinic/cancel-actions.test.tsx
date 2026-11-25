import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { demoAppointments, demoPatients } from "@/lib/demo-data";
import type { Appointment, TimeSlot } from "@/lib/domain";
import { TestQueryProvider } from "@/test/query-wrapper";
import { staffSnapshotFixture } from "@/test/staff-fixture";

import { AppointmentTask } from "./appointment-task";
import { StaffApiError } from "./queries/http";
import { fetchAvailabilitySlots, staffMutation, staffQuery } from "./staff-snapshot-provider";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }) }));

const base = demoAppointments.find((item) => item.status === "booked")!;
const future = "2099-09-01T04:30:00.000Z";
const url = `/api/staff/appointments/${base.id}`;

const staff = { snapshot: null as unknown as typeof staffSnapshotFixture, loading: false, error: "", role: "owner" as const, refresh: vi.fn() };
vi.mock("./staff-snapshot-provider", async (importOriginal) => ({
  ...await importOriginal<typeof import("./staff-snapshot-provider")>(),
  useOptionalStaffSnapshot: () => staff,
  fetchAvailabilitySlots: vi.fn(),
  staffMutation: vi.fn(),
  staffQuery: vi.fn(),
}));

function setAppointment(patch: Partial<Appointment>, allowGuests = false) {
  const services = staffSnapshotFixture.catalog.services.map((service) => service.id === base.serviceId ? { ...service, intake: { contactMode: "email_or_phone" as const, allowGuests, maxGuests: 3, verifyEmail: false } } : service);
  staff.snapshot = { ...staffSnapshotFixture, catalog: { ...staffSnapshotFixture.catalog, services }, patients: demoPatients, appointments: [{ ...base, startsAt: future, version: 4, ...patch }] };
}
async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "More actions" }));
}
const menuItems = () => screen.queryAllByRole("menuitem").map((item) => item.textContent).filter((label) => label !== "Add record" && label !== "Join video visit");

beforeEach(() => {
  staff.refresh = vi.fn().mockResolvedValue(undefined);
  vi.mocked(staffMutation).mockResolvedValue({});
  vi.mocked(staffQuery).mockResolvedValue([{ id: "p1", label: "We are closed that day", sortOrder: 0 }]);
  setAppointment({ status: "booked" });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); push.mockReset(); });

describe("reasons on the appointment", () => {
  it.each([
    ["customer", "Cancelled by the customer", "I can't make it"],
    ["staff", "Cancelled by the business", "Staff cancelled for closure"],
    ["system", "Cancelled automatically", "No new time was chosen"],
  ] as const)("shows who cancelled and why (%s)", (cancelledBy, heading, reason) => {
    setAppointment({ status: "cancelled", cancelledBy, cancelReasonCode: cancelledBy === "customer" ? "cant_make_it" : cancelledBy === "system" ? "reschedule_expired" : "staff_preset", cancelPresetLabel: cancelledBy === "staff" ? reason : undefined, cancelNote: cancelledBy === "customer" ? "Sorry" : undefined });
    render(<TestQueryProvider><AppointmentTask appointmentId={base.id} /></TestQueryProvider>);
    const block = screen.getByRole("region", { name: "Why this was cancelled" });
    expect(within(block).getByText(heading)).toBeInTheDocument();
    expect(block).toHaveTextContent(reason);
    if (cancelledBy === "customer") expect(block).toHaveTextContent("Sorry");
  });

  it("shows the customer's note about moving and the rebooked line", () => {
    setAppointment({ status: "booked", rescheduleNote: "Mornings suit me", rebookedFromId: "old" });
    render(<TestQueryProvider><AppointmentTask appointmentId={base.id} /></TestQueryProvider>);
    expect(screen.getByText("Their note about moving")).toBeInTheDocument();
    expect(screen.getByText("Mornings suit me")).toBeInTheDocument();
    expect(screen.getByText(/Rebooked from an earlier/)).toBeInTheDocument();
  });

  it("shows the waiting banner and no progress steps", () => {
    setAppointment({ status: "reschedule_requested", rescheduleRequestedAt: "2099-08-01T04:30:00.000Z" });
    render(<TestQueryProvider><AppointmentTask appointmentId={base.id} /></TestQueryProvider>);
    expect(screen.getByText(/Waiting for the .* to choose a new time/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: /progress/i })).not.toBeInTheDocument();
  });
});

describe("more menu", () => {
  it.each([
    ["booked", ["Ask to choose a new time", "Report as spam", "Cancel with a reason"]],
    ["requested", ["Report as spam", "Cancel with a reason"]],
    ["checked_in", ["Report as spam", "Cancel with a reason"]],
    ["reschedule_requested", ["Report as spam", "Cancel with a reason"]],
    ["cancelled", ["Book again", "Report as spam"]],
    ["declined", ["Book again", "Report as spam"]],
    ["expired", ["Book again", "Report as spam"]],
    ["no_show", ["Book again", "Report as spam"]],
    ["completed", ["Book again", "Report as spam"]],
  ] as const)("offers the right items for %s", async (status, expected) => {
    const user = userEvent.setup();
    setAppointment({ status });
    render(<TestQueryProvider><AppointmentTask appointmentId={base.id} /></TestQueryProvider>);
    await openMenu(user);
    expect(menuItems()).toEqual(expected);
  });

  it("offers Edit guests only when the service allows guests", async () => {
    const user = userEvent.setup();
    setAppointment({ status: "booked" }, true);
    render(<TestQueryProvider><AppointmentTask appointmentId={base.id} /></TestQueryProvider>);
    await openMenu(user);
    expect(menuItems()).toContain("Edit guests");
  });

  it("is not there without the database", () => {
    staff.snapshot = { ...staffSnapshotFixture, patients: demoPatients, appointments: [] };
    render(<TestQueryProvider><AppointmentTask appointmentId={base.id} /></TestQueryProvider>);
    expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
  });
});

describe("dialogs", () => {
  it("asks for a new time with a message", async () => {
    const user = userEvent.setup();
    render(<TestQueryProvider><AppointmentTask appointmentId={base.id} /></TestQueryProvider>);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Ask to choose a new time" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Message to the .* \(they will see it\)/), "Please pick a day");
    await user.click(within(dialog).getByRole("button", { name: "Ask them" }));
    await waitFor(() => expect(staffMutation).toHaveBeenCalledWith(url, "PATCH", { action: "request_reschedule", message: "Please pick a day", expectedVersion: 4 }));
    expect(staff.refresh).toHaveBeenCalled();
  });

  it("cancels with a preset, a note, and without telling the customer", async () => {
    const user = userEvent.setup();
    render(<TestQueryProvider><AppointmentTask appointmentId={base.id} /></TestQueryProvider>);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Cancel with a reason" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Reason" })).toBeEnabled());
    await user.click(within(dialog).getByRole("combobox", { name: "Reason" }));
    expect(await screen.findByRole("option", { name: "No specific reason" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "We are closed that day" }));
    await user.type(within(dialog).getByLabelText(/Note for your team/), "Power cut");
    await user.click(within(dialog).getByRole("checkbox", { name: /Tell the/ }));
    await user.click(within(dialog).getByRole("button", { name: /^Cancel / }));
    await waitFor(() => expect(staffMutation).toHaveBeenCalledWith(url, "PATCH", { action: "cancel", presetId: "p1", note: "Power cut", notifyCustomer: false, expectedVersion: 4 }));
  });

  it("books again at a chosen time and opens the new appointment", async () => {
    const user = userEvent.setup();
    setAppointment({ status: "cancelled" });
    const slot = { id: "s1", startsAt: "2099-09-02T05:00:00.000Z", endsAt: "2099-09-02T05:30:00.000Z", practitionerId: base.practitionerId, locationId: base.locationId, serviceId: base.serviceId } as TimeSlot;
    vi.mocked(fetchAvailabilitySlots).mockResolvedValue([slot]);
    vi.mocked(staffMutation).mockResolvedValue({ appointmentId: "new1", status: "booked", startsAt: slot.startsAt, endsAt: slot.endsAt, version: 1 });
    render(<TestQueryProvider><AppointmentTask appointmentId={base.id} /></TestQueryProvider>);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Book again" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Book again" })).toBeDisabled();
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Time" })).toBeEnabled());
    await user.click(within(dialog).getByRole("combobox", { name: "Time" }));
    await user.click(await screen.findByRole("option", { name: /·/ }));
    await user.click(within(dialog).getByRole("button", { name: "Book again" }));
    await waitFor(() => expect(staffMutation).toHaveBeenCalledWith(url, "PATCH", { action: "rebook", startsAt: slot.startsAt, practitionerId: base.practitionerId, expectedVersion: 4 }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/appointments/new1"));
  });

  it("replaces the guest list", async () => {
    const user = userEvent.setup();
    setAppointment({ status: "booked" }, true);
    render(<TestQueryProvider><AppointmentTask appointmentId={base.id} /></TestQueryProvider>);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Edit guests" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/This replaces the guest list/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Guest email"), "a@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Save guests" }));
    await waitFor(() => expect(staffMutation).toHaveBeenCalledWith(url, "PATCH", { action: "edit_guests", guests: ["a@example.com"], expectedVersion: 4 }));
  });

  it("shows a refused change inline and keeps the dialog open", async () => {
    const user = userEvent.setup();
    const message = "This booking can no longer be changed that way.";
    vi.mocked(staffMutation).mockRejectedValue(new StaffApiError(message, 409, "invalid_status_transition"));
    render(<TestQueryProvider><AppointmentTask appointmentId={base.id} /></TestQueryProvider>);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Ask to choose a new time" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Ask them" }));
    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    expect(staff.refresh).not.toHaveBeenCalled();
  });
});
