/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { financialYearOf, formatInvoiceNumber } from "@/lib/gst";
import { isolatedDatabaseReady } from "@/test/isolated-database";
import { createBooking, createCustomer, createTenant, staffContext, type TenantFixture } from "@/test/privacy-fixture";

vi.mock("server-only", () => ({}));

import { withTenant } from "@/db/client";
import { ApiError } from "@/server/api-error";
import { getDayEnd } from "@/server/day-end";
import { exportInvoicesCsv } from "@/server/invoicing/export";
import { GET as publicInvoiceRoute } from "@/app/api/public/invoices/[token]/route";
import { getInvoice, getOutstanding, issueCreditNote, issueVisitInvoice, listInvoices, voidInvoice } from "@/server/invoicing/invoice";
import { createInvoiceLink, readInvoiceByToken } from "@/server/invoicing/links";
import { drizzleRunner } from "@/server/workflows/runner";
import { drawNumber } from "@/server/invoicing/number";
import { saveServiceTaxRule, saveTaxSettings } from "@/server/invoicing/settings";
import { recordPayment, refundPayment } from "@/server/payments";
import { drainTenantOutbox } from "@/test/outbox-drain";
import { createHandlers } from "@/worker/handlers";
import { localCaptureSink } from "@/worker/delivery";
import { invoiceListQuerySchema, taxSettingsInputSchema } from "@/lib/invoicing-contracts";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? process.env.KALENDR_E2E_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeIsolated = isolatedDatabaseReady(runtimeUrl, ownerUrl, workerUrl) ? describe : describe.skip;

// A real, checksum-valid GSTIN in Telangana (36) and one in Maharashtra (27).
const SELLER_GSTIN = "36AABCU9603R1ZO";
const BUYER_GSTIN_MH = "27AAPFU0939F1ZV";

async function expectApiError(promise: Promise<unknown>, code: string): Promise<ApiError> {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error, `expected ${code}`).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
  return error as ApiError;
}

describeIsolated("invoices, receipts and GST against a real database", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;

  beforeAll(() => {
    owner = postgres(ownerUrl!, { max: 4, prepare: false });
    worker = postgres(workerUrl!, { max: 2, prepare: false });
  });
  afterAll(async () => {
    await owner.end({ timeout: 5 });
    await worker.end({ timeout: 5 });
  });

  async function visit(fixture: TenantFixture, priceMinor: number, patientId?: string): Promise<{ appointmentId: string; patientId: string }> {
    const customer = patientId ? { id: patientId } : await createCustomer(owner, fixture.tenantId);
    const appointmentId = await createBooking(owner, fixture, customer.id, { status: "completed", endsDaysAgo: 0 });
    await owner`update appointments set price_minor = ${priceMinor} where id = ${appointmentId}`;
    return { appointmentId, patientId: customer.id };
  }

  const registered = (overrides: Record<string, unknown> = {}) => ({
    registered: true, gstin: SELLER_GSTIN, legalName: "Glow Salon Pvt Ltd", address: "12 MG Road, Hyderabad", stateCode: "36", pricesIncludeTax: true,
    defaultTreatment: "taxable" as const, defaultRateBps: 1800, defaultSacCode: "999721", confirm: true, ...overrides,
  });

  it("issues a GST invoice whose CGST and SGST add up to the paisa, and an IGST one for another state", async () => {
    const fixture = await createTenant(owner, "gst-salon", "wellness");
    const staff = staffContext(fixture);
    await saveTaxSettings(staff, registered());
    const first = await visit(fixture, 118_000);
    const year = financialYearOf(new Date(), "Asia/Kolkata");
    const invoice = await issueVisitInvoice(staff, { appointmentId: first.appointmentId }, randomUUID());
    expect(invoice.number).toBe(formatInvoiceNumber("INV", year, 1));
    expect(invoice.kind).toBe("tax_invoice");
    expect(invoice).toMatchObject({ taxableMinor: 100_000, cgstMinor: 9_000, sgstMinor: 9_000, igstMinor: 0, totalMinor: 118_000, supply: "intra", sellerGstin: SELLER_GSTIN });
    expect(invoice.cgstMinor + invoice.sgstMinor + invoice.taxableMinor).toBe(invoice.totalMinor);
    expect(invoice.lines[0]).toMatchObject({ sacCode: "999721", rateBps: 1800 });

    const interstate = await visit(fixture, 59_000);
    const igst = await issueVisitInvoice(staff, { appointmentId: interstate.appointmentId, buyerGstin: BUYER_GSTIN_MH, buyerName: "Mehta Traders" }, randomUUID());
    expect(igst.number).toBe(formatInvoiceNumber("INV", year, 2));
    expect(igst).toMatchObject({ cgstMinor: 0, sgstMinor: 0, igstMinor: 9_000, supply: "inter", placeOfSupplyState: "27", buyerGstin: BUYER_GSTIN_MH, buyerName: "Mehta Traders" });

    // The same request twice (a double click) is one invoice; a second invoice for a standing one is refused.
    const key = randomUUID();
    const again = await visit(fixture, 10_000);
    const one = await issueVisitInvoice(staff, { appointmentId: again.appointmentId }, key);
    const two = await issueVisitInvoice(staff, { appointmentId: again.appointmentId }, key);
    expect(two.id).toBe(one.id);
    await expectApiError(issueVisitInvoice(staff, { appointmentId: again.appointmentId }, randomUUID()), "invoice_exists");
    // That refusal drew no number: the next one is the very next in line.
    const next = await visit(fixture, 10_000);
    expect((await issueVisitInvoice(staff, { appointmentId: next.appointmentId }, randomUUID())).number).toBe(formatInvoiceNumber("INV", year, 4));
  });

  it("shows the exemption on a clinic's consultation, and a plain receipt when the business is not registered", async () => {
    const clinic = await createTenant(owner, "gst-clinic", "healthcare");
    const staff = staffContext(clinic);
    await saveTaxSettings(staff, registered({ legalName: "Riverbend Clinic", defaultTreatment: "exempt", defaultRateBps: 0, defaultSacCode: "999312" }));
    const consult = await visit(clinic, 80_000);
    const invoice = await issueVisitInvoice(staff, { appointmentId: consult.appointmentId }, randomUUID());
    expect(invoice.kind).toBe("bill_of_supply");
    expect(invoice.exemptionNote).toContain("12/2017");
    expect(invoice).toMatchObject({ cgstMinor: 0, sgstMinor: 0, igstMinor: 0, totalMinor: 80_000, supply: "none" });

    const shop = await createTenant(owner, "gst-none", "wellness");
    const unregistered = staffContext(shop);
    const sale = await visit(shop, 50_000);
    const receipt = await issueVisitInvoice(unregistered, { appointmentId: sale.appointmentId }, randomUUID());
    expect(receipt).toMatchObject({ kind: "receipt", taxableMinor: 50_000, cgstMinor: 0, totalMinor: 50_000, sellerGstin: null });
    await expectApiError(issueVisitInvoice(unregistered, { appointmentId: (await visit(shop, 1_000)).appointmentId, buyerGstin: BUYER_GSTIN_MH }, randomUUID()), "not_registered");
  });

  it("refuses a registration whose GSTIN does not match, and a service's own rule overrides the default", async () => {
    const fixture = await createTenant(owner, "gst-rules", "wellness");
    const staff = staffContext(fixture);
    expect(taxSettingsInputSchema.safeParse(registered({ gstin: "36AABCU9603R1ZM" })).success).toBe(false);
    expect(taxSettingsInputSchema.safeParse(registered({ stateCode: "27" })).success).toBe(false);
    expect(taxSettingsInputSchema.safeParse(registered({ registered: false, gstin: null })).success).toBe(true);
    expect(taxSettingsInputSchema.safeParse(registered()).success).toBe(true);
    await saveTaxSettings(staff, registered());
    await saveServiceTaxRule(staff, { serviceId: fixture.serviceId, treatment: "taxable", rateBps: 500, sacCode: "9954" });
    const booked = await visit(fixture, 105_000);
    const invoice = await issueVisitInvoice(staff, { appointmentId: booked.appointmentId }, randomUUID());
    expect(invoice.lines[0]).toMatchObject({ rateBps: 500, sacCode: "9954", taxableMinor: 100_000, cgstMinor: 2_500, sgstMinor: 2_500 });
  });

  it("saves tax settings again with a version check, and keeps the owner's confirmation until they confirm again", async () => {
    const fixture = await createTenant(owner, "gst-resave", "wellness");
    const staff = staffContext(fixture);
    const first = await saveTaxSettings(staff, registered());
    expect(first).toMatchObject({ version: 1, isDefault: false });
    expect(first.confirmedAt).not.toBeNull();
    const second = await saveTaxSettings(staff, registered({ confirm: false, address: "New address", version: 1 }));
    expect(second).toMatchObject({ version: 2, address: "New address", confirmedAt: first.confirmedAt });
    await expectApiError(saveTaxSettings(staff, registered({ version: 1 })), "version_conflict");
    const exempt = await saveTaxSettings(staff, registered({ defaultTreatment: "exempt", defaultRateBps: 0, version: 2 }));
    expect(exempt).toMatchObject({ version: 3, defaultTreatment: "exempt", defaultRateBps: 0 });
    await saveServiceTaxRule(staff, { serviceId: fixture.serviceId, treatment: "nil", rateBps: 0, sacCode: null });
    expect((await saveServiceTaxRule(staff, { serviceId: fixture.serviceId, treatment: "taxable", rateBps: 1200, sacCode: "9954" })).services[0]).toMatchObject({ treatment: "taxable", rateBps: 1200 });
    expect((await saveServiceTaxRule(staff, { serviceId: fixture.serviceId, clear: true })).services[0]).toMatchObject({ treatment: null });
  });

  it("gives fifty invoices issued at once fifty consecutive numbers with no gap", async () => {
    const fixture = await createTenant(owner, "gst-race", "wellness");
    const staff = staffContext(fixture);
    await saveTaxSettings(staff, registered());
    const visits = await Promise.all(Array.from({ length: 50 }, () => visit(fixture, 11_800)));
    const issued = await Promise.all(visits.map((one) => issueVisitInvoice(staff, { appointmentId: one.appointmentId }, randomUUID())));
    const year = financialYearOf(new Date(), "Asia/Kolkata");
    expect(issued.map((invoice) => invoice.number).sort()).toEqual(Array.from({ length: 50 }, (_, index) => formatInvoiceNumber("INV", year, index + 1)));
  });

  it("does not burn a number when the transaction rolls back, and starts each financial year at 0001", async () => {
    const fixture = await createTenant(owner, "gst-counter", "wellness");
    const when = new Date("2026-11-01T10:00:00+05:30");
    await expect(withTenant(fixture.tenantId, async (transaction) => {
      await drawNumber(drizzleRunner(transaction), fixture.tenantId, "INV", when, "Asia/Kolkata");
      throw new Error("something failed after the number was drawn");
    })).rejects.toThrow("after the number");
    const afterRollback = await withTenant(fixture.tenantId, (transaction) => drawNumber(drizzleRunner(transaction), fixture.tenantId, "INV", when, "Asia/Kolkata"));
    expect(afterRollback.number).toBe("2026-27/0001");
    // 11:59pm in India on 31 March is still the old year; one minute later is the new one.
    const lastMinute = await withTenant(fixture.tenantId, (transaction) => drawNumber(drizzleRunner(transaction), fixture.tenantId, "INV", new Date("2027-03-31T23:59:00+05:30"), "Asia/Kolkata"));
    const firstMinute = await withTenant(fixture.tenantId, (transaction) => drawNumber(drizzleRunner(transaction), fixture.tenantId, "INV", new Date("2027-04-01T00:00:00+05:30"), "Asia/Kolkata"));
    expect(lastMinute.number).toBe("2026-27/0002");
    expect(firstMinute.number).toBe("2027-28/0001");
    const note = await withTenant(fixture.tenantId, (transaction) => drawNumber(drizzleRunner(transaction), fixture.tenantId, "CN", when, "Asia/Kolkata"));
    expect(note.number).toBe("CN/2026-27/0001");
  });

  it("refuses to void an issued invoice, takes it back with a credit note, and cannot be edited underneath", async () => {
    const fixture = await createTenant(owner, "gst-credit", "wellness");
    const staff = staffContext(fixture);
    await saveTaxSettings(staff, registered());
    const booked = await visit(fixture, 118_000);
    const invoice = await issueVisitInvoice(staff, { appointmentId: booked.appointmentId }, randomUUID());
    await recordPayment(staff, booked.appointmentId, { amountMinor: 118_000, method: "upi" }, randomUUID());

    const refusal = await expectApiError(voidInvoice(staff, invoice.id), "invoice_issued");
    expect(refusal.message).toMatch(/credit note/i);
    await expect(owner`update invoices set total_minor = 1 where id = ${invoice.id}`).rejects.toMatchObject({ code: "23001" });
    await expect(owner`delete from invoice_lines where invoice_id = ${invoice.id}`).rejects.toMatchObject({ code: "23001" });

    const credited = await issueCreditNote(staff, invoice.id, { reason: "Booked in error" }, randomUUID());
    expect(credited.creditNotes[0]!.number).toMatch(/^CN\/\d{4}-\d{2}\/0001$/);
    expect(credited.creditNotes[0]).toMatchObject({ totalMinor: 118_000, cgstMinor: 9_000, sgstMinor: 9_000 });
    // Paid in full, fully credited, nothing newer: the money has to go back, and the invoice says so.
    expect(credited).toMatchObject({ creditedMinor: 118_000, state: "refund_due", refundDueMinor: 118_000, dueMinor: 0 });
    await expectApiError(issueCreditNote(staff, invoice.id, { reason: "Again" }, randomUUID()), "already_credited");

    // The audit trail names ids and amounts, never the free-text reason or the customer's name.
    const audit = await owner<{ metadata: unknown }[]>`select metadata from audit_events where tenant_id = ${fixture.tenantId} and action in ('invoice.issued', 'credit_note.issued')`;
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain("Booked in error");
    const customer = await owner<{ first_name: string }[]>`select first_name from patients where id = ${booked.patientId}`;
    expect(JSON.stringify(audit)).not.toContain(customer[0]!.first_name);

    // After the refund the position settles, and a corrected invoice can be issued for the same visit.
    const [payment] = await owner<{ id: string }[]>`select id from payments where appointment_id = ${booked.appointmentId}`;
    await refundPayment(staff, payment!.id, { amountMinor: 118_000, reason: "Credit note" }, randomUUID());
    expect((await getInvoice(staff, invoice.id)).state).toBe("credited");
    const replacement = await issueVisitInvoice(staff, { appointmentId: booked.appointmentId }, randomUUID());
    expect(replacement.number).toMatch(/\/0002$/);
  });

  it("keeps header and lines honest in the database itself", async () => {
    const fixture = await createTenant(owner, "gst-sums", "wellness");
    const settings = { currency: "INR" };
    const number = "2026-27/0001";
    const patient = await createCustomer(owner, fixture.tenantId);
    await expect(owner.begin(async (transaction) => {
      const [invoice] = await transaction<{ id: string }[]>`
        insert into invoices (tenant_id, financial_year, series, sequence, number, patient_id, location_id, kind, currency, prices_include_tax, taxable_minor, cgst_minor, sgst_minor, igst_minor, total_minor,
          supply, seller_legal_name, buyer_name) values (${fixture.tenantId}, '2026-27', 'INV', 1, ${number}, ${patient.id}, ${fixture.locationId}, 'receipt', ${settings.currency}, true, 1000, 0, 0, 0, 1000, 'none', 'Seller', 'Buyer')
        returning id`;
      await transaction`insert into invoice_lines (tenant_id, invoice_id, position, description, quantity, unit_price_minor, treatment, taxable_minor, total_minor)
        values (${fixture.tenantId}, ${invoice!.id}, 1, 'Short', 1, 900, 'nil', 900, 900)`;
    })).rejects.toMatchObject({ code: "23514" });
    expect(Number((await owner`select count(*) from invoices where tenant_id = ${fixture.tenantId}`)[0]!.count)).toBe(0);
  });

  it("works out paid, part paid and outstanding from the payments, and day-end equals payments by method", async () => {
    const fixture = await createTenant(owner, "gst-pay", "wellness");
    const staff = staffContext(fixture);
    await saveTaxSettings(staff, registered());
    const customer = await createCustomer(owner, fixture.tenantId);
    const booked = await visit(fixture, 100_000, customer.id);
    const invoice = await issueVisitInvoice(staff, { appointmentId: booked.appointmentId }, randomUUID());
    expect(invoice).toMatchObject({ state: "unpaid", dueMinor: 100_000 });
    const before = await getDayEnd(staff, { locationId: fixture.locationId });

    // Split across methods with part payment: cash and UPI at the desk.
    await recordPayment(staff, booked.appointmentId, { amountMinor: 30_000, method: "cash" }, randomUUID());
    await recordPayment(staff, booked.appointmentId, { amountMinor: 20_000, method: "upi" }, randomUUID());
    expect(await getInvoice(staff, invoice.id)).toMatchObject({ state: "part_paid", paidMinor: 50_000, dueMinor: 50_000 });
    expect(await getOutstanding(staff, customer.id)).toMatchObject({ dueMinor: 50_000, invoices: [{ id: invoice.id, dueMinor: 50_000 }] });
    expect((await listInvoices(staff, invoiceListQuerySchema.parse({ state: "due" }))).invoices.map((row) => row.id)).toContain(invoice.id);

    // A package-style sale with no visit lands in the same ledger and the same day-end.
    await owner`insert into payments (tenant_id, patient_id, location_id, amount_minor, currency, method) values (${fixture.tenantId}, ${customer.id}, ${fixture.locationId}, 7_000, 'INR', 'card')`;
    await recordPayment(staff, booked.appointmentId, { amountMinor: 50_000, method: "bank" }, randomUUID());
    expect(await getInvoice(staff, invoice.id)).toMatchObject({ state: "paid", dueMinor: 0 });
    expect((await getOutstanding(staff, customer.id)).dueMinor).toBe(0);

    const after = await getDayEnd(staff, { locationId: fixture.locationId });
    const delta = (method: "cash" | "upi" | "card" | "bank") => after.summary.money.byMethod[method] - before.summary.money.byMethod[method];
    expect([delta("cash"), delta("upi"), delta("card"), delta("bank")]).toEqual([30_000, 20_000, 7_000, 50_000]);
    const paidRows = await owner<{ method: string; total: string }[]>`select method::text, sum(amount_minor) as total from payments where tenant_id = ${fixture.tenantId} group by 1`;
    const byMethod = Object.fromEntries(paidRows.map((row) => [row.method, Number(row.total)]));
    expect(after.summary.money.takenMinor).toBe(Object.values(byMethod).reduce((sum, value) => sum + value, 0));
    expect(after.summary.money.byMethod).toMatchObject({ cash: byMethod.cash, upi: byMethod.upi, card: byMethod.card, bank: byMethod.bank });
  });

  it("renders the PDF in the worker and serves it from a tokenised link", async () => {
    const fixture = await createTenant(owner, "gst-pdf", "wellness");
    const staff = staffContext(fixture);
    await saveTaxSettings(staff, registered());
    const booked = await visit(fixture, 118_000);
    const invoice = await issueVisitInvoice(staff, { appointmentId: booked.appointmentId }, randomUUID());
    expect(invoice.pdfReady).toBe(false);
    const link = await createInvoiceLink(staff, invoice.id, null, "https://app.example.test");
    const token = link.url.split("/").pop()!;
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(await readInvoiceByToken(token)).toEqual({ state: "preparing" });
    const waiting = await publicInvoiceRoute(new Request("https://app.example.test/x", { headers: { "x-forwarded-for": "192.0.2.78" } }), { params: Promise.resolve({ token }) });
    expect(waiting.status).toBe(202);
    expect(await waiting.text()).toContain("being prepared");
    expect(await readInvoiceByToken("not-a-real-token-not-a-real-token-not-a-real-token")).toEqual({ state: "unknown" });
    // Only a hash of the token is stored.
    const stored = await owner<{ token_hash: string }[]>`select token_hash from invoice_links where tenant_id = ${fixture.tenantId}`;
    expect(stored[0]!.token_hash).not.toContain(token);

    const handlers = createHandlers({ sink: localCaptureSink, now: () => new Date(), origin: "https://app.example.test", available: { whatsapp: false, sms: false } });
    await drainTenantOutbox(worker, fixture.tenantId, handlers);
    const ready = await readInvoiceByToken(token);
    expect(ready.state).toBe("ready");
    if (ready.state === "ready") {
      expect(ready.bytes.subarray(0, 5).toString()).toBe("%PDF-");
      expect(ready.filename).toMatch(/\.pdf$/);
    }
    expect((await getInvoice(staff, invoice.id)).pdfReady).toBe(true);
    // The public route a customer's phone opens: the PDF inline, never cached, no referrer, and a dead link looks like any other.
    const call = (value: string) => publicInvoiceRoute(new Request(`https://app.example.test/api/public/invoices/${value}`, { headers: { "x-forwarded-for": "192.0.2.77" } }), { params: Promise.resolve({ token: value }) });
    const response = await call(token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toMatch(/^inline; filename=".*\.pdf"$/);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await call("x".repeat(43))).status).toBe(404);
  });

  it("exports a month as CSV with credit notes negative, formulas defanged and a GST summary by rate", async () => {
    const fixture = await createTenant(owner, "gst-csv", "wellness");
    const staff = staffContext(fixture);
    await saveTaxSettings(staff, registered());
    const customer = await createCustomer(owner, fixture.tenantId, { firstName: "=HYPERLINK(\"x\")", lastName: "Rao" });
    const first = await visit(fixture, 118_000, customer.id);
    const invoice = await issueVisitInvoice(staff, { appointmentId: first.appointmentId }, randomUUID());
    await issueCreditNote(staff, invoice.id, { reason: "Test" }, randomUUID());
    const second = await visit(fixture, 59_000);
    await issueVisitInvoice(staff, { appointmentId: second.appointmentId }, randomUUID());
    const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
    const documents = await exportInvoicesCsv(staff, month, "documents");
    expect(documents.body).toContain("Credit note");
    expect(documents.body).toContain(",-1180.00,");
    expect(documents.body).not.toContain("'-1180.00");
    expect(documents.body).toContain("'=HYPERLINK");
    expect(documents.body).not.toMatch(/(^|,)=HYPERLINK/m);
    const summary = await exportInvoicesCsv(staff, month, "gst-summary");
    // 1180 invoiced and credited back leaves only the 590 invoice: 500 taxable, 45 + 45 tax.
    expect(summary.body).toContain("taxable,18.00,3,500.00,45.00,45.00,0.00,590.00");
  });

  it("keeps one business's invoices from another, and refuses a role without permission", async () => {
    const mine = await createTenant(owner, "gst-mine", "wellness");
    const theirs = await createTenant(owner, "gst-theirs", "wellness");
    const staff = staffContext(mine);
    await saveTaxSettings(staff, registered());
    const booked = await visit(mine, 11_800);
    const invoice = await issueVisitInvoice(staff, { appointmentId: booked.appointmentId }, randomUUID());
    await expectApiError(getInvoice(staffContext(theirs), invoice.id), "invoice_not_found");
    await expectApiError(issueCreditNote(staffContext(theirs), invoice.id, { reason: "Nope" }, randomUUID()), "invoice_not_found");
    expect((await listInvoices(staffContext(theirs), invoiceListQuerySchema.parse({}))).invoices).toHaveLength(0);
    const runtime = postgres(runtimeUrl!, { max: 1, prepare: false });
    try {
      const rows = await runtime.begin(async (transaction) => {
        await transaction`select set_config('app.tenant_id', ${theirs.tenantId}, true)`;
        return transaction`select id from invoices where id = ${invoice.id}`;
      });
      expect(rows).toHaveLength(0);
    } finally {
      await runtime.end({ timeout: 5 });
    }
    await expect(issueVisitInvoice(staffContext(mine, { permissions: [] }), { appointmentId: booked.appointmentId }, randomUUID())).rejects.toMatchObject({ status: 403 });
  });
});
