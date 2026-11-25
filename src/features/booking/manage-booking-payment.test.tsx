/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { demoAppointments, demoClinic, demoLocations, demoPractitioners, demoServices } from "@/lib/demo-data";

import type { ManageBookingSnapshot } from "./booking-types";
import { ManageBooking } from "./manage-booking";

const token = "manage-token-for-payment-1234";

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function snapshot(status: "pending_payment" | "booked" | "expired"): ManageBookingSnapshot {
  const appointment = demoAppointments[0];
  return {
    appointment: { ...appointment, status, manageToken: token, version: 2 },
    clinic: demoClinic,
    location: demoLocations.find((item) => item.id === appointment.locationId)!,
    practitioner: demoPractitioners.find((item) => item.id === appointment.practitionerId)!,
    service: { ...demoServices.find((item) => item.id === appointment.serviceId)!, payment: { mode: "deposit", priceMinor: 80_000, depositMinor: 20_000, dueNowMinor: 20_000, dueLaterMinor: 60_000, currency: "INR", policyText: "x" } },
    canCancel: status === "booked",
    canReschedule: status === "booked",
  };
}

function stub(current: () => ManageBookingSnapshot) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `/api/public/appointments/${token}` && !init?.method) return json({ data: current() });
    if (url === "/api/public/bookings/pay/status") return json({ data: { state: "waiting", appointmentStatus: "pending_payment", expiresAt: new Date(Date.now() + 300_000).toISOString() } });
    return json({ data: {} });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("a booking waiting for payment on the manage page", () => {
  it("shows Awaiting payment with a Pay now button and the time left", async () => {
    stub(() => snapshot("pending_payment"));
    render(<ManageBooking token={token} fallbackSlots={[]} />);
    expect(await screen.findByRole("button", { name: "Pay ₹200" })).toBeEnabled();
    expect(await screen.findByText(/^(5:00|4:5\d)$/)).toBeInTheDocument();
  });

  it("shows Confirming after a hosted checkout (?paid=1) and then the booking once the server confirms it", async () => {
    window.history.replaceState(null, "", `/manage/${token}?paid=1`);
    let status: "pending_payment" | "booked" = "pending_payment";
    const fetchMock = stub(() => snapshot(status));
    render(<ManageBooking token={token} fallbackSlots={[]} />);

    expect(await screen.findByRole("heading", { level: 1, name: /Confirming your payment/ })).toBeInTheDocument();
    // It polls the manage snapshot, not the payment status route.
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/public/bookings/pay/status")).toBe(false);

    status = "booked";
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    expect(screen.queryByRole("heading", { name: /Confirming your payment/ })).not.toBeInTheDocument();
    expect(await screen.findByText("Booked")).toBeInTheDocument();
  });

  it("shows the expired state when the booking was let go", async () => {
    window.history.replaceState(null, "", `/manage/${token}?paid=1`);
    let status: "pending_payment" | "expired" = "pending_payment";
    stub(() => snapshot(status));
    render(<ManageBooking token={token} fallbackSlots={[]} />);
    await screen.findByRole("heading", { level: 1, name: /Confirming your payment/ });
    status = "expired";
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    expect(await screen.findByText("Not confirmed")).toBeInTheDocument();
  });
});
