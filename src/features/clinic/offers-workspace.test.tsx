/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Permission } from "@/lib/permissions";
import { permissionKeys } from "@/lib/permissions";
import { chooseOption } from "@/test/choose-option";
import { couponView, failure, installFetch, json, packageView, planView, stubKeys, type Req } from "@/test/offers-fixtures";
import { TestQueryProvider } from "@/test/query-wrapper";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));

import { CouponPreview } from "./offers-forms";
import { OffersWorkspace } from "./offers-workspace";
import { StaffAccessProvider } from "./staff-access";
import { StaffSnapshotProvider } from "./staff-snapshot-provider";

function renderWorkspace({ permissions = permissionKeys, database = true }: { permissions?: readonly Permission[]; database?: boolean } = {}) {
  const inner = <StaffAccessProvider role="owner" permissions={permissions} userId={null}><OffersWorkspace /></StaffAccessProvider>;
  return render(<TestQueryProvider>{database ? <StaffSnapshotProvider role="owner">{inner}</StaffSnapshotProvider> : inner}</TestQueryProvider>);
}
const offers = (data: { packages?: unknown[]; plans?: unknown[]; coupons?: unknown[] } = {}) => json({ packages: [], plans: [], coupons: [], ...data });

beforeEach(() => stubKeys());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("offers workspace", () => {
  it("shows loading, then packages with sold count and credits outstanding", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    installFetch((_r, url) => url.pathname === "/api/staff/offers" ? held.then(() => offers({ packages: [packageView(), packageView({ id: "pk2", name: "Old pack", isActive: false, sold: 0, creditsOutstanding: 0 })] })) : undefined);
    renderWorkspace();
    expect(await screen.findByRole("status", { name: "Loading offers" })).toBeInTheDocument();
    release();
    const list = await screen.findByRole("list", { name: "Packages" });
    expect(within(list).getByText("10 cleanings")).toBeInTheDocument();
    expect(within(list).getByText(/3 sold · 18 sessions not yet used/)).toBeInTheDocument();
    expect(within(list).getAllByText(/₹4,500 · 10 sessions · valid 365 days · Routine cleaning/)).toHaveLength(2);
    expect(within(list).getByText("Switched off")).toBeInTheDocument();
  });

  it("explains an empty tab in each of the three tabs", async () => {
    const user = userEvent.setup();
    installFetch((_r, url) => url.pathname === "/api/staff/offers" ? offers() : undefined);
    renderWorkspace();
    expect(await screen.findByText("No packages yet")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Memberships" }));
    expect(await screen.findByText("No membership plans yet")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Codes" }));
    expect(await screen.findByText("No codes yet")).toBeInTheDocument();
  });

  it("says what went wrong and loads again when asked", async () => {
    const user = userEvent.setup();
    let calls = 0;
    installFetch((_r, url) => url.pathname === "/api/staff/offers" ? (++calls === 1 ? failure(500, "boom", "Offers are down.") : offers({ packages: [packageView()] })) : undefined);
    renderWorkspace();
    expect(await screen.findByText("Offers are down.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("10 cleanings")).toBeInTheDocument();
  });

  it("says offers are not available in the preview and sends nothing", () => {
    const requests = installFetch(() => undefined);
    renderWorkspace({ database: false });
    expect(screen.getByText("Offers are not available in the preview")).toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it("hides the create and edit actions from someone who cannot change prices", async () => {
    installFetch((_r, url) => url.pathname === "/api/staff/offers" ? offers({ packages: [packageView()] }) : undefined);
    renderWorkspace({ permissions: ["schedule.read"] });
    await screen.findByText("10 cleanings");
    expect(screen.queryByRole("button", { name: /New package/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("creates a package: asks for services, then sends prices in paise", async () => {
    const user = userEvent.setup();
    const requests = installFetch((request, url) => {
      if (url.pathname === "/api/staff/offers") return offers();
      if (url.pathname === "/api/staff/packages" && request.method === "POST") return json({ ...packageView(), id: "new" }, 201);
      return undefined;
    });
    renderWorkspace();
    await user.click(await screen.findByRole("button", { name: /Create your first package/ }));
    const sheet = await screen.findByRole("dialog");
    await user.type(within(sheet).getByRole("textbox", { name: "Name" }), "5 massages");
    await user.type(within(sheet).getByRole("textbox", { name: "Price (₹)" }), "2500");
    await user.click(within(sheet).getByRole("button", { name: "Create package" }));
    expect(await within(sheet).findByText("Choose at least one service.")).toBeInTheDocument();
    expect(requests.some((request) => request.method === "POST")).toBe(false);
    await user.click(within(sheet).getByRole("checkbox", { name: "Routine cleaning" }));
    await user.click(within(sheet).getByRole("button", { name: "Create package" }));
    await waitFor(() => expect(requests.some((request) => request.method === "POST")).toBe(true));
    expect(requests.find((request) => request.method === "POST")!.body).toEqual({ name: "5 massages", priceMinor: 250000, credits: 10, validDays: 365, serviceIds: ["service_cleaning"], isActive: true });
  });

  it("puts a server field message beside its field", async () => {
    const user = userEvent.setup();
    installFetch((request, url) => {
      if (url.pathname === "/api/staff/offers") return offers({ packages: [packageView()] });
      if (url.pathname === "/api/staff/packages/pk1" && request.method === "PUT") return failure(400, "validation_error", "Check the form.", { name: ["That name is already used."] });
      return undefined;
    });
    renderWorkspace();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const sheet = await screen.findByRole("dialog");
    await user.click(within(sheet).getByRole("button", { name: "Save package" }));
    expect(await within(sheet).findByText("That name is already used.")).toBeInTheDocument();
  });

  it("switches a package off from the menu, carrying its version", async () => {
    const user = userEvent.setup();
    const requests = installFetch((request, url) => {
      if (url.pathname === "/api/staff/offers") return offers({ packages: [packageView({ version: 4 })] });
      if (url.pathname === "/api/staff/packages/pk1" && request.method === "PUT") return json(packageView({ isActive: false, version: 5 }));
      return undefined;
    });
    renderWorkspace();
    await screen.findByText("10 cleanings");
    await user.click(screen.getByRole("button", { name: "More for 10 cleanings" }));
    await user.click(await screen.findByRole("menuitem", { name: /Switch off/ }));
    await waitFor(() => expect(requests.some((request) => request.method === "PUT")).toBe(true));
    expect(requests.find((request) => request.method === "PUT")!.body).toMatchObject({ isActive: false, version: 4, name: "10 cleanings" });
  });

  it("checks a code before saving it and shows what it does to a ₹1,000 booking", async () => {
    const user = userEvent.setup();
    const requests = installFetch((request, url) => {
      if (url.pathname === "/api/staff/offers") return offers();
      if (url.pathname === "/api/staff/coupons" && request.method === "POST") return json(couponView(), 201);
      return undefined;
    });
    renderWorkspace();
    await user.click(await screen.findByRole("tab", { name: "Codes" }));
    await user.click(await screen.findByRole("button", { name: /Create your first code/ }));
    const sheet = await screen.findByRole("dialog");
    await user.type(within(sheet).getByRole("textbox", { name: "Code" }), "a!");
    await user.type(within(sheet).getByRole("textbox", { name: "Percentage (%)" }), "150");
    await user.click(within(sheet).getByRole("button", { name: "Create code" }));
    expect(await within(sheet).findByText(/3 to 32 letters/)).toBeInTheDocument();
    expect(within(sheet).getByText("Enter a percentage from 1 to 100.")).toBeInTheDocument();
    expect(requests.some((request) => request.method === "POST")).toBe(false);

    await user.clear(within(sheet).getByRole("textbox", { name: "Code" }));
    await user.type(within(sheet).getByRole("textbox", { name: "Code" }), "spring 20");
    await user.clear(within(sheet).getByRole("textbox", { name: "Percentage (%)" }));
    await user.type(within(sheet).getByRole("textbox", { name: "Percentage (%)" }), "20");
    const preview = within(sheet).getByRole("status", { name: "What this code does" });
    expect(preview).toHaveTextContent("20% off");
    expect(preview).toHaveTextContent("the customer pays ₹800 (saves ₹200)");
    expect(preview).toHaveTextContent("can't be used together with a member price");
    await user.click(within(sheet).getByRole("switch", { name: "Can be used with a member price" }));
    expect(within(sheet).getByRole("status", { name: "What this code does" })).toHaveTextContent("can be used on top of a member price");
    await user.click(within(sheet).getByRole("button", { name: "Create code" }));
    await waitFor(() => expect(requests.some((request) => request.method === "POST")).toBe(true));
    expect(requests.find((request) => request.method === "POST")!.body).toMatchObject({ code: "SPRING20", kind: "percent", value: 20, stackable: true, maxUses: null, perCustomerLimit: null, validFrom: null, validTo: null, serviceIds: [], firstVisitOnly: false, isActive: true });
  });

  it("shows a fixed-amount code's preview and sends the amount in paise", async () => {
    const user = userEvent.setup();
    const requests = installFetch((request, url) => {
      if (url.pathname === "/api/staff/offers") return offers({ coupons: [couponView({ used: 50 })] });
      if (url.pathname === "/api/staff/coupons" && request.method === "POST") return json(couponView(), 201);
      return undefined;
    });
    renderWorkspace();
    await user.click(await screen.findByRole("tab", { name: "Codes" }));
    const list = await screen.findByRole("list", { name: "Codes" });
    expect(within(list).getByText("Used up")).toBeInTheDocument();
    expect(within(list).getByText(/Used 50 of 50 times/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /New code/ }));
    const sheet = await screen.findByRole("dialog");
    await user.type(within(sheet).getByRole("textbox", { name: "Code" }), "FLAT200");
    await chooseOption(user, within(sheet).getByRole("combobox", { name: "Takes off" }), "A fixed amount");
    await user.type(within(sheet).getByRole("textbox", { name: "Amount (₹)" }), "200");
    expect(within(sheet).getByRole("status", { name: "What this code does" })).toHaveTextContent("the customer pays ₹800");
    await user.click(within(sheet).getByRole("button", { name: "Create code" }));
    await waitFor(() => expect(requests.some((request) => request.method === "POST")).toBe(true));
    expect(requests.find((request) => request.method === "POST")!.body).toMatchObject({ code: "FLAT200", kind: "fixed", value: 20000 });
  });

  it("asks for sessions or a discount on a membership plan", async () => {
    const user = userEvent.setup();
    const requests = installFetch((request, url) => {
      if (url.pathname === "/api/staff/offers") return offers({ plans: [planView()] });
      if (url.pathname === "/api/staff/memberships/plans" && request.method === "POST") return json(planView({ id: "new" }), 201);
      return undefined;
    });
    renderWorkspace();
    await user.click(await screen.findByRole("tab", { name: "Memberships" }));
    const list = await screen.findByRole("list", { name: "Membership plans" });
    expect(within(list).getByText(/₹999 a month · 2 sessions each month · 10% off/)).toBeInTheDocument();
    expect(within(list).getByText("4 members")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /New plan/ }));
    const sheet = await screen.findByRole("dialog");
    await user.type(within(sheet).getByRole("textbox", { name: "Name" }), "Silver");
    await user.type(within(sheet).getByRole("textbox", { name: "Price per month (₹)" }), "499");
    await user.click(within(sheet).getByRole("checkbox", { name: "Routine cleaning" }));
    await user.click(within(sheet).getByRole("button", { name: "Create plan" }));
    expect(await within(sheet).findByText("Give members sessions each month, a discount, or both.")).toBeInTheDocument();
    await user.clear(within(sheet).getByRole("textbox", { name: "Member discount (%)" }));
    await user.type(within(sheet).getByRole("textbox", { name: "Member discount (%)" }), "15");
    await user.click(within(sheet).getByRole("button", { name: "Create plan" }));
    await waitFor(() => expect(requests.some((request: Req) => request.method === "POST")).toBe(true));
    expect(requests.find((request) => request.method === "POST")!.body).toEqual({ name: "Silver", priceMinor: 49900, creditsPerPeriod: 0, memberDiscountPercent: 15, serviceIds: ["service_cleaning"], isActive: true });
  });
});

describe("code preview", () => {
  it("asks for the discount first", () => {
    render(<CouponPreview kind="percent" valueText="" stackable={false} />);
    expect(screen.getByText(/Enter the discount to see/)).toBeInTheDocument();
  });
});
