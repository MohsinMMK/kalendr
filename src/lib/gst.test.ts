import { describe, expect, it } from "vitest";

import {
  CREDIT_NOTE_SERIES, DEFAULT_SERIES, defaultTaxFor, financialYearBounds, financialYearOf, formatInvoiceNumber, GstInputError, isValidGstin,
  placeOfSupply, stateTaxLabel, sumTax, taxInvoice, taxLine, type TaxLineInput,
} from "./gst";

const line = (overrides: Partial<TaxLineInput> = {}): TaxLineInput => ({
  description: "Haircut", sacCode: "999721", quantity: 1, unitPriceMinor: 100_000, discountMinor: 0, treatment: "taxable", rateBps: 1800, ...overrides,
});

describe("GSTIN", () => {
  it("accepts a real shape with a matching check character and refuses a changed one", () => {
    expect(isValidGstin("27AAPFU0939F1ZV")).toBe(true);
    expect(isValidGstin(" 27aapfu0939f1zv ")).toBe(true);
    expect(isValidGstin("27AAPFU0939F1ZW")).toBe(false);
    expect(isValidGstin("99AAPFU0939F1ZV")).toBe(false);
    expect(isValidGstin("27AAPFU0939F1")).toBe(false);
  });
});

describe("place of supply", () => {
  it("uses the buyer's GSTIN state first, then the chosen state, then the business's own", () => {
    expect(placeOfSupply({ supplierStateCode: "36" })).toEqual({ stateCode: "36", supply: "intra" });
    expect(placeOfSupply({ supplierStateCode: "36", buyerStateCode: "29" })).toEqual({ stateCode: "29", supply: "inter" });
    expect(placeOfSupply({ supplierStateCode: "27", buyerGstin: "27AAPFU0939F1ZV", buyerStateCode: "29" })).toEqual({ stateCode: "27", supply: "intra" });
  });
  it("names the state half UTGST in a union territory without a legislature", () => {
    expect(stateTaxLabel("04")).toBe("UTGST");
    expect(stateTaxLabel("36")).toBe("SGST");
  });
});

describe("tax on a line", () => {
  it("adds CGST and SGST to a price entered before tax", () => {
    const taxed = taxLine(line(), { registered: true, pricesIncludeTax: false, supply: "intra" });
    expect(taxed).toMatchObject({ taxableMinor: 100_000, cgstMinor: 9_000, sgstMinor: 9_000, igstMinor: 0, totalMinor: 118_000 });
  });
  it("uses IGST for another state", () => {
    const taxed = taxLine(line(), { registered: true, pricesIncludeTax: false, supply: "inter" });
    expect(taxed).toMatchObject({ cgstMinor: 0, sgstMinor: 0, igstMinor: 18_000, totalMinor: 118_000 });
  });
  it("carves tax out of a price that includes it and never changes what the customer pays", () => {
    const taxed = taxLine(line({ unitPriceMinor: 118_000 }), { registered: true, pricesIncludeTax: true, supply: "intra" });
    expect(taxed).toMatchObject({ taxableMinor: 100_000, cgstMinor: 9_000, sgstMinor: 9_000, totalMinor: 118_000 });
  });
  it("gives an odd paisa to the state half so the two halves add to the tax exactly", () => {
    const taxed = taxLine(line({ unitPriceMinor: 5 }), { registered: true, pricesIncludeTax: false, supply: "intra" });
    expect(taxed.cgstMinor + taxed.sgstMinor).toBe(1);
    expect(taxed).toMatchObject({ cgstMinor: 0, sgstMinor: 1 });
  });
  it("charges nothing for an exempt or nil-rated service, or when the business is not registered", () => {
    expect(taxLine(line({ treatment: "exempt", rateBps: 0 }), { registered: true, pricesIncludeTax: false, supply: "intra" })).toMatchObject({ totalMinor: 100_000, cgstMinor: 0, appliedTreatment: "exempt" });
    const unregistered = taxLine(line(), { registered: false, pricesIncludeTax: false, supply: "intra" });
    expect(unregistered).toMatchObject({ totalMinor: 100_000, cgstMinor: 0, sgstMinor: 0, igstMinor: 0, appliedRateBps: 0 });
  });
  it("takes the discount off before tax", () => {
    const taxed = taxLine(line({ discountMinor: 20_000 }), { registered: true, pricesIncludeTax: false, supply: "intra" });
    expect(taxed).toMatchObject({ netEnteredMinor: 80_000, taxableMinor: 80_000, cgstMinor: 7_200, sgstMinor: 7_200, totalMinor: 94_400 });
  });
  it("refuses amounts that make no sense", () => {
    const context = { registered: true, pricesIncludeTax: false, supply: "intra" } as const;
    expect(() => taxLine(line({ quantity: 0 }), context)).toThrow(GstInputError);
    expect(() => taxLine(line({ discountMinor: 100_001 }), context)).toThrow(GstInputError);
    expect(() => taxLine(line({ unitPriceMinor: 1.5 }), context)).toThrow(GstInputError);
    expect(() => taxLine(line({ rateBps: 5000 }), context)).toThrow(GstInputError);
  });

  it("always adds up to the paisa, for every price and rate, inclusive or exclusive, in or out of state", () => {
    const rates = [0, 50, 500, 1200, 1800, 2800];
    let checked = 0;
    for (let price = 0; price <= 6_000; price += 7) {
      for (const rateBps of rates) {
        for (const pricesIncludeTax of [true, false]) {
          for (const supply of ["intra", "inter"] as const) {
            const taxed = taxLine(line({ unitPriceMinor: price, rateBps }), { registered: true, pricesIncludeTax, supply });
            const tax = taxed.cgstMinor + taxed.sgstMinor + taxed.igstMinor;
            expect(taxed.totalMinor).toBe(taxed.taxableMinor + tax);
            if (pricesIncludeTax) expect(taxed.totalMinor).toBe(price);
            else expect(taxed.taxableMinor).toBe(price);
            if (supply === "intra") expect(taxed.sgstMinor - taxed.cgstMinor).toBeLessThanOrEqual(1);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });
});

describe("tax on an invoice", () => {
  it("sums printed lines, so the totals are exactly what the lines show", () => {
    const invoice = taxInvoice(
      [line({ unitPriceMinor: 33_333 }), line({ description: "Colour", unitPriceMinor: 12_345, quantity: 3 }), line({ description: "Consult", treatment: "exempt", rateBps: 0, unitPriceMinor: 50_000 })],
      { registered: true, pricesIncludeTax: true, supply: "intra" },
    );
    expect(invoice.totals).toEqual(sumTax(invoice.lines));
    expect(invoice.totals.totalMinor).toBe(33_333 + 12_345 * 3 + 50_000);
    expect(invoice.totals.cgstMinor + invoice.totals.sgstMinor).toBeGreaterThan(0);
    expect(invoice.kind).toBe("tax_invoice");
  });
  it("is a receipt when the business is not registered and a bill of supply when nothing is taxable", () => {
    expect(taxInvoice([line()], { registered: false, pricesIncludeTax: false, supply: "intra" }).kind).toBe("receipt");
    expect(taxInvoice([line({ treatment: "exempt", rateBps: 0 })], { registered: true, pricesIncludeTax: false, supply: "intra" }).kind).toBe("bill_of_supply");
  });
});

describe("defaults", () => {
  it("offers healthcare as exempt with the notification, and other work at 18%", () => {
    expect(defaultTaxFor("healthcare")).toMatchObject({ treatment: "exempt", rateBps: 0 });
    expect(defaultTaxFor("healthcare").exemptionNote).toContain("12/2017");
    expect(defaultTaxFor("wellness")).toMatchObject({ treatment: "taxable", rateBps: 1800 });
  });
});

describe("financial year", () => {
  it("runs April to March in the business's own time zone", () => {
    expect(financialYearOf(new Date("2026-04-01T00:00:00+05:30"), "Asia/Kolkata")).toBe("2026-27");
    expect(financialYearOf(new Date("2026-03-31T23:59:59+05:30"), "Asia/Kolkata")).toBe("2025-26");
    // 18:30 UTC on 31 March is already 1 April in India, but still 31 March in New York.
    expect(financialYearOf(new Date("2026-03-31T18:30:00Z"), "Asia/Kolkata")).toBe("2026-27");
    expect(financialYearOf(new Date("2026-03-31T18:30:00Z"), "America/New_York")).toBe("2025-26");
    expect(financialYearOf(new Date("2099-12-31T12:00:00Z"), "Asia/Kolkata")).toBe("2099-00");
    expect(financialYearBounds("2026-27")).toEqual({ from: "2026-04-01", to: "2027-03-31" });
  });
  it("formats numbers inside GST's sixteen characters", () => {
    expect(formatInvoiceNumber(DEFAULT_SERIES, "2026-27", 1)).toBe("2026-27/0001");
    expect(formatInvoiceNumber(CREDIT_NOTE_SERIES, "2026-27", 12)).toBe("CN/2026-27/0012");
    expect(formatInvoiceNumber("CN", "2026-27", 123456).length).toBeLessThanOrEqual(18);
    expect(formatInvoiceNumber("CN", "2026-27", 9999).length).toBeLessThanOrEqual(16);
  });
});
