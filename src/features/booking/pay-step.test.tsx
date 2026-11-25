/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CheckoutSession } from "@/lib/payments";

import { PayStep } from "./pay-step";

const session = (overrides: Partial<CheckoutSession> = {}): CheckoutSession => ({
  provider: "razorpay",
  orderId: "order_123",
  amountMinor: 20_000,
  currency: "INR",
  keyId: "rzp_test_abcdef123456",
  checkoutUrl: null,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  mode: "test",
  businessName: "Lotus Dental Studio",
  ...overrides,
});

interface FakeRazorpay {
  options: Record<string, unknown>;
  open: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}
let razorpays: FakeRazorpay[] = [];

beforeEach(() => {
  razorpays = [];
  // Checkout.js is "already loaded", so no script is added in these tests.
  (window as unknown as { Razorpay: unknown }).Razorpay = class {
    options: Record<string, unknown>;
    open = vi.fn();
    on = vi.fn();
    constructor(options: Record<string, unknown>) {
      this.options = options;
      razorpays.push(this as unknown as FakeRazorpay);
    }
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as unknown as { Razorpay?: unknown }).Razorpay;
});

function mount(props: Partial<Parameters<typeof PayStep>[0]> = {}) {
  const handlers = { onConfirming: vi.fn(), onExpired: vi.fn(), start: vi.fn(async () => session()) };
  const view = render(
    <PayStep
      dueNowMinor={20_000}
      dueLaterMinor={60_000}
      currency="INR"
      expiresAt={new Date(Date.now() + 600_000).toISOString()}
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, ...view };
}

describe("the Pay step", () => {
  it("shows what is due now and later, and the time left", () => {
    mount();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Pay ₹200");
    expect(screen.getByRole("button", { name: "Pay ₹200" })).toBeEnabled();
    expect(screen.getByText("₹600")).toBeInTheDocument();
    expect(screen.getByText("10:00")).toBeInTheDocument();
  });

  it("counts down each second", async () => {
    vi.useFakeTimers();
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(65_000);
    });
    expect(screen.getByText("8:55")).toBeInTheDocument();
  });

  it("lets the time go calmly when it runs out, with a way back", async () => {
    vi.useFakeTimers();
    const back = vi.fn();
    const { onExpired } = mount({ expiresAt: new Date(Date.now() + 3_000).toISOString(), expiredAction: { label: "Pick another time", onClick: back } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your held time was let go");
    expect(screen.queryByRole("button", { name: /^Pay/ })).not.toBeInTheDocument();
    expect(onExpired).toHaveBeenCalledTimes(1);
    act(() => screen.getByRole("button", { name: "Pick another time" }).click());
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("opens Razorpay with the order, and its success handler only moves to confirming", async () => {
    const user = userEvent.setup();
    const { onConfirming, start } = mount();
    await user.click(screen.getByRole("button", { name: "Pay ₹200" }));

    expect(start).toHaveBeenCalledTimes(1);
    expect(razorpays).toHaveLength(1);
    const [checkout] = razorpays;
    expect(checkout.options).toMatchObject({ key: "rzp_test_abcdef123456", order_id: "order_123", amount: 20_000, currency: "INR", name: "Lotus Dental Studio" });
    expect(checkout.open).toHaveBeenCalledTimes(1);
    expect(onConfirming).not.toHaveBeenCalled();

    // The handler receives payment ids from Razorpay; the screen never looks at them.
    act(() => (checkout.options.handler as (response: unknown) => void)({ razorpay_payment_id: "pay_1", razorpay_signature: "sig" }));
    expect(onConfirming).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Pay ₹200");
  });

  it("comes back to the Pay step when the Razorpay window is closed", async () => {
    const user = userEvent.setup();
    const { onConfirming } = mount();
    await user.click(screen.getByRole("button", { name: "Pay ₹200" }));
    expect(screen.getByRole("button", { name: /Pay ₹200/ })).toHaveAttribute("data-loading");
    act(() => (razorpays[0].options.modal as { ondismiss: () => void }).ondismiss());
    expect(screen.getByRole("button", { name: "Pay ₹200" })).not.toHaveAttribute("data-loading");
    expect(onConfirming).not.toHaveBeenCalled();
  });

  it("says so calmly when Razorpay reports a failed payment", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Pay ₹200" }));
    const failed = razorpays[0].on.mock.calls.find(([event]) => event === "payment.failed")?.[1] as () => void;
    act(() => failed());
    expect(screen.getByRole("alert")).toHaveTextContent("Nothing was taken");
    expect(screen.getByRole("button", { name: "Pay ₹200" })).toBeEnabled();
  });

  it("goes to the hosted page for Stripe", async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    mount({ start: vi.fn(async () => session({ provider: "stripe", keyId: null, checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_1" })) });
    await user.click(screen.getByRole("button", { name: "Pay ₹200" }));
    expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_1");
    expect(razorpays).toHaveLength(0);
  });

  it("goes to the built-in test checkout for the fake provider", async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    mount({ start: vi.fn(async () => session({ provider: "fake", keyId: null, checkoutUrl: "/pay/test/order_123?returnTo=%2Fmanage%2Ftoken" })) });
    await user.click(screen.getByRole("button", { name: "Pay ₹200" }));
    expect(assign).toHaveBeenCalledWith("/pay/test/order_123?returnTo=%2Fmanage%2Ftoken");
  });

  it("refuses to follow a checkout address that is not https or a path on this site", async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    mount({ start: vi.fn(async () => session({ provider: "stripe", keyId: null, checkoutUrl: "javascript:alert(1)" })) });
    await user.click(screen.getByRole("button", { name: "Pay ₹200" }));
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("shows the server's message when the payment cannot start, and lets the customer try again", async () => {
    const user = userEvent.setup();
    const start = vi.fn().mockRejectedValueOnce(new Error("The business cannot take payments right now.")).mockResolvedValue(session());
    mount({ start });
    await user.click(screen.getByRole("button", { name: "Pay ₹200" }));
    expect(screen.getByRole("alert")).toHaveTextContent("cannot take payments right now");
    await user.click(screen.getByRole("button", { name: "Pay ₹200" }));
    expect(razorpays).toHaveLength(1);
  });
});
