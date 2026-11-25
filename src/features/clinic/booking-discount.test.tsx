/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Appointment } from "@/lib/domain";
import { customerPackage, failure, installFetch, json, stubKeys } from "@/test/offers-fixtures";
import { TestQueryProvider } from "@/test/query-wrapper";

import { BookingDiscountControl, useBookingDiscount } from "./booking-discount";
import { StaffApiError } from "./queries/http";
import { useUseCreditAction } from "./use-credit-action";

let lastBody: unknown;
function Harness({ live = true, anonymous = false }: { live?: boolean; anonymous?: boolean }) {
  const discount = useBookingDiscount();
  return (
    <>
      <BookingDiscountControl discount={discount} live={live} patientId={anonymous ? undefined : "pat1"} serviceId="service_cleaning" />
      <button type="button" onClick={() => { lastBody = discount.body(); }}>read body</button>
      <button type="button" onClick={() => discount.capture(new StaffApiError("This code can't be used together with a member price.", 409, "coupon_not_combinable"))}>refuse</button>
      <button type="button" onClick={() => { lastBody = discount.capture(new StaffApiError("Something else", 500, "boom")); }}>refuse other</button>
    </>
  );
}
const renderHarness = (props?: Parameters<typeof Harness>[0]) => render(<TestQueryProvider><Harness {...props} /></TestQueryProvider>);

const customer = {
  packages: [
    customerPackage(),
    customerPackage({ id: "other", name: "Facial pack", serviceIds: ["service_implant"] }),
    customerPackage({ id: "empty", name: "Spent pack", remaining: 0, status: "used_up" }),
    customerPackage({ id: "old", name: "Lapsed pack", status: "expired" }),
  ],
  memberships: [],
};

beforeEach(() => { stubKeys(); lastBody = undefined; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("booking discount control", () => {
  it("lists only packages that can pay for this service, with their balance", async () => {
    const user = userEvent.setup();
    installFetch((_r, url) => url.pathname === "/api/staff/packages/customer" ? json(customer) : undefined);
    renderHarness();
    await user.click(await screen.findByRole("combobox", { name: /^Discount: No discount/ }));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "No discount",
      expect.stringContaining("Use 10 cleanings"),
      "Use a code…",
    ]);
    expect(options[1]).toHaveTextContent("7 of 10 left");
  });

  it("sends the chosen package, or the typed code, never both", async () => {
    const user = userEvent.setup();
    installFetch((_r, url) => url.pathname === "/api/staff/packages/customer" ? json(customer) : undefined);
    renderHarness();
    await user.click(await screen.findByRole("combobox", { name: /^Discount:/ }));
    await user.click(await screen.findByRole("option", { name: /Use 10 cleanings/ }));
    await user.click(screen.getByRole("button", { name: "read body" }));
    expect(lastBody).toEqual({ customerPackageId: "cpk1" });

    await user.click(screen.getByRole("combobox", { name: /^Discount:/ }));
    await user.click(await screen.findByRole("option", { name: "Use a code…" }));
    await user.type(screen.getByRole("textbox", { name: "Discount code" }), "welcome10");
    await user.click(screen.getByRole("button", { name: "read body" }));
    expect(lastBody).toEqual({ couponCode: "welcome10" });

    await user.click(screen.getByRole("combobox", { name: /^Discount:/ }));
    await user.click(await screen.findByRole("option", { name: "No discount" }));
    await user.click(screen.getByRole("button", { name: "read body" }));
    expect(lastBody).toEqual({});
  });

  it("shows the server's refusal beside the field and ignores errors about other things", async () => {
    const user = userEvent.setup();
    installFetch((_r, url) => url.pathname === "/api/staff/packages/customer" ? json({ packages: [], memberships: [] }) : undefined);
    renderHarness();
    await user.click(await screen.findByRole("combobox", { name: /^Discount:/ }));
    await user.click(await screen.findByRole("option", { name: "Use a code…" }));
    await user.click(screen.getByRole("button", { name: "refuse other" }));
    expect(lastBody).toBe(false);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "refuse" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("can't be used together with a member price");
    const field = screen.getByRole("textbox", { name: "Discount code" });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(/member price/);
    await user.type(field, "x");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers only a code for a customer who is not saved yet, without asking for packages", async () => {
    const user = userEvent.setup();
    const requests = installFetch(() => undefined);
    renderHarness({ anonymous: true });
    await user.click(await screen.findByRole("combobox", { name: /^Discount:/ }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["No discount", "Use a code…"]);
    expect(requests).toHaveLength(0);
  });

  it("shows nothing in the preview", () => {
    renderHarness({ live: false });
    expect(screen.queryByRole("region", { name: "Discount" })).not.toBeInTheDocument();
  });
});

const visit = { id: "apt1", patientId: "pat1", serviceId: "service_cleaning", status: "booked", priceMinor: 150000 } as unknown as Appointment;
function CreditHarness({ appointment = visit, refresh = async () => undefined }: { appointment?: Appointment; refresh?: () => Promise<void> }) {
  const { menu, dialogs } = useUseCreditAction({ appointment, serviceName: "Routine cleaning", enabled: true, refresh });
  return <>{menu.map((entry) => entry.kind === undefined || entry.kind === "item" ? <button key={entry.id} type="button" onClick={entry.onSelect}>{entry.label}</button> : null)}{dialogs}</>;
}
const renderCredit = (props?: Parameters<typeof CreditHarness>[0]) => render(<TestQueryProvider><CreditHarness {...props} /></TestQueryProvider>);

describe("use a package credit on a visit", () => {
  it("is offered only for a priced visit with nothing paid", () => {
    installFetch(() => undefined);
    renderCredit({ appointment: { ...visit, paidMinor: 50000 } as Appointment });
    expect(screen.queryByRole("button", { name: /Use a package credit/ })).not.toBeInTheDocument();
    cleanup();
    renderCredit({ appointment: { ...visit, priceMinor: undefined } as unknown as Appointment });
    expect(screen.queryByRole("button", { name: /Use a package credit/ })).not.toBeInTheDocument();
  });

  it("pays the visit with one credit and refreshes", async () => {
    const user = userEvent.setup();
    const refresh = vi.fn(async () => undefined);
    const requests = installFetch((request, url) => {
      if (url.pathname === "/api/staff/packages/customer") return json(customer);
      if (url.pathname === "/api/staff/appointments/apt1/use-credit") return json(customerPackage({ remaining: 6 }), 201);
      return undefined;
    });
    renderCredit({ refresh });
    await user.click(screen.getByRole("button", { name: /Use a package credit/ }));
    const dialog = await screen.findByRole("dialog", { name: "Use a package credit" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Use 1 credit" })).toBeEnabled());
    await user.click(within(dialog).getByRole("button", { name: "Use 1 credit" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const call = requests.find((request) => request.url.includes("use-credit"))!;
    expect(call.body).toEqual({ customerPackageId: "cpk1" });
    expect(call.headers["Idempotency-Key"]).toMatch(/^key-/);
  });

  it("explains when no package covers the service, and shows the server's refusal", async () => {
    const user = userEvent.setup();
    installFetch((_r, url) => url.pathname === "/api/staff/packages/customer" ? json({ packages: [], memberships: [] }) : undefined);
    renderCredit();
    await user.click(screen.getByRole("button", { name: /Use a package credit/ }));
    expect(await screen.findByText(/no package with sessions left for Routine cleaning/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use 1 credit" })).toBeDisabled();
    cleanup();

    installFetch((_r, url) => {
      if (url.pathname === "/api/staff/packages/customer") return json(customer);
      return failure(409, "package_expired", "This package has expired.");
    });
    renderCredit();
    await user.click(screen.getByRole("button", { name: /Use a package credit/ }));
    const dialog = await screen.findByRole("dialog", { name: "Use a package credit" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Use 1 credit" })).toBeEnabled());
    await user.click(within(dialog).getByRole("button", { name: "Use 1 credit" }));
    expect(await within(dialog).findByText("This package has expired.")).toBeInTheDocument();
  });
});
