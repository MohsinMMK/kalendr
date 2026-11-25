/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { VisitPayments } from "@/server/payments";

import { PaymentsDialog } from "./payments-dialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Req = { url: string; method: string; body?: Record<string, unknown> };
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });

const base = { appointmentId: "appt1", currency: "INR" };
function visit(patch: { price?: number | null; payments?: unknown[] } = {}): VisitPayments {
  const price = patch.price === undefined ? 80000 : patch.price;
  return {
    ...base,
    balance: { state: "unpaid", priceMinor: price, netPaidMinor: 0, dueMinor: price ?? 0 },
    payments: (patch.payments ?? []) as VisitPayments["payments"],
  };
}
const online = (patch: Record<string, unknown> = {}) => ({
  id: "pay1", amountMinor: 20000, method: "upi", at: "2026-11-18T09:30:00.000Z", refunds: [], refundableMinor: 20000, provider: "razorpay", isTest: false, pendingRefundMinor: 0, ...patch,
});

function setup(initial: VisitPayments, handler?: (request: Req) => Response | undefined) {
  const requests: Req[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const request: Req = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(request);
    const answer = handler?.(request);
    if (answer) return answer;
    return json(initial);
  }));
  render(<PaymentsDialog appointmentId="appt1" name="Asha" onOpenChange={() => undefined} canRefund />);
  return requests;
}

describe("payments dialog, online payments", () => {
  it("marks an online test payment and a pending refund", async () => {
    setup(visit({ payments: [online({ isTest: true, pendingRefundMinor: 5000 })] }));
    expect(await screen.findByText("Online")).toBeInTheDocument();
    expect(screen.getByText("Test payment")).toBeInTheDocument();
    expect(screen.getByText(/Refund pending · ₹50/)).toBeInTheDocument();
  });

  it("shows a desk payment as before, with no online marks", async () => {
    setup(visit({ payments: [online({ provider: null, isTest: false })] }));
    await screen.findByText(/₹200 · UPI/);
    expect(screen.queryByText("Online")).not.toBeInTheDocument();
    expect(screen.queryByText("Test payment")).not.toBeInTheDocument();
    expect(screen.queryByText(/Refund pending/)).not.toBeInTheDocument();
  });

  it("says the refund was sent to the provider, not that it was given back", async () => {
    const user = userEvent.setup();
    const requests = setup(visit({ payments: [online()] }), (request) => {
      if (request.method === "POST" && request.url.endsWith("/refunds")) return json(visit({ payments: [online({ refundableMinor: 0, pendingRefundMinor: 20000 })] }), 202);
      return undefined;
    });
    await user.click(await screen.findByRole("button", { name: /Give back/ }));
    await user.type(screen.getByLabelText("Why"), "Cancelled");
    await user.click(screen.getByRole("button", { name: /^Give back ₹200/ }));
    await waitFor(() => expect(requests.some((request) => request.url.endsWith("/refunds"))).toBe(true));
    expect(await screen.findByText(/Refund pending · ₹200/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("payments dialog, payment link", () => {
  it("makes a link for a visit that owes money, to copy and send by hand", async () => {
    const user = userEvent.setup();
    const requests = setup(visit(), (request) => {
      if (request.url.endsWith("/payment-link")) return json({ url: "https://pay.example/l/abc", amountMinor: 80000, currency: "INR", expiresAt: "2026-11-20T10:00:00.000Z", sent: false });
      return undefined;
    });
    await user.click(await screen.findByRole("button", { name: "More payment actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Send payment link/ }));
    await user.click(screen.getByRole("button", { name: "Make link" }));
    expect(await screen.findByRole("textbox", { name: "Payment link" })).toHaveValue("https://pay.example/l/abc");
    expect(requests.find((request) => request.url.endsWith("/payment-link"))).toMatchObject({ method: "POST", body: { send: false } });
  });

  it("does not offer a link when nothing is owed", async () => {
    setup({ ...visit({ price: 80000 }), balance: { state: "paid", priceMinor: 80000, netPaidMinor: 80000, dueMinor: 0 } });
    await screen.findByText("Paid in full. Nothing is due.");
    expect(screen.queryByRole("button", { name: "More payment actions" })).not.toBeInTheDocument();
  });

  it("shows why a link could not be made", async () => {
    const user = userEvent.setup();
    setup(visit(), (request) => (request.url.endsWith("/payment-link") ? new Response(JSON.stringify({ error: { code: "no_account", message: "Connect a payment account first." } }), { status: 409 }) : undefined));
    await user.click(await screen.findByRole("button", { name: "More payment actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Send payment link/ }));
    await user.click(await screen.findByRole("button", { name: "Make link" }));
    expect(await screen.findByText("Connect a payment account first.")).toBeInTheDocument();
  });
});
