/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BillingState } from "@/lib/billing-contracts";
import { TestQueryProvider } from "@/test/query-wrapper";

import { fixedNow, freeState, inDays, makeState, paidState } from "./billing-fixtures";
import { BillingSettings } from "./billing-settings";
import type { CheckoutDeps } from "./checkout";

vi.mock("@/features/clinic/clinic-catalog", () => ({ useCatalogLookups: () => ({ database: true }) }));

let state: BillingState;
let calls: Array<{ url: string; method: string; body: unknown }>;
let respond: (url: string, method: string) => Response | null;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status });

beforeEach(() => {
  calls = [];
  respond = () => null;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: input, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return respond(input, method) ?? (method === "GET" ? json(state) : json({}));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const deps = () => ({ navigate: vi.fn<CheckoutDeps["navigate"]>(), loadRazorpay: vi.fn<CheckoutDeps["loadRazorpay"]>() });

async function show(next: BillingState, checkoutDeps: CheckoutDeps = deps()) {
  state = next;
  const user = userEvent.setup();
  render(<TestQueryProvider><BillingSettings now={fixedNow} checkoutDeps={checkoutDeps} /></TestQueryProvider>);
  await screen.findByRole("heading", { name: next.plan.name, level: 3 });
  return user;
}
const plan = (name: string) => screen.getByRole("heading", { name, level: 4 }).closest("li") as HTMLElement;

describe("current plan card", () => {
  it("says a trial has days left and needs no card", async () => {
    await show(makeState());
    expect(screen.getByText("Growth trial, 9 days left, no card needed")).toBeInTheDocument();
    expect(screen.getAllByText("Trial").length).toBeGreaterThan(0);
  });

  it("says Free when on Free", async () => {
    await show(freeState());
    expect(screen.getByText("Free", { selector: "p.text-muted-foreground" })).toBeInTheDocument();
  });

  it("shows the renewal date and a pending downgrade", async () => {
    await show(paidState("growth", { pendingPlanKey: "starter" }));
    expect(screen.getByText(/Renews on 1 Dec/)).toBeInTheDocument();
    expect(screen.getByText(/Changes to Starter on 1 Dec/)).toBeInTheDocument();
  });

  it("offers Keep my plan when the plan ends, and resumes it", async () => {
    const user = await show(paidState("starter", { cancelAtPeriodEnd: true }));
    expect(screen.getByText(/Your plan ends on 1 Dec, then you move to Free. Nothing is deleted./)).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Keep my plan" })[0]!);
    await waitFor(() => expect(calls.some((call) => call.url === "/api/staff/billing/resume" && call.method === "POST")).toBe(true));
  });

  it("explains a failed payment with the date full service ends", async () => {
    await show(paidState("starter", { status: "past_due", graceEndsAt: inDays(5) }));
    expect(screen.getByText(/Your last payment didn't go through. Update your payment method by 24 Nov to keep your plan./)).toBeInTheDocument();
  });

  it("shows an error with a retry when the plan cannot load", async () => {
    respond = () => json({ code: "x", message: "Plans are down." }, 500);
    render(<TestQueryProvider><BillingSettings now={fixedNow} /></TestQueryProvider>);
    expect(await screen.findByText("Plans are down.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("plans", () => {
  it("shows every plan with its numbers from the server and marks the current one", async () => {
    await show(paidState("starter"));
    expect(within(plan("Starter")).getByText("Your plan")).toBeInTheDocument();
    expect(within(plan("Starter")).getByText(/^3 \S+ calendars$/)).toBeInTheDocument();
    expect(within(plan("Growth")).getByText(/^10 \S+ calendars$/)).toBeInTheDocument();
    expect(within(plan("Scale")).getByText(/^Unlimited \S+ calendars$/)).toBeInTheDocument();
    expect(within(plan("Free")).getByText("Free", { selector: "p.tabular-nums" })).toBeInTheDocument();
  });

  it("puts the right button on each plan for a Starter subscriber", async () => {
    await show(paidState("starter"));
    expect(within(plan("Starter")).getByRole("button")).toBeDisabled();
    expect(within(plan("Growth")).getByRole("button", { name: /Upgrade/ })).toBeEnabled();
    expect(within(plan("Free")).getByRole("button", { name: /Cancel plan/ })).toBeEnabled();
  });

  it("explains pro-rating before an upgrade and calls change-plan", async () => {
    const user = await show(paidState("starter"));
    await user.click(within(plan("Growth")).getByRole("button", { name: /Upgrade/ }));
    const dialog = await screen.findByRole("dialog", { name: "Upgrade to Growth?" });
    expect(within(dialog).getByText(/pro-rated difference/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Upgrade now" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/api/staff/billing/change-plan", method: "POST", body: { planKey: "growth" } }));
  });

  it("says a downgrade waits for the period end", async () => {
    const user = await show(paidState("growth"));
    await user.click(within(plan("Starter")).getByRole("button", { name: /Downgrade at period end/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/You keep Growth until 1 Dec/)).toBeInTheDocument();
    expect(within(dialog).getByText(/read-only/)).toBeInTheDocument();
  });

  it("says payments are not connected, keeps the comparison and disables the buttons", async () => {
    await show(makeState({}, { checkoutAvailable: false }));
    expect(screen.getByText(/Payments for plans aren't connected yet/)).toBeInTheDocument();
    expect(within(plan("Starter")).getByText(/^3 \S+ calendars$/)).toBeInTheDocument();
    expect(within(plan("Starter")).getByRole("button")).toBeDisabled();
    expect(within(plan("Starter")).getByRole("button")).toHaveAccessibleDescription(/aren't connected yet/);
  });
});

describe("checkout", () => {
  it("goes to Stripe's page for a redirect", async () => {
    const checkoutDeps = deps();
    respond = (url) => (url === "/api/staff/billing/checkout" ? json({ kind: "redirect", url: "https://checkout.stripe.com/c/pay/abc" }) : null);
    const user = await show(freeState(), checkoutDeps);
    await user.click(within(plan("Starter")).getByRole("button", { name: /Choose plan/ }));
    await waitFor(() => expect(checkoutDeps.navigate).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/abc"));
    expect(calls).toContainEqual({ url: "/api/staff/billing/checkout", method: "POST", body: { planKey: "starter" } });
    expect(checkoutDeps.loadRazorpay).not.toHaveBeenCalled();
  });

  it("opens Razorpay's sheet with the key and subscription id, then waits for the plan to turn active", async () => {
    const open = vi.fn();
    let options: { key: string; subscription_id: string; handler: () => void } | undefined;
    class FakeRazorpay { constructor(given: NonNullable<typeof options>) { options = given; } open = open; }
    const checkoutDeps: CheckoutDeps = { navigate: vi.fn(), loadRazorpay: vi.fn(async () => FakeRazorpay as never) };
    respond = (url, method) => {
      if (url === "/api/staff/billing/checkout") return json({ kind: "razorpay", keyId: "rzp_test_key", subscriptionId: "sub_123" });
      if (method === "GET") return json(options ? paidState("starter") : freeState());
      return null;
    };
    const user = await show(freeState(), checkoutDeps);
    await user.click(within(plan("Starter")).getByRole("button", { name: /Choose plan/ }));
    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(options).toMatchObject({ key: "rzp_test_key", subscription_id: "sub_123" });
    options!.handler();
    await waitFor(() => expect(within(plan("Starter")).getByText("Your plan")).toBeInTheDocument());
    expect(window.location.href).not.toContain("razorpay");
  });

  it("does nothing more when the Razorpay sheet is closed", async () => {
    let options: { modal: { ondismiss: () => void } } | undefined;
    class FakeRazorpay { constructor(given: NonNullable<typeof options>) { options = given; } open = () => options!.modal.ondismiss(); }
    const checkoutDeps: CheckoutDeps = { navigate: vi.fn(), loadRazorpay: vi.fn(async () => FakeRazorpay as never) };
    respond = (url) => (url === "/api/staff/billing/checkout" ? json({ kind: "razorpay", keyId: "k", subscriptionId: "s" }) : null);
    const user = await show(freeState(), checkoutDeps);
    await user.click(within(plan("Growth")).getByRole("button", { name: /Choose plan/ }));
    await waitFor(() => expect(within(plan("Growth")).getByRole("button")).toBeEnabled());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows why checkout could not start", async () => {
    respond = (url) => (url === "/api/staff/billing/checkout" ? json({ code: "x", message: "Razorpay said no." }, 502) : null);
    const user = await show(freeState());
    await user.click(within(plan("Growth")).getByRole("button", { name: /Choose plan/ }));
    expect(await screen.findByText("Razorpay said no.")).toBeInTheDocument();
  });
});

describe("cancel", () => {
  it("takes two clicks, shows what happens and links to the data export", async () => {
    const user = await show(paidState("starter"));
    await user.click(screen.getByRole("button", { name: "More plan actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Cancel plan" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/until 1 Dec/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Nothing is deleted/)).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Download my data first" })).toHaveAttribute("href", "/settings/privacy-requests");
    expect(calls.some((call) => call.url.endsWith("/cancel"))).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Yes, cancel at period end" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/api/staff/billing/cancel", method: "POST", body: {} }));
  });

  it("keeps the plan when the person backs out", async () => {
    const user = await show(paidState("starter"));
    await user.click(screen.getByRole("button", { name: "More plan actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Cancel plan" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Keep my plan" }));
    expect(calls.some((call) => call.url.endsWith("/cancel"))).toBe(false);
  });
});

describe("usage", () => {
  const withUsage = (used: number) => paidState("starter", {}, { usage: [{ metric: "whatsapp", used, included: 200 }, { metric: "bookings", used: 31, included: null }] });
  async function openUsage(next: BillingState) {
    const user = await show(next);
    await user.click(screen.getByRole("tab", { name: "Usage" }));
    return user;
  }

  it("shows used of included without a warning below 80%", async () => {
    await openUsage(withUsage(100));
    expect(screen.getByText("100 of 200 used")).toBeInTheDocument();
    expect(screen.queryByText("Almost used up")).toBeNull();
    expect(screen.getByText("31 used")).toBeInTheDocument();
  });

  it("says Almost used up at 80% and All used at 100%, in words", async () => {
    await openUsage(withUsage(160));
    expect(screen.getByText("Almost used up")).toBeInTheDocument();
    cleanup();
    await openUsage(withUsage(200));
    expect(screen.getByText("All used")).toBeInTheDocument();
    expect(screen.getByText(/Marketing messages are stopped until next month/)).toBeInTheDocument();
  });

  it("saves the owner's choice and says confirmations are never stopped", async () => {
    const user = await openUsage(withUsage(10));
    expect(screen.getByText("Appointment confirmations and reminders are never stopped.")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: /When messages run out/ }));
    await user.click(await screen.findByRole("option", { name: "Charge me per message" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/api/staff/billing/settings", method: "PATCH", body: { overageMode: "bill_overage" } }));
  });
});

describe("invoices and GSTIN", () => {
  async function openBilling(next: BillingState) {
    const user = await show(next);
    await user.click(screen.getByRole("tab", { name: "Invoices" }));
    return user;
  }

  it("says there are no invoices yet", async () => {
    await openBilling(freeState());
    expect(screen.getByText("No invoices yet")).toBeInTheDocument();
  });

  it("lists invoices with GST and a link to the printable one", async () => {
    await openBilling(paidState("starter", {}, { invoices: [{ id: "inv1", invoiceNumber: "KAL-2026-0001", issuedAt: inDays(-5), planKey: "starter", currency: "INR", amountMinor: 49_900, gstMinor: 8_982, totalMinor: 58_882, kalendrGstin: null, buyerGstin: null }] }));
    expect(screen.getByRole("link", { name: "KAL-2026-0001" })).toHaveAttribute("href", "/billing/invoices/inv1");
    expect(screen.getByText("₹89.82")).toBeInTheDocument();
    expect(screen.getByText("₹588.82")).toBeInTheDocument();
  });

  it("refuses a bad GSTIN beside the field and saves a good one", async () => {
    const user = await openBilling(freeState());
    const field = screen.getByLabelText(/GSTIN/);
    await user.type(field, "nope");
    await user.click(screen.getByRole("button", { name: "Save GSTIN" }));
    expect(await screen.findByText(/doesn't look like a GSTIN/)).toBeInTheDocument();
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
    await user.clear(field);
    await user.type(field, "22aaaaa0000a1z5");
    await user.click(screen.getByRole("button", { name: "Save GSTIN" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/api/staff/billing/settings", method: "PATCH", body: { billingGstin: "22AAAAA0000A1Z5" } }));
  });

  it("shows the server's message beside the field", async () => {
    respond = (url, method) => (method === "PATCH" ? json({ code: "validation_failed", message: "Invalid", fieldErrors: { billingGstin: ["That GSTIN is not valid."] } }, 422) : null);
    const user = await openBilling(freeState());
    await user.type(screen.getByLabelText(/GSTIN/), "22AAAAA0000A1Z5");
    await user.click(screen.getByRole("button", { name: "Save GSTIN" }));
    expect(await screen.findByText("That GSTIN is not valid.")).toBeInTheDocument();
  });
});
