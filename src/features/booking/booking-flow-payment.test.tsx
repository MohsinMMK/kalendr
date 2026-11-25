/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { demoClinic, demoLocations, demoPractitioners, demoResources, demoServices, demoSlots } from "@/lib/demo-data";
import type { Service } from "@/lib/domain";
import type { PublicServicePayment } from "@/lib/payments";

import { BookingFlow } from "./booking-flow";
import { render } from "./test-support";

vi.mock("./visitor-zone", () => ({ detectVisitorZone: () => "Asia/Kolkata", detectVisitorLocale: () => "en-IN" }));

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const policyText = "You pay ₹200 now as a deposit. Cancel or move your appointment at least 1 day before it starts for a full refund of what you paid.";
const payment: PublicServicePayment = { mode: "deposit", priceMinor: 80_000, depositMinor: 20_000, dueNowMinor: 20_000, dueLaterMinor: 60_000, currency: "INR", policyText };
const paidServices = demoServices.map((service) => ({ ...service, payment }));

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type User = ReturnType<typeof userEvent.setup>;
/** Picking moves on by itself; the screen has moved on once the choice is gone. */
async function pickAndContinue(user: User, choice: HTMLElement) {
  await user.click(choice);
  await waitFor(() => expect(choice).not.toBeInTheDocument());
}

async function toDetails(user: User) {
  await pickAndContinue(user, await screen.findByRole("radio", { name: /Indiranagar/i }));
  await pickAndContinue(user, await screen.findByRole("radio", { name: /Routine cleaning/i }));
  await pickAndContinue(user, await screen.findByRole("radio", { name: /Anyone available/i }));
  await pickAndContinue(user, await screen.findByRole("radio", { name: /9:30/i }));
  await screen.findByRole("heading", { name: "Last step: your details" });
  await user.type(screen.getByRole("textbox", { name: "Full name" }), "Ananya Rao");
  await user.type(screen.getByRole("textbox", { name: "Mobile number" }), "+91 98450 12345");
  await user.type(screen.getByRole("textbox", { name: "Email address" }), "ananya@example.com");
  await user.click(screen.getByRole("checkbox", { name: /I understand and agree to this use of the booking details/i }));
}

const manageToken = "manage-token-for-payment-1234";

function stubServer(options: { status?: () => unknown; provider?: "fake" | "razorpay" } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/public/availability?")) return jsonResponse({ data: { slots: [demoSlots[0], demoSlots[2]] } });
    if (url === "/api/public/holds" && init?.method === "POST") return jsonResponse({ data: { holdToken: "hold-token-number-1-xxxxxxxxxxxx", expiresAt: new Date(Date.now() + 300_000).toISOString() } }, 201);
    if (url === "/api/public/holds") return jsonResponse({ data: {} });
    if (url === "/api/public/appointments" && init?.method === "POST") {
      return jsonResponse(
        { data: { appointmentId: "appointment_pending", manageToken, status: "pending_payment", startsAt: demoSlots[0].startsAt, endsAt: demoSlots[0].endsAt, payment: { dueNowMinor: 20_000, currency: "INR", expiresAt: new Date(Date.now() + 600_000).toISOString(), policyText } } },
        201,
      );
    }
    if (url === "/api/public/bookings/pay") {
      return jsonResponse({ data: { provider: options.provider ?? "fake", orderId: "order_1", amountMinor: 20_000, currency: "INR", keyId: null, checkoutUrl: "/pay/test/order_1?returnTo=%2Fmanage%2Fx", expiresAt: new Date(Date.now() + 600_000).toISOString(), mode: "test", businessName: "Lotus" } });
    }
    if (url === "/api/public/bookings/pay/status") return jsonResponse({ data: options.status?.() ?? { state: "waiting", appointmentStatus: "pending_payment", expiresAt: null } });
    return jsonResponse({ data: {} });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mount(services: Service[] = paidServices) {
  render(<BookingFlow clinic={demoClinic} locations={demoLocations} services={services} practitioners={demoPractitioners} resources={demoResources} initialSlots={demoSlots} />);
}

function postedBooking(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/public/appointments" && (init as RequestInit | undefined)?.method === "POST");
  return JSON.parse(String((call?.[1] as RequestInit).body));
}

describe("paying when you book", () => {
  it("shows the amounts and the exact policy, and keeps Confirm off until the customer agrees", async () => {
    const user = userEvent.setup();
    stubServer();
    mount();
    await toDetails(user);

    expect(screen.getByRole("heading", { name: "Pay ₹200 now, ₹600 at the appointment" })).toBeInTheDocument();
    expect(screen.getByText(policyText)).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Confirm booking" });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: "I agree to this policy" }));
    expect(screen.getByRole("button", { name: "Confirm booking" })).toBeEnabled();
    await user.click(screen.getByRole("checkbox", { name: "I agree to this policy" }));
    expect(screen.getByRole("button", { name: "Confirm booking" })).toBeDisabled();
  });

  it("behaves as before for a service that takes no payment", async () => {
    const user = userEvent.setup();
    stubServer();
    mount(demoServices.map((service) => ({ ...service, payment: null })));
    await toDetails(user);
    expect(screen.queryByRole("checkbox", { name: "I agree to this policy" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm booking" })).toBeEnabled();
  });

  it("goes to the Pay step when the booking waits for payment, then to the test checkout", async () => {
    const user = userEvent.setup();
    const fetchMock = stubServer();
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    mount();
    await toDetails(user);
    await user.click(screen.getByRole("checkbox", { name: "I agree to this policy" }));
    await user.click(screen.getByRole("button", { name: "Confirm booking" }));

    expect(postedBooking(fetchMock).acceptedPaymentPolicy).toBe(true);
    expect(await screen.findByRole("heading", { level: 1, name: "Pay ₹200 to keep your appointment" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /booked/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Pay ₹200" }));
    const payCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/public/bookings/pay");
    expect(JSON.parse(String((payCall?.[1] as RequestInit).body))).toEqual({ clinicSlug: demoClinic.slug, manageToken });
    expect(assign).toHaveBeenCalledWith("/pay/test/order_1?returnTo=%2Fmanage%2Fx");
  });

  it("shows Confirming after Razorpay's window says success, and the confirmation only when the server confirms", async () => {
    const user = userEvent.setup();
    let state: "waiting" | "confirmed" = "waiting";
    stubServer({ provider: "razorpay", status: () => ({ state, appointmentStatus: state === "confirmed" ? "booked" : "pending_payment", expiresAt: null }) });
    // The session carries a key; Checkout.js is already loaded.
    const fetchMock = vi.mocked(fetch);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/public/bookings/pay") {
        return jsonResponse({ data: { provider: "razorpay", orderId: "order_1", amountMinor: 20_000, currency: "INR", keyId: "rzp_test_abcdef123456", checkoutUrl: null, expiresAt: new Date(Date.now() + 600_000).toISOString(), mode: "test", businessName: "Lotus" } });
      }
      return original(input, init);
    });
    let razorpay: { handler: () => void } | undefined;
    (window as unknown as { Razorpay: unknown }).Razorpay = class {
      constructor(options: { handler: () => void }) {
        razorpay = options;
      }
      open() {}
      on() {}
    };

    mount();
    await toDetails(user);
    await user.click(screen.getByRole("checkbox", { name: "I agree to this policy" }));
    await user.click(screen.getByRole("button", { name: "Confirm booking" }));
    await user.click(await screen.findByRole("button", { name: "Pay ₹200" }));
    expect(razorpay).toBeDefined();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    act(() => razorpay!.handler());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Confirming your payment");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Confirming your payment");
    expect(screen.queryByRole("region", { name: /booked/i })).not.toBeInTheDocument();

    state = "confirmed";
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    expect(await screen.findByRole("region", { name: /booked/i })).toBeInTheDocument();
    delete (window as unknown as { Razorpay?: unknown }).Razorpay;
  });

  it("lets the customer pick another time when the hold runs out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    stubServer();
    mount();
    await toDetails(user);
    await user.click(screen.getByRole("checkbox", { name: "I agree to this policy" }));
    await user.click(screen.getByRole("button", { name: "Confirm booking" }));
    await screen.findByRole("button", { name: "Pay ₹200" });

    await act(async () => { await vi.advanceTimersByTimeAsync(601_000); });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your held time was let go");
    await user.click(screen.getByRole("button", { name: "Pick another time" }));
    expect(await screen.findByRole("heading", { name: "When works for you?" })).toBeInTheDocument();
  });
});
