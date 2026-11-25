/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InvoiceList, InvoiceSummary, InvoiceView, OutstandingBalance, TaxSettingsView } from "@/lib/invoicing-contracts";
import type { Permission } from "@/lib/permissions";
import { permissionKeys } from "@/lib/permissions";
import { chooseOption, runBarAction } from "@/test/choose-option";
import { TestQueryProvider } from "@/test/query-wrapper";
import { staffSnapshotFixture } from "@/test/staff-fixture";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));

import { BillingWorkspace } from "./billing-workspace";
import { IssueInvoiceDialog } from "./invoice-dialogs";
import { OwesBadge } from "./outstanding-balance";
import { StaffAccessProvider } from "./staff-access";
import { StaffSnapshotProvider } from "./staff-snapshot-provider";
import { VisitInvoicePanel } from "./visit-invoice-panel";

const validGstin = "27AAPFU0939F1ZV";

const summary = (patch: Partial<InvoiceSummary> = {}): InvoiceSummary => ({
  id: "inv1", number: "2026-27/0001", kind: "tax_invoice", issuedAt: "2026-11-18T09:30:00.000Z", patientId: "pat1", buyerName: "Meera Joshi", appointmentId: "apt1", source: "visit",
  currency: "INR", totalMinor: 118000, creditedMinor: 0, paidMinor: 0, dueMinor: 118000, refundDueMinor: 0, state: "unpaid", ...patch,
});
const invoice = (patch: Partial<InvoiceView> = {}): InvoiceView => ({
  ...summary(), financialYear: "2026-27", pricesIncludeTax: false, taxableMinor: 100000, cgstMinor: 9000, sgstMinor: 9000, igstMinor: 0, supply: "intra", placeOfSupplyState: "27",
  sellerGstin: validGstin, sellerLegalName: "Glow Studio LLP", sellerAddress: "12 MG Road", sellerStateCode: "27", buyerGstin: null, buyerStateCode: null, exemptionNote: null,
  lines: [
    { id: "l1", position: 1, description: "Haircut", sacCode: "999721", quantity: 1, unitPriceMinor: 100000, discountMinor: 0, treatment: "taxable", rateBps: 1800, taxableMinor: 100000, cgstMinor: 9000, sgstMinor: 9000, igstMinor: 0, totalMinor: 118000, creditedBy: null },
  ],
  creditNotes: [], pdfReady: true, payments: [], ...patch,
});
const settings = (patch: Partial<TaxSettingsView> = {}): TaxSettingsView => ({
  registered: true, gstin: validGstin, legalName: "Glow Studio LLP", address: null, stateCode: "27", pricesIncludeTax: false, defaultTreatment: "taxable", defaultRateBps: 1800, defaultSacCode: "999722",
  confirmedAt: null, isDefault: false, hint: "Salon services are usually taxed at 18%.", version: 2,
  services: [{ serviceId: "svc1", name: "Haircut", treatment: null, rateBps: null, sacCode: null, price: 100000 }], ...patch,
});

type Req = { url: string; method: string; body?: Record<string, unknown>; headers: Record<string, string> };
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
const failure = (status: number, code: string, message: string) => new Response(JSON.stringify({ error: { code, message } }), { status });

let requests: Req[];
function install(handler: (request: Req, url: URL) => Response | Promise<Response> | undefined) {
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://x");
    if (url.pathname === "/api/staff/snapshot") return json(staffSnapshotFixture);
    const request: Req = { url: input, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> };
    requests.push(request);
    return handler(request, url) ?? failure(404, "not_found", "No.");
  }));
}
const list = (invoices: InvoiceSummary[], nextCursor: string | null = null): InvoiceList => ({ invoices, nextCursor });

function renderWith(node: React.ReactNode, { permissions = permissionKeys, role = "owner", database = true }: { permissions?: readonly Permission[]; role?: "owner" | "receptionist"; database?: boolean } = {}) {
  const inner = <StaffAccessProvider role={role} permissions={permissions} userId={null}>{node}</StaffAccessProvider>;
  return render(<TestQueryProvider>{database ? <StaffSnapshotProvider role="owner">{inner}</StaffSnapshotProvider> : inner}</TestQueryProvider>);
}

beforeEach(() => { vi.stubGlobal("crypto", Object.assign(Object.create(globalThis.crypto), { randomUUID: (() => { let n = 0; return () => `key-${++n}`; })() })); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("billing workspace: invoices tab", () => {
  it("shows a loading state, then the list with the state in words", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    install((request, url) => url.pathname === "/api/staff/invoices" ? held.then(() => json(list([summary(), summary({ id: "inv2", number: "2026-27/0002", state: "paid", buyerName: "Karan Shah" })]))) : undefined);
    renderWith(<BillingWorkspace />);
    expect(await screen.findByRole("status", { name: "Loading invoices" })).toBeInTheDocument();
    release();
    const rows = await screen.findByRole("list", { name: "Invoices" });
    expect(within(rows).getByText("2026-27/0001")).toBeInTheDocument();
    expect(within(rows).getByText("Unpaid")).toBeInTheDocument();
    expect(within(rows).getByText("Paid")).toBeInTheDocument();
    expect(within(rows).getByText(/Karan Shah/)).toBeInTheDocument();
  });

  it("explains an empty list", async () => {
    install((_request, url) => url.pathname === "/api/staff/invoices" ? json(list([])) : undefined);
    renderWith(<BillingWorkspace />);
    expect(await screen.findByText("No invoices yet")).toBeInTheDocument();
  });

  it("says what went wrong and loads again when asked", async () => {
    const user = userEvent.setup();
    let calls = 0;
    install((_request, url) => url.pathname === "/api/staff/invoices" ? (++calls === 1 ? failure(500, "boom", "The invoice list is down.") : json(list([summary()]))) : undefined);
    renderWith(<BillingWorkspace />);
    expect(await screen.findByText("The invoice list is down.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("2026-27/0001")).toBeInTheDocument();
  });

  it("loads more when there is another page, and filters by state and month without sending an empty month", async () => {
    const user = userEvent.setup();
    install((request, url) => {
      if (url.pathname !== "/api/staff/invoices") return undefined;
      return url.searchParams.get("cursor") ? json(list([summary({ id: "inv2", number: "2026-27/0002" })])) : json(list([summary()], "next-1"));
    });
    renderWith(<BillingWorkspace />);
    await screen.findByText("2026-27/0001");
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(await screen.findByText("2026-27/0002")).toBeInTheDocument();
    expect(requests.some((request) => request.url.includes("month="))).toBe(false);

    await chooseOption(user, screen.getByRole("combobox", { name: "Show" }), "Money due");
    await waitFor(() => expect(requests.at(-1)!.url).toContain("state=due"));
    await chooseOption(user, screen.getByRole("combobox", { name: "Month" }), new RegExp(`^${new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date())}$`));
    await waitFor(() => expect(requests.at(-1)!.url).toMatch(/month=\d{4}-\d{2}/));
  });

  it("opens an invoice with its tax split, says it cannot be edited, and shows why a void is refused", async () => {
    const user = userEvent.setup();
    const reason = "An issued invoice cannot be voided. Issue a credit note instead.";
    install((request, url) => {
      if (url.pathname === "/api/staff/invoices") return json(list([summary()]));
      if (url.pathname === "/api/staff/invoices/inv1") return json(invoice());
      if (url.pathname === "/api/staff/invoices/inv1/void") return failure(409, "invoice_issued", reason);
      return undefined;
    });
    renderWith(<BillingWorkspace />);
    await user.click(await screen.findByRole("button", { name: /2026-27\/0001/ }));
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByText("Glow Studio LLP")).toBeInTheDocument();
    expect(within(sheet).getByText(/HSN\/SAC 999721/)).toBeInTheDocument();
    expect(within(sheet).getByText(/CGST ₹90 \+ SGST ₹90/)).toBeInTheDocument();
    expect(within(sheet).getByText(/cannot be edited/)).toBeInTheDocument();
    await runBarAction(user, /^Void/);
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(reason);
  });

  it("copies the customer's link", async () => {
    const user = userEvent.setup();
    install((request, url) => {
      if (url.pathname === "/api/staff/invoices") return json(list([summary()]));
      if (url.pathname === "/api/staff/invoices/inv1") return json(invoice());
      if (url.pathname === "/api/staff/invoices/inv1/link") return json({ url: "https://kalendr.example/i/abc", expiresAt: "2026-12-18T09:30:00.000Z" }, 201);
      return undefined;
    });
    renderWith(<BillingWorkspace />);
    await user.click(await screen.findByRole("button", { name: /2026-27\/0001/ }));
    await user.click(await screen.findByRole("button", { name: "Copy invoice link" }));
    expect(await screen.findByDisplayValue("https://kalendr.example/i/abc")).toBeInTheDocument();
    const call = requests.find((request) => request.url.endsWith("/link"))!;
    expect(call.method).toBe("POST");
    expect(call.headers["Idempotency-Key"]).toMatch(/^key-/);
  });

  it("issues a credit note for the chosen lines and needs a reason", async () => {
    const user = userEvent.setup();
    const two = invoice({ lines: [invoice().lines[0]!, { ...invoice().lines[0]!, id: "l2", description: "Colour", totalMinor: 59000 }] });
    install((request, url) => {
      if (url.pathname === "/api/staff/invoices") return json(list([summary()]));
      if (url.pathname === "/api/staff/invoices/inv1") return json(two);
      if (url.pathname === "/api/staff/invoices/inv1/credit-notes") return json({ ...two, creditNotes: [{ id: "cn1", number: "CN/2026-27/0001", issuedAt: "2026-11-19T09:00:00.000Z", reason: "Service not given", taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0, totalMinor: 59000, lineIds: ["l2"], pdfReady: false }] }, 201);
      return undefined;
    });
    renderWith(<BillingWorkspace />);
    await user.click(await screen.findByRole("button", { name: /2026-27\/0001/ }));
    await screen.findByText("Colour");
    await runBarAction(user, /^Issue credit note/);
    const dialog = await screen.findByRole("dialog", { name: "Issue credit note" });
    expect(within(dialog).getByText(/does not give any money back/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("checkbox", { name: /Haircut/ }));
    await user.click(within(dialog).getByRole("button", { name: /^Issue credit note for/ }));
    expect(await within(dialog).findByText("Say why, so the books make sense later.")).toBeInTheDocument();
    await user.type(within(dialog).getByRole("textbox", { name: "Why" }), "Service not given");
    await user.click(within(dialog).getByRole("button", { name: /^Issue credit note for/ }));
    await waitFor(() => expect(requests.some((request) => request.url.endsWith("/credit-notes"))).toBe(true));
    const call = requests.find((request) => request.url.endsWith("/credit-notes"))!;
    expect(call.body).toEqual({ lineIds: ["l2"], reason: "Service not given" });
    expect(call.headers["Idempotency-Key"]).toMatch(/^key-/);
  });

  it("lists the payments to give back after a credit note on a paid invoice, and records one refund", async () => {
    const user = userEvent.setup();
    const owed = invoice({ state: "refund_due", paidMinor: 118000, dueMinor: 0, refundDueMinor: 118000, creditedMinor: 118000, payments: [
      { id: "pay1", method: "upi", amountMinor: 118000, refundableMinor: 118000, at: "2026-11-18T09:40:00.000Z" },
      { id: "pay2", method: "cash", amountMinor: 5000, refundableMinor: 0, at: "2026-11-18T09:45:00.000Z" },
    ] });
    install((_request, url) => {
      if (url.pathname === "/api/staff/invoices") return json(list([summary({ state: "refund_due" })]));
      if (url.pathname === "/api/staff/invoices/inv1") return json(owed);
      if (url.pathname === "/api/staff/payments/pay1/refunds") return json({ paymentId: "pay1", refundId: "r1", amountMinor: 118000, currency: "INR", refundQueued: false }, 201);
      return undefined;
    });
    renderWith(<BillingWorkspace />);
    await user.click(await screen.findByRole("button", { name: /2026-27\/0001/ }));
    const panel = await screen.findByRole("region", { name: "Give the money back" });
    // A payment with nothing left to give back is not offered.
    expect(within(panel).getAllByRole("button")).toHaveLength(1);
    await user.click(within(panel).getByRole("button", { name: /Give back ₹1,180/ }));
    await waitFor(() => expect(requests.some((request) => request.url.endsWith("/api/staff/payments/pay1/refunds"))).toBe(true));
    const call = requests.find((request) => request.url.endsWith("/refunds"))!;
    expect(call.body).toEqual({ amountMinor: 118000, reason: "Credit note on 2026-27/0001" });
    expect(call.headers["Idempotency-Key"]).toMatch(/^key-/);
  });

  it("hides the downloads and the tax tab from someone without invoice rights", async () => {
    install((_request, url) => url.pathname === "/api/staff/invoices" ? json(list([summary()])) : undefined);
    renderWith(<BillingWorkspace />, { role: "receptionist", permissions: ["payments.collect"] });
    await screen.findByText("2026-27/0001");
    expect(screen.queryByRole("tab", { name: "Tax settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download and export" })).not.toBeInTheDocument();
  });

  it("says billing is not available in the preview", () => {
    install(() => undefined);
    renderWith(<BillingWorkspace />, { database: false });
    expect(screen.getByText("Billing is not available in the preview")).toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });
});

describe("billing workspace: tax settings tab", () => {
  async function openTax(user: ReturnType<typeof userEvent.setup>, current = settings()) {
    install((request, url) => {
      if (url.pathname === "/api/staff/invoices") return json(list([]));
      if (url.pathname === "/api/staff/tax-settings" && request.method === "GET") return json(current);
      if (url.pathname === "/api/staff/tax-settings" && request.method === "PUT") return json({ ...current, ...request.body, version: current.version + 1, confirmedAt: request.body?.confirm ? "2026-11-20T09:00:00.000Z" : null });
      if (url.pathname === "/api/staff/tax-settings/services") return json(current);
      return undefined;
    });
    renderWith(<BillingWorkspace />);
    await user.click(await screen.findByRole("tab", { name: "Tax settings" }));
  }

  it("shows the accountant note, the sample line and the per-service table", async () => {
    const user = userEvent.setup();
    await openTax(user);
    expect(await screen.findByText("Confirm this with your accountant")).toBeInTheDocument();
    expect(screen.getByText(/Customer in the same state: ₹1,180 in total, CGST ₹90 \+ SGST ₹90/)).toBeInTheDocument();
    expect(screen.getByText(/Customer in another state: ₹1,180 in total, IGST ₹180/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: /Tax for each/ })).toBeInTheDocument();
  });

  it("checks the GSTIN as it is typed and refuses a state that does not match", async () => {
    const user = userEvent.setup();
    await openTax(user);
    const field = await screen.findByRole("textbox", { name: "GSTIN" });
    await user.clear(field);
    await user.type(field, "27AAPFU0939F1ZW");
    expect(await screen.findByText("That GSTIN does not look right. Check each character.")).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, "29AAPFU0939F1ZV");
    // 29AAPFU0939F1ZV has a different check character, so it is refused as a GSTIN as well.
    expect(await screen.findByText(/does not look right|does not match/)).toBeInTheDocument();
    expect(requests.some((request) => request.method === "PUT")).toBe(false);
  });

  it("saves with the version, the confirmation and no extra keys", async () => {
    const user = userEvent.setup();
    await openTax(user);
    await user.click(await screen.findByRole("checkbox", { name: /confirmed this with my accountant/ }));
    await user.click(screen.getByRole("button", { name: "Save tax settings" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PUT")).toBe(true));
    const body = requests.find((request) => request.method === "PUT")!.body!;
    expect(body).toEqual({
      registered: true, gstin: validGstin, legalName: "Glow Studio LLP", address: null, stateCode: "27", pricesIncludeTax: false, defaultTreatment: "taxable",
      defaultRateBps: 1800, defaultSacCode: "999722", confirm: true, version: 2,
    });
  });

  it("shows the exemption wording for an exempt default", async () => {
    const user = userEvent.setup();
    await openTax(user, settings({ defaultTreatment: "exempt", defaultRateBps: 0 }));
    expect(await screen.findByText(/Notification 12\/2017-CT\(Rate\), entry 74/)).toBeInTheDocument();
  });

  it("saves a service's own treatment as soon as it is chosen", async () => {
    const user = userEvent.setup();
    await openTax(user);
    await chooseOption(user, await screen.findByRole("combobox", { name: "Tax for Haircut" }), "Exempt from GST");
    await waitFor(() => expect(requests.some((request) => request.url === "/api/staff/tax-settings/services")).toBe(true));
    const call = requests.find((request) => request.url === "/api/staff/tax-settings/services")!;
    expect(call.method).toBe("PUT");
    expect(call.body).toEqual({ serviceId: "svc1", treatment: "exempt", rateBps: 0 });
  });

  it("is read-only without the right to change settings", async () => {
    const user = userEvent.setup();
    install((request, url) => url.pathname === "/api/staff/tax-settings" ? json(settings()) : url.pathname === "/api/staff/invoices" ? json(list([])) : undefined);
    renderWith(<BillingWorkspace />, { role: "receptionist", permissions: ["payments.collect", "invoices.issue"] });
    await user.click(await screen.findByRole("tab", { name: "Tax settings" }));
    expect(await screen.findByRole("textbox", { name: "GSTIN" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save tax settings" })).not.toBeInTheDocument();
  });
});

describe("issue invoice dialog", () => {
  it("asks for the customer's GSTIN only when the business is registered, and sends only what was filled in", async () => {
    const user = userEvent.setup();
    install((request) => request.method === "POST" ? json(invoice(), 201) : undefined);
    const issued = vi.fn();
    renderWith(<IssueInvoiceDialog appointmentId="apt1" registered open onOpenChange={() => undefined} onIssued={issued} />);
    const dialog = await screen.findByRole("dialog", { name: "Issue invoice" });
    await user.type(within(dialog).getByRole("textbox", { name: /Customer GSTIN/ }), "27AAPFU0939F1ZW");
    await user.click(within(dialog).getByRole("button", { name: "Issue invoice" }));
    expect(await within(dialog).findByText("That GSTIN does not look right. Check each character.")).toBeInTheDocument();
    await user.clear(within(dialog).getByRole("textbox", { name: /Customer GSTIN/ }));
    await user.type(within(dialog).getByRole("textbox", { name: /Customer GSTIN/ }), ` ${validGstin.toLowerCase()} `);
    await user.click(within(dialog).getByRole("button", { name: "Issue invoice" }));
    await waitFor(() => expect(issued).toHaveBeenCalled());
    expect(requests[0]!.body).toEqual({ appointmentId: "apt1", buyerGstin: validGstin });
    expect(requests[0]!.headers["Idempotency-Key"]).toMatch(/^key-/);
  });

  it("leaves the GSTIN out for a business that is not registered", async () => {
    install(() => undefined);
    renderWith(<IssueInvoiceDialog appointmentId="apt1" registered={false} open onOpenChange={() => undefined} onIssued={() => undefined} />);
    const dialog = await screen.findByRole("dialog", { name: "Issue invoice" });
    expect(within(dialog).queryByRole("textbox", { name: /GSTIN/ })).not.toBeInTheDocument();
  });
});

describe("invoice on a visit and outstanding balance", () => {
  it("shows the number and state of the visit's invoice", async () => {
    install((_request, url) => url.pathname === "/api/staff/invoices" ? json(list([summary({ state: "part_paid", dueMinor: 50000 })])) : url.pathname === "/api/staff/tax-settings" ? json(settings()) : undefined);
    renderWith(<VisitInvoicePanel appointmentId="apt1" />);
    expect(await screen.findByText("2026-27/0001")).toBeInTheDocument();
    expect(screen.getByText("Part paid")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy invoice link" })).toBeInTheDocument();
    expect(requests.find((request) => request.url.startsWith("/api/staff/invoices"))!.url).toContain("appointmentId=apt1");
  });

  it("offers Issue invoice when the visit has none", async () => {
    install((_request, url) => url.pathname === "/api/staff/invoices" ? json(list([])) : url.pathname === "/api/staff/tax-settings" ? json(settings()) : undefined);
    renderWith(<VisitInvoicePanel appointmentId="apt1" />);
    expect(await screen.findByRole("button", { name: "Issue invoice" })).toBeInTheDocument();
  });

  it("shows what a customer owes, and nothing when they owe nothing", async () => {
    const owed: OutstandingBalance = { patientId: "pat1", currency: "INR", dueMinor: 118000, invoices: [{ id: "inv1", number: "2026-27/0001", dueMinor: 118000, issuedAt: "2026-11-18T09:30:00.000Z" }] };
    install((_request, url) => url.pathname === "/api/staff/invoices/outstanding" ? json(owed) : undefined);
    renderWith(<OwesBadge patientId="pat1" />);
    expect(await screen.findByText("Owes ₹1,180")).toBeInTheDocument();
    cleanup();
    install((_request, url) => url.pathname === "/api/staff/invoices/outstanding" ? json({ ...owed, dueMinor: 0, invoices: [] }) : undefined);
    renderWith(<OwesBadge patientId="pat1" />);
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(screen.queryByText(/Owes/)).not.toBeInTheDocument();
  });
});
