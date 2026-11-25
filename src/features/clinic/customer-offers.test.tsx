/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Permission } from "@/lib/permissions";
import { permissionKeys } from "@/lib/permissions";
import { chooseOption } from "@/test/choose-option";
import { customerPackage, failure, installFetch, json, membershipView, packageView, planView, stubKeys, type Req } from "@/test/offers-fixtures";
import { TestQueryProvider } from "@/test/query-wrapper";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));

import { CustomerOffersSection } from "./customer-offers";
import { StaffAccessProvider } from "./staff-access";
import { StaffSnapshotProvider } from "./staff-snapshot-provider";

function renderSection({ permissions = permissionKeys, database = true }: { permissions?: readonly Permission[]; database?: boolean } = {}) {
  const inner = <StaffAccessProvider role="owner" permissions={permissions} userId={null}><CustomerOffersSection patientId="pat1" /></StaffAccessProvider>;
  return render(<TestQueryProvider>{database ? <StaffSnapshotProvider role="owner">{inner}</StaffSnapshotProvider> : inner}</TestQueryProvider>);
}

const summary = { packages: [packageView()], plans: [planView()], coupons: [] };
function handlerWith(customer: unknown, extra?: (request: Req, url: URL) => Response | undefined) {
  return (request: Req, url: URL) => {
    if (url.pathname === "/api/staff/packages/customer") return json(customer);
    if (url.pathname === "/api/staff/offers") return json(summary);
    if (url.pathname === "/api/staff/tax-settings") return json({ registered: false });
    return extra?.(request, url);
  };
}
const moreMenu = async (user: ReturnType<typeof userEvent.setup>, name: string) => user.click(await screen.findByRole("button", { name }));

beforeEach(() => stubKeys());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("packages and memberships on the customer profile", () => {
  it("shows the balance, expiry and a status in words, with a history that explains every change", async () => {
    const user = userEvent.setup();
    installFetch(handlerWith({ packages: [customerPackage(), customerPackage({ id: "cpk2", name: "Old pack", status: "expired", remaining: 2, creditsTotal: 5, ledger: [] })], memberships: [] }));
    renderSection();
    const list = await screen.findByRole("list", { name: "Packages" });
    expect(within(list).getByText("7 of 10 left")).toBeInTheDocument();
    expect(within(list).getByText(/Valid until 30 March/)).toBeInTheDocument();
    expect(within(list).getByText("Active")).toBeInTheDocument();
    expect(within(list).getByText("Expired")).toBeInTheDocument();
    expect(within(list).getByText(/Ran out on/)).toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: /History \(3\)/ }));
    const history = await screen.findByRole("list", { name: "History" });
    const rows = within(history).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Changed by hand");
    expect(rows[0]).toHaveTextContent("Gift reversed");
    expect(rows[0]).toHaveTextContent("−2");
    expect(rows[0]).toHaveTextContent("7 left");
    expect(rows[1]).toHaveTextContent("Used");
    expect(rows[1]).toHaveTextContent("9 left");
    expect(rows[2]).toHaveTextContent("Bought");
    expect(rows[2]).toHaveTextContent("+10");
  });

  it("shows a loading state, an empty note and an error that can be retried", async () => {
    const user = userEvent.setup();
    let calls = 0;
    installFetch((request, url) => {
      if (url.pathname === "/api/staff/packages/customer") return ++calls === 1 ? failure(500, "boom", "Packages are down.") : json({ packages: [], memberships: [] });
      return handlerWith({})(request, url);
    });
    renderSection();
    expect(await screen.findByRole("status", { name: "Loading packages" })).toBeInTheDocument();
    expect(await screen.findByText("Packages are down.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No packages or memberships yet.")).toBeInTheDocument();
  });

  it("stays out of the preview and sends nothing", () => {
    const requests = installFetch(() => undefined);
    renderSection({ database: false });
    expect(screen.queryByRole("region", { name: "Packages and memberships" })).not.toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it("sells a package split across two methods; the rest stays owing", async () => {
    const user = userEvent.setup();
    const requests = installFetch(handlerWith({ packages: [], memberships: [] }, (request, url) => url.pathname === "/api/staff/packages/sell" ? json(customerPackage(), 201) : undefined));
    renderSection();
    await waitFor(() => expect(screen.getByRole("button", { name: "Sell a package" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Sell a package" }));
    const dialog = await screen.findByRole("dialog", { name: "Sell a package" });
    expect(within(dialog).getByRole("status")).toHaveTextContent("Taking ₹4,500 of ₹4,500.");
    const first = within(dialog).getByRole("textbox", { name: "Amount 1 (₹)" });
    await user.clear(first);
    await user.type(first, "3000");
    await user.click(within(dialog).getByRole("button", { name: /Split across another method/ }));
    await user.type(within(dialog).getByRole("textbox", { name: "Amount 2 (₹)" }), "1000");
    await chooseOption(user, within(dialog).getByRole("combobox", { name: "Method 2" }), "UPI");
    expect(within(dialog).getByRole("status")).toHaveTextContent("Taking ₹4,000 of ₹4,500. ₹500 stays owing.");
    await user.click(within(dialog).getByRole("button", { name: "Sell package" }));
    await waitFor(() => expect(requests.some((request) => request.url.endsWith("/sell"))).toBe(true));
    const call = requests.find((request) => request.url.endsWith("/sell"))!;
    expect(call.body).toEqual({ patientId: "pat1", packageId: "pk1", locationId: "loc_indiranagar", payments: [{ method: "cash", amountMinor: 300000 }, { method: "upi", amountMinor: 100000 }] });
    expect(call.headers["Idempotency-Key"]).toMatch(/^key-/);
  });

  it("refuses an amount above the price before asking the server", async () => {
    const user = userEvent.setup();
    const requests = installFetch(handlerWith({ packages: [], memberships: [] }));
    renderSection();
    await waitFor(() => expect(screen.getByRole("button", { name: "Sell a package" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Sell a package" }));
    const dialog = await screen.findByRole("dialog", { name: "Sell a package" });
    const first = within(dialog).getByRole("textbox", { name: "Amount 1 (₹)" });
    await user.clear(first);
    await user.type(first, "9000");
    await user.click(within(dialog).getByRole("button", { name: "Sell package" }));
    expect(await within(dialog).findByText(/more than the price, ₹4,500/)).toBeInTheDocument();
    expect(requests.some((request) => request.url.endsWith("/sell"))).toBe(false);
  });

  it("asks for the customer's GSTIN only when the business is registered", async () => {
    const user = userEvent.setup();
    installFetch((request, url) => url.pathname === "/api/staff/tax-settings" ? json({ registered: true }) : handlerWith({ packages: [], memberships: [] })(request, url));
    renderSection();
    await waitFor(() => expect(screen.getByRole("button", { name: "Sell a package" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Sell a package" }));
    const dialog = await screen.findByRole("dialog", { name: "Sell a package" });
    await user.type(await within(dialog).findByRole("textbox", { name: /GSTIN/ }), "NOT-A-GSTIN");
    await user.click(within(dialog).getByRole("button", { name: "Sell package" }));
    expect(await within(dialog).findByText(/That GSTIN does not look right/)).toBeInTheDocument();
  });

  it("adjusts credits with a reason and sends the signed change", async () => {
    const user = userEvent.setup();
    const requests = installFetch(handlerWith({ packages: [customerPackage()], memberships: [] }, (request, url) => url.pathname === "/api/staff/packages/credits/cpk1" ? json(customerPackage({ remaining: 8 })) : undefined));
    renderSection();
    await screen.findByText("7 of 10 left");
    await moreMenu(user, "More package actions");
    await user.click(await screen.findByRole("menuitem", { name: /Adjust credits/ }));
    const dialog = await screen.findByRole("dialog", { name: "Adjust credits" });
    await user.type(within(dialog).getByRole("textbox", { name: "Change" }), "0");
    await user.click(within(dialog).getByRole("button", { name: "Save change" }));
    expect(await within(dialog).findByText(/Enter how many to add or take away/)).toBeInTheDocument();
    expect(await within(dialog).findByText(/Say why/)).toBeInTheDocument();
    await user.clear(within(dialog).getByRole("textbox", { name: "Change" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Change" }), "1");
    await user.type(within(dialog).getByRole("textbox", { name: "Why" }), "Referral gift");
    await user.click(within(dialog).getByRole("button", { name: "Save change" }));
    await waitFor(() => expect(requests.some((request) => request.url.includes("/credits/"))).toBe(true));
    const call = requests.find((request) => request.url.includes("/credits/"))!;
    expect(call.body).toEqual({ change: 1, reason: "Referral gift" });
    expect(call.headers["Idempotency-Key"]).toMatch(/^key-/);
  });

  it("hides adjust and sell from someone without those rights", async () => {
    installFetch(handlerWith({ packages: [customerPackage()], memberships: [] }));
    renderSection({ permissions: ["schedule.read"] });
    await screen.findByText("7 of 10 left");
    expect(screen.queryByRole("button", { name: "Sell a package" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More package actions" })).not.toBeInTheDocument();
  });

  it("starts a membership with how the first month was paid", async () => {
    const user = userEvent.setup();
    const requests = installFetch(handlerWith({ packages: [], memberships: [] }, (request, url) => url.pathname === "/api/staff/memberships" && request.method === "POST" ? json(membershipView(), 201) : undefined));
    renderSection();
    await screen.findByText("No packages or memberships yet.");
    await waitFor(() => expect(screen.getByRole("button", { name: "More package actions" })).toBeEnabled());
    await moreMenu(user, "More package actions");
    await user.click(await screen.findByRole("menuitem", { name: /Start a membership/ }));
    const dialog = await screen.findByRole("dialog", { name: "Start a membership" });
    await chooseOption(user, within(dialog).getByRole("combobox", { name: "How the first month was paid" }), "Card");
    await user.click(within(dialog).getByRole("button", { name: "Start membership" }));
    await waitFor(() => expect(requests.some((request) => request.url === "/api/staff/memberships")).toBe(true));
    const call = requests.find((request) => request.url === "/api/staff/memberships")!;
    expect(call.body).toEqual({ patientId: "pat1", planId: "pl1", method: "card" });
    expect(call.headers["Idempotency-Key"]).toMatch(/^key-/);
  });

  it("says when benefits stop for a failed payment, and records this month's payment", async () => {
    const user = userEvent.setup();
    const requests = installFetch(handlerWith({ packages: [], memberships: [membershipView({ status: "past_due", graceEndsAt: "2026-11-27T09:00:00.000Z" })] }, (request, url) => url.pathname === "/api/staff/memberships/mem1" ? json(membershipView(), 201) : undefined));
    renderSection();
    expect(await screen.findByText("Payment failed – benefits stop on 27 November")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Record this month/ }));
    const dialog = await screen.findByRole("dialog", { name: /Record this month/ });
    await user.click(within(dialog).getByRole("button", { name: "Record payment" }));
    await waitFor(() => expect(requests.some((request) => request.url.endsWith("/mem1"))).toBe(true));
    const call = requests.find((request) => request.url.endsWith("/mem1"))!;
    expect(call.body).toEqual({ action: "renew", method: "cash" });
    expect(call.headers["Idempotency-Key"]).toMatch(/^key-/);
  });

  it("pauses a membership from the menu and shows the server's reason when the provider bills it", async () => {
    const user = userEvent.setup();
    const reason = "Change this membership at the payment provider. The change arrives here by itself.";
    const requests = installFetch(handlerWith({ packages: [], memberships: [membershipView()] }, (request, url) => url.pathname === "/api/staff/memberships/mem1" ? failure(409, "billed_by_provider", reason) : undefined));
    renderSection();
    await screen.findByText("Gold membership");
    await moreMenu(user, "More for Gold membership");
    await user.click(await screen.findByRole("menuitem", { name: "Pause" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(reason);
    expect(requests.find((request) => request.url.endsWith("/mem1"))!.body).toEqual({ action: "pause" });
  });

  it("does not submit the profile form it sits inside when a dialog is submitted", async () => {
    const user = userEvent.setup();
    const outer = vi.fn((event: React.FormEvent) => event.preventDefault());
    installFetch(handlerWith({ packages: [customerPackage()], memberships: [] }));
    render(
      <TestQueryProvider>
        <StaffSnapshotProvider role="owner">
          <StaffAccessProvider role="owner" permissions={permissionKeys} userId={null}><form onSubmit={outer}><CustomerOffersSection patientId="pat1" /></form></StaffAccessProvider>
        </StaffSnapshotProvider>
      </TestQueryProvider>,
    );
    await screen.findByText("7 of 10 left");
    await moreMenu(user, "More package actions");
    await user.click(await screen.findByRole("menuitem", { name: /Adjust credits/ }));
    const dialog = await screen.findByRole("dialog", { name: "Adjust credits" });
    await user.click(within(dialog).getByRole("button", { name: "Save change" }));
    expect(await within(dialog).findByText(/Say why/)).toBeInTheDocument();
    expect(outer).not.toHaveBeenCalled();
  });
});
