/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PaymentSettingsView, ServicePayment } from "@/lib/payments";
import { defaultPaymentPolicy } from "@/lib/payments";
import { TestQueryProvider } from "@/test/query-wrapper";
import { staffSnapshotFixture } from "@/test/staff-fixture";

import { ServicePaymentTab, inputFromForm } from "./service-payment-tab";
import { StaffSnapshotProvider } from "./staff-snapshot-provider";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const none: ServicePayment = { mode: "none", priceMinor: 80000, depositMinor: null, dueNowMinor: 0, dueLaterMinor: 80000, currency: "INR" };
const account = { provider: "fake", mode: "test", status: "active", keyId: "test-account", webhookUrl: "", lastCheckedAt: null } as const;
const settings = (connected: boolean): PaymentSettingsView => ({ account: connected ? account : null, policy: defaultPaymentPolicy, providers: { razorpay: true, stripe: false, fake: true } });

type Req = { url: string; method: string; body?: Record<string, unknown> };
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });

function setup(options: { payment?: ServicePayment | Response; connected?: boolean; save?: (body: Record<string, unknown>) => Response; saves?: boolean } = {}) {
  const requests: Req[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/staff/snapshot") return json(staffSnapshotFixture);
    const request: Req = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(request);
    if (url === "/api/staff/payment-settings") return json(settings(options.connected ?? true));
    if (url === "/api/staff/services/svc1/payment" && request.method === "GET") {
      const payment = options.payment ?? none;
      return payment instanceof Response ? payment : json(payment);
    }
    if (url === "/api/staff/services/svc1/payment" && request.method === "PUT") return options.save?.(request.body ?? {}) ?? json({});
    return json({});
  }));
  render(<TestQueryProvider><StaffSnapshotProvider role="owner"><ServicePaymentTab serviceId="svc1" saves={options.saves ?? true} /></StaffSnapshotProvider></TestQueryProvider>);
  return requests;
}

describe("inputFromForm", () => {
  it("reads rupees as paise and applies the server's rules", () => {
    expect(inputFromForm({ price: "800", mode: "deposit", deposit: "200" }).input).toEqual({ priceMinor: 80000, paymentMode: "deposit", depositMinor: 20000 });
    expect(inputFromForm({ price: "800", mode: "deposit", deposit: "800" }).errors.deposit).toMatch(/less than the price/);
    expect(inputFromForm({ price: "", mode: "full", deposit: "" }).errors.price).toMatch(/Set a price/);
    expect(inputFromForm({ price: "12abc", mode: "none", deposit: "" }).errors.price).toBeTruthy();
    expect(inputFromForm({ price: "", mode: "none", deposit: "" }).input).toEqual({ priceMinor: null, paymentMode: "none", depositMinor: null });
  });
});

describe("service payment tab", () => {
  it("loads, and says what happened when it cannot", async () => {
    const user = userEvent.setup();
    setup({ payment: new Response(JSON.stringify({ error: { code: "error", message: "Could not load." } }), { status: 500 }) });
    expect(await screen.findByText("Could not load.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
  });

  it("shows the price and a live example as the deposit is typed, then saves", async () => {
    const user = userEvent.setup();
    const saved: ServicePayment = { mode: "deposit", priceMinor: 80000, depositMinor: 20000, dueNowMinor: 20000, dueLaterMinor: 60000, currency: "INR" };
    const requests = setup({ save: () => json(saved) });
    expect(await screen.findByLabelText(/^Price/)).toHaveValue("800");
    expect(screen.queryByLabelText(/^Deposit \(INR\)/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Deposit/ }));
    await user.type(await screen.findByLabelText(/^Deposit \(INR\)/), "200");
    expect(screen.getByText("Customers pay ₹200 now and ₹600 at the visit.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save payment settings" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PUT")).toBe(true));
    expect(requests.find((request) => request.method === "PUT")?.body).toEqual({ priceMinor: 80000, paymentMode: "deposit", depositMinor: 20000 });
  });

  it("will not save a deposit as big as the price", async () => {
    const user = userEvent.setup();
    const requests = setup();
    await screen.findByLabelText(/^Price/);
    await user.click(screen.getByRole("radio", { name: /Deposit/ }));
    await user.type(await screen.findByLabelText(/^Deposit \(INR\)/), "800");
    await user.click(screen.getByRole("button", { name: "Save payment settings" }));
    expect(await screen.findByText(/less than the price/)).toBeInTheDocument();
    expect(requests.some((request) => request.method === "PUT")).toBe(false);
    expect(screen.queryByText(/Customers pay/)).not.toBeInTheDocument();
  });

  it("warns when payment is asked for but no account is connected", async () => {
    const user = userEvent.setup();
    setup({ connected: false });
    await screen.findByLabelText(/^Price/);
    expect(screen.queryByText("No payment account is connected")).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Full price/ }));
    expect(await screen.findByText("No payment account is connected")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /choose Payments/ })).toHaveAttribute("href", "/settings");
    expect(screen.getByText("Customers pay ₹800 when they book.")).toBeInTheDocument();
  });

  it("shows server field errors beside the field", async () => {
    const user = userEvent.setup();
    setup({ save: () => new Response(JSON.stringify({ error: { code: "invalid", message: "Check the price.", fieldErrors: { priceMinor: ["That price is too high."] } } }), { status: 422 }) });
    const price = await screen.findByLabelText(/^Price/);
    await user.clear(price);
    await user.type(price, "900");
    await user.click(screen.getByRole("button", { name: "Save payment settings" }));
    expect(await screen.findByText("That price is too high.")).toBeInTheDocument();
  });

  it("is only a note in the preview", async () => {
    const requests = setup({ saves: false });
    expect(await screen.findByText(/not saved in the preview/)).toBeInTheDocument();
    expect(requests.some((request) => request.url.includes("/payment"))).toBe(false);
  });
});
