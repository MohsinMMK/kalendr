/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  demoAppointments,
  demoClinic,
  demoLocations,
  demoPractitioners,
  demoServices,
  demoSlots,
} from "@/lib/demo-data";

import type { ManageBookingSnapshot } from "./booking-types";
import { ManageBooking } from "./manage-booking";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function createSnapshot(): ManageBookingSnapshot {
  const appointment = demoAppointments.find(
    (item) => item.manageToken === "demo-booking",
  );
  const location = demoLocations.find(
    (item) => item.id === appointment?.locationId,
  );
  const practitioner = demoPractitioners.find(
    (item) => item.id === appointment?.practitionerId,
  );
  const service = demoServices.find((item) => item.id === appointment?.serviceId);

  if (!appointment || !location || !practitioner || !service) {
    throw new Error("The demo manage-booking fixture is incomplete.");
  }

  return {
    appointment: { ...appointment, version: 3 },
    clinic: demoClinic,
    location,
    practitioner,
    service,
    canCancel: true,
    canReschedule: true,
  };
}

describe("ManageBooking", () => {
  it("confirms attendance through the versioned manage endpoint", async () => {
    const user = userEvent.setup();
    const snapshot = createSnapshot();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/public/appointments/demo-booking" && !init?.method) {
        return jsonResponse({ data: snapshot });
      }
      if (
        url === "/api/public/appointments/demo-booking" &&
        init?.method === "PATCH"
      ) {
        return jsonResponse({
          data: {
            appointmentId: snapshot.appointment.id,
            status: "booked",
            startsAt: snapshot.appointment.startsAt,
            endsAt: snapshot.appointment.endsAt,
            version: 4,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ManageBooking
        token="demo-booking"
        initialSnapshot={snapshot}
        fallbackSlots={demoSlots}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Confirm attendance" }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Your attendance is confirmed.",
    );
    expect(screen.getByText("Attendance confirmed")).toBeInTheDocument();
    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === "/api/public/appointments/demo-booking" &&
        init?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      action: "confirm",
      expectedVersion: 3,
    });
  });

  it("sends the chosen cancellation reason to the same endpoint", async () => {
    const user = userEvent.setup();
    const snapshot = createSnapshot();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/public/appointments/demo-booking" && !init?.method) {
        return jsonResponse({ data: snapshot });
      }
      if (
        url === "/api/public/appointments/demo-booking" &&
        init?.method === "PATCH"
      ) {
        return jsonResponse({
          data: {
            appointmentId: snapshot.appointment.id,
            status: "cancelled",
            startsAt: snapshot.appointment.startsAt,
            endsAt: snapshot.appointment.endsAt,
            version: 4,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ManageBooking
        token="demo-booking"
        initialSnapshot={snapshot}
        fallbackSlots={demoSlots}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Cancel appointment" }));
    await user.click(screen.getByRole("radio", { name: "I can't make it" }));
    await user.click(
      screen.getByRole("button", { name: "Cancel my appointment" }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "The appointment has been cancelled.",
    );
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toEqual({
      action: "cancel",
      reasonCode: "cant_make_it",
      expectedVersion: 3,
    });
  });

  it("moves the time on its own screen with the same picker and bottom bar", async () => {
    const user = userEvent.setup();
    const snapshot = createSnapshot();
    const openSlots = demoSlots
      .filter(
        (slot) =>
          slot.practitionerId === snapshot.practitioner.id &&
          slot.startsAt !== snapshot.appointment.startsAt,
      )
      .sort((first, second) => first.startsAt.localeCompare(second.startsAt));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/public/appointments/demo-booking" && !init?.method) {
        return jsonResponse({ data: snapshot });
      }
      if (url.startsWith("/api/public/availability?")) {
        return jsonResponse({ data: { slots: openSlots } });
      }
      if (url === "/api/public/appointments/demo-booking" && init?.method === "PATCH") {
        return jsonResponse({
          data: {
            appointmentId: snapshot.appointment.id,
            status: "booked",
            startsAt: openSlots[0].startsAt,
            endsAt: openSlots[0].endsAt,
            version: 4,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ManageBooking token="demo-booking" initialSnapshot={snapshot} fallbackSlots={demoSlots} />,
    );

    await user.click(await screen.findByRole("button", { name: "Change time" }));
    const heading = await screen.findByRole("heading", { level: 1, name: "Choose a new time" });
    expect(heading).toHaveFocus();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    // Back returns to the details without changing anything.
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { level: 1, name: /^Your appointment/ })).toHaveFocus();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Change time" }));
    await screen.findByRole("heading", { level: 1, name: "Choose a new time" });
    await user.click(screen.getByRole("button", { name: "Move appointment" }));
    expect(await screen.findByText("Choose a new time before continuing.")).toBeInTheDocument();

    const times = await screen.findAllByRole("radio");
    await user.click(times[0]);
    expect(screen.getByText("New time")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Move appointment" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Your appointment has been moved to the new time.",
    );
    expect(screen.getByRole("heading", { level: 1, name: /^Your appointment/ })).toHaveFocus();
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toEqual({
      action: "reschedule",
      startsAt: openSlots[0].startsAt,
      expectedVersion: 3,
    });
  });
});
