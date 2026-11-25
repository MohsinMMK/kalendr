/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoAppointments, demoClinic, demoLocations, demoPractitioners, demoServices, demoSlots } from "@/lib/demo-data";

import type { ManageBookingSnapshot } from "./booking-types";
import { ManageBooking } from "./manage-booking";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const api = "/api/public/appointments/demo-booking";

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function createSnapshot(overrides: Partial<ManageBookingSnapshot> = {}): ManageBookingSnapshot {
  const appointment = demoAppointments.find((item) => item.manageToken === "demo-booking");
  const location = demoLocations.find((item) => item.id === appointment?.locationId);
  const practitioner = demoPractitioners.find((item) => item.id === appointment?.practitionerId);
  const service = demoServices.find((item) => item.id === appointment?.serviceId);
  if (!appointment || !location || !practitioner || !service) throw new Error("The demo fixture is incomplete.");
  return {
    appointment: { ...appointment, version: 3 },
    clinic: demoClinic,
    location,
    practitioner,
    service,
    canCancel: true,
    canReschedule: true,
    ...overrides,
  };
}

type Handler = (url: string, init?: RequestInit) => Response | undefined;

function stubFetch(snapshot: ManageBookingSnapshot, handler?: Handler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const custom = handler?.(url, init);
    if (custom) return custom;
    if (url === api && !init?.method) return jsonResponse({ data: snapshot });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function patchBody(fetchMock: ReturnType<typeof stubFetch>) {
  const call = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
  return call ? JSON.parse(String(call[1]?.body)) : undefined;
}

function renderPage(snapshot: ManageBookingSnapshot) {
  return render(<ManageBooking token="demo-booking" initialSnapshot={snapshot} fallbackSlots={demoSlots} />);
}

const patched = (snapshot: ManageBookingSnapshot, status: string, version = 4) =>
  jsonResponse({
    data: {
      appointmentId: snapshot.appointment.id,
      status,
      startsAt: snapshot.appointment.startsAt,
      endsAt: snapshot.appointment.endsAt,
      version,
    },
  });

describe("ManageBooking policy", () => {
  it("shows the server's words and a phone link instead of a Cancel button", async () => {
    const phone = demoClinic.phone;
    const snapshot = createSnapshot({
      canCancel: false,
      manage: {
        sameStaffOnly: true,
        cancelBlockedMessage: `It is too close to the start to cancel online. Please call ${phone}.`,
        allowGuestEdit: false,
      },
    });
    stubFetch(snapshot);
    renderPage(snapshot);

    expect(await screen.findByText(/too close to the start/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Cancel appointment/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change time" })).toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: phone });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.getAttribute("href")).toMatch(/^tel:/);
  });

  it("offers no way to move the booking anywhere when moving is off", async () => {
    const snapshot = createSnapshot({
      canReschedule: false,
      manage: {
        sameStaffOnly: true,
        rescheduleBlockedMessage: "Please contact the business to change the time.",
        allowGuestEdit: false,
      },
    });
    stubFetch(snapshot);
    renderPage(snapshot);

    expect(await screen.findByText("Please contact the business to change the time.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /change time|choose a new time|move/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /change time|move/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel appointment" })).toBeInTheDocument();
  });

  it("needs a reason to cancel, then sends the code and note", async () => {
    const user = userEvent.setup();
    const snapshot = createSnapshot();
    const fetchMock = stubFetch(snapshot, (url, init) => (url === api && init?.method === "PATCH" ? patched(snapshot, "cancelled") : undefined));
    renderPage(snapshot);

    await user.click(await screen.findByRole("button", { name: "Cancel appointment" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel my appointment" }));
    expect(await within(dialog).findByText("Choose a reason before continuing.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);

    await user.click(within(dialog).getByRole("radio", { name: "I found another time" }));
    await user.type(within(dialog).getByRole("textbox", { name: /Anything we should know/ }), "Moved house");
    expect(within(dialog).getByText("11 of 500")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel my appointment" }));

    expect(await screen.findByRole("status")).toHaveTextContent("The appointment has been cancelled.");
    expect(patchBody(fetchMock)).toEqual({
      action: "cancel",
      reasonCode: "found_another_time",
      note: "Moved house",
      expectedVersion: 3,
    });
  });

  it("shows a refusal inside the cancel dialog", async () => {
    const user = userEvent.setup();
    const snapshot = createSnapshot();
    stubFetch(snapshot, (url, init) =>
      url === api && init?.method === "PATCH"
        ? jsonResponse({ error: { code: "cancel_not_allowed", message: "It is too late to cancel online. Please call us." } }, 403)
        : undefined,
    );
    renderPage(snapshot);

    await user.click(await screen.findByRole("button", { name: "Cancel appointment" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: "I can't make it" }));
    await user.click(within(dialog).getByRole("button", { name: "Cancel my appointment" }));

    expect(await within(dialog).findByText("It is too late to cancel online. Please call us.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("opens straight on the picker with a banner when staff asked for a new time", async () => {
    const base = createSnapshot();
    const snapshot = createSnapshot({
      appointment: { ...base.appointment, status: "reschedule_requested" },
      manage: { sameStaffOnly: true, rescheduleRequested: true, rescheduleDeadline: "2030-01-10T12:00:00.000Z", allowGuestEdit: false },
    });
    const openSlots = demoSlots.filter((slot) => slot.practitionerId === snapshot.practitioner.id && slot.startsAt !== snapshot.appointment.startsAt);
    const fetchMock = stubFetch(snapshot, (url, init) => {
      if (url.startsWith("/api/public/availability?")) return jsonResponse({ data: { slots: openSlots } });
      if (url === api && init?.method === "PATCH") return patched(snapshot, "booked");
      return undefined;
    });
    const user = userEvent.setup();
    renderPage(snapshot);

    expect(await screen.findByRole("heading", { level: 1, name: "Choose a new time" })).toBeInTheDocument();
    expect(screen.getByText(`${demoClinic.name} asked you to choose a new time`)).toBeInTheDocument();
    expect(screen.getByText(/after that the booking is cancelled/)).toBeInTheDocument();

    await user.click((await screen.findAllByRole("radio"))[0]);
    await user.click(screen.getByRole("button", { name: "Move appointment" }));
    expect(await screen.findByRole("status")).toHaveTextContent("has been moved to the new time");
    expect(screen.getByText("Booked")).toBeInTheDocument();
    expect(patchBody(fetchMock).action).toBe("reschedule");
  });

  it("asks for anyone's times and sends the other person's id when the business allows it", async () => {
    const user = userEvent.setup();
    const snapshot = createSnapshot({ manage: { sameStaffOnly: false, allowGuestEdit: false } });
    const other = demoSlots.find((slot) => slot.practitionerId !== snapshot.practitioner.id);
    if (!other) throw new Error("The demo data has no second person.");
    const fetchMock = stubFetch(snapshot, (url, init) => {
      if (url.startsWith("/api/public/availability?")) return jsonResponse({ data: { slots: [other] } });
      if (url === api && init?.method === "PATCH") return patched(snapshot, "booked");
      return undefined;
    });
    renderPage(snapshot);

    await user.click(await screen.findByRole("button", { name: "Change time" }));
    await user.click((await screen.findAllByRole("radio"))[0]);
    await user.type(screen.getByRole("textbox", { name: /Anything we should know/ }), "Prefer mornings");
    await user.click(screen.getByRole("button", { name: "Move appointment" }));

    await screen.findByRole("status");
    const availability = fetchMock.mock.calls.map(([input]) => String(input)).find((url) => url.startsWith("/api/public/availability?"));
    expect(new URL(availability ?? "", "http://x").searchParams.get("practitionerId")).toBe("first_available");
    expect(patchBody(fetchMock)).toMatchObject({
      action: "reschedule",
      startsAt: other.startsAt,
      practitionerId: other.practitionerId,
      note: "Prefer mornings",
    });
  });

  it("names other people's times from the eligible list", async () => {
    const user = userEvent.setup();
    const base = createSnapshot();
    const other = demoSlots.find((slot) => slot.practitionerId !== base.practitioner.id);
    if (!other) throw new Error("The demo data has no second person.");
    const snapshot = createSnapshot({
      manage: {
        sameStaffOnly: false,
        allowGuestEdit: false,
        eligiblePractitioners: [
          { id: base.practitioner.id, name: base.practitioner.name },
          { id: other.practitionerId, name: "Dr Zed Example" },
        ],
      },
    });
    stubFetch(snapshot, (url) => (url.startsWith("/api/public/availability?") ? jsonResponse({ data: { slots: [other] } }) : undefined));
    renderPage(snapshot);

    await user.click(await screen.findByRole("button", { name: "Change time" }));
    await screen.findAllByRole("radio");
    expect(screen.getAllByText(/Dr Zed Example/).length).toBeGreaterThan(0);
  });

  it("sends the whole guest list when guests are saved", async () => {
    const user = userEvent.setup();
    const base = createSnapshot();
    const snapshot = createSnapshot({
      service: { ...base.service, intake: { contactMode: "email_or_phone", allowGuests: true, maxGuests: 3, verifyEmail: false } },
      guests: ["sam@example.com"],
      manage: { sameStaffOnly: true, allowGuestEdit: true },
    });
    const fetchMock = stubFetch(snapshot, (url, init) => (url === api && init?.method === "PATCH" ? patched(snapshot, "booked") : undefined));
    renderPage(snapshot);

    const card = await screen.findByRole("region", { name: "Guests" });
    expect(within(card).getByRole("textbox", { name: "Guest email" })).toHaveValue("sam@example.com");
    await user.click(within(card).getByRole("button", { name: "Add a guest" }));
    await user.type(within(card).getByRole("textbox", { name: "Guest email 2" }), "alex@example.com");
    await user.click(within(card).getByRole("button", { name: "Save guests" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Your guest list is saved.");
    expect(patchBody(fetchMock)).toEqual({
      action: "edit_guests",
      guests: ["sam@example.com", "alex@example.com"],
      expectedVersion: 3,
    });
  });

  it("hides the guest card when guests may not be edited", async () => {
    const base = createSnapshot();
    const snapshot = createSnapshot({
      service: { ...base.service, intake: { contactMode: "email_or_phone", allowGuests: true, maxGuests: 3, verifyEmail: false } },
      manage: { sameStaffOnly: true, allowGuestEdit: false },
    });
    stubFetch(snapshot);
    renderPage(snapshot);
    await screen.findByRole("button", { name: "Cancel appointment" });
    expect(screen.queryByRole("region", { name: "Guests" })).not.toBeInTheDocument();
  });
});
