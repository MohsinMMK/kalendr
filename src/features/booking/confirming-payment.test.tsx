/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmingPayment, paymentStatusCheck, type PaymentOutcome } from "./confirming-payment";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("the Confirming screen", () => {
  it("polls every 2 seconds, then every 5 after 20 seconds", async () => {
    const check = vi.fn<() => Promise<PaymentOutcome>>(async () => ({ state: "waiting" }));
    render(<ConfirmingPayment check={check} onConfirmed={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Confirming your payment");

    await advance(0);
    expect(check).toHaveBeenCalledTimes(1);
    await advance(2_000);
    expect(check).toHaveBeenCalledTimes(2);
    await advance(18_000); // 20s: 9 more fast checks (at 4..20)
    expect(check).toHaveBeenCalledTimes(11);
    await advance(4_900);
    expect(check).toHaveBeenCalledTimes(11);
    await advance(100);
    expect(check).toHaveBeenCalledTimes(12);
  });

  it("stops at 3 minutes with a calm waiting state", async () => {
    const check = vi.fn<() => Promise<PaymentOutcome>>(async () => ({ state: "waiting" }));
    render(<ConfirmingPayment check={check} onConfirmed={vi.fn()} />);
    await advance(185_000);
    const calls = check.mock.calls.length;
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Still waiting");
    expect(screen.getByRole("status")).toHaveTextContent("we'll message you when it's confirmed, you can close this page");
    await advance(60_000);
    expect(check).toHaveBeenCalledTimes(calls);
  });

  it("keeps trying through a failed check", async () => {
    const check = vi
      .fn<() => Promise<PaymentOutcome>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ state: "confirmed", appointmentStatus: "booked" });
    const onConfirmed = vi.fn();
    render(<ConfirmingPayment check={check} onConfirmed={onConfirmed} />);
    await advance(0);
    expect(onConfirmed).not.toHaveBeenCalled();
    await advance(2_000);
    expect(onConfirmed).toHaveBeenCalledWith({ state: "confirmed", appointmentStatus: "booked" });
  });

  it("hands over only when the server says confirmed, and stops asking", async () => {
    const check = vi.fn<() => Promise<PaymentOutcome>>(async () => ({ state: "confirmed", appointmentStatus: "booked" }));
    const onConfirmed = vi.fn();
    render(<ConfirmingPayment check={check} onConfirmed={onConfirmed} />);
    await advance(0);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    await advance(10_000);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it.each(["expired", "cancelled"] as const)("shows a calm %s state", async (state) => {
    const check = vi.fn<() => Promise<PaymentOutcome>>(async () => ({ state }));
    const onConfirmed = vi.fn();
    render(<ConfirmingPayment check={check} onConfirmed={onConfirmed} manageHref="/manage/token" />);
    await advance(0);
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(state === "expired" ? "Your held time was let go" : "was cancelled");
    expect(screen.queryByText(/Confirming your payment/)).not.toBeInTheDocument();
  });

  it("asks the status route with the clinic and manage token", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { state: "waiting", appointmentStatus: "pending_payment", expiresAt: null } }) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await paymentStatusCheck({ clinicSlug: "lotus", manageToken: "m".repeat(24) })();
    expect(outcome.state).toBe("waiting");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/public/bookings/pay/status");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ clinicSlug: "lotus", manageToken: "m".repeat(24) });
  });
});
