/** @vitest-environment node */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { csvCell } from "./export";
import { formatPdfMoney, renderInvoicePdf, type PdfDocumentInput } from "./pdf";

const base: PdfDocumentInput = {
  documentKind: "tax_invoice", number: "2026-27/0001", issuedOn: "20 Nov 2026", currency: "INR",
  seller: { legalName: "Glow Salon Pvt Ltd", address: "12 MG Road, Hyderabad", gstin: "36AABCU9603R1ZO", stateCode: "36" },
  buyer: { name: "Asha Rao", gstin: null, stateCode: "36" }, placeOfSupplyState: "36", supply: "intra",
  lines: [{ position: 1, description: "Haircut and style", sacCode: "999721", quantity: 1, unitPriceMinor: 118_000, discountMinor: 0, rateBps: 1800, taxableMinor: 100_000, cgstMinor: 9_000, sgstMinor: 9_000, igstMinor: 0, totalMinor: 118_000 }],
  totals: { taxableMinor: 100_000, cgstMinor: 9_000, sgstMinor: 9_000, igstMinor: 0, totalMinor: 118_000 }, exemptionNote: null,
};

describe("invoice PDF", () => {
  it("renders a PDF for an invoice, an exempt bill of supply, a receipt and a credit note", async () => {
    const documents: PdfDocumentInput[] = [
      base,
      { ...base, documentKind: "bill_of_supply", supply: "none", exemptionNote: "Exempt: healthcare services by a clinical establishment (Notification 12/2017-CT(Rate), entry 74).", totals: { taxableMinor: 118_000, cgstMinor: 0, sgstMinor: 0, igstMinor: 0, totalMinor: 118_000 } },
      { ...base, documentKind: "receipt", supply: "none", seller: { ...base.seller, gstin: null }, totals: { taxableMinor: 118_000, cgstMinor: 0, sgstMinor: 0, igstMinor: 0, totalMinor: 118_000 } },
      { ...base, documentKind: "credit_note", number: "CN/2026-27/0001", againstNumber: "2026-27/0001", reason: "Booked in error" },
    ];
    for (const document of documents) {
      const bytes = await renderInvoicePdf(document);
      expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
      expect(bytes.length).toBeGreaterThan(2_000);
    }
  });

  it("writes money with the rupee sign, Indian grouping and two decimals", () => {
    expect(formatPdfMoney(118_000, "INR")).toBe("₹1,180.00");
    expect(formatPdfMoney(123_456_789, "INR")).toBe("₹12,34,567.89");
    expect(formatPdfMoney(-9_000, "INR")).toBe("-₹90.00");
    expect(formatPdfMoney(1_500, "USD")).toBe("USD 15.00");
  });
});

describe("CSV cells", () => {
  it("quotes what needs it and writes anything that could run as a formula as text", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(12)).toBe("12");
    expect(csvCell("Rao, Asha")).toBe('"Rao, Asha"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("+91 98000")).toBe("'+91 98000");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("-5")).toBe("'-5");
    // An amount we formatted ourselves stays a number, so credit notes subtract in the accountant's sheet.
    expect(csvCell({ amount: "-1180.00" })).toBe("-1180.00");
  });
});
